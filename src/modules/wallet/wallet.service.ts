import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createPublicClient, formatEther, hashTypedData, http } from 'viem';
import {
  base,
  baseSepolia,
  mainnet,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import type { SignDto } from './dto/sign.dto';
import type { WithdrawDto } from './dto/withdraw.dto';

const CHAIN_MAP: Record<number, Parameters<typeof createPublicClient>[0]['chain']> = {
  84532: baseSepolia,
  8453: base,
  1: mainnet,
  11155111: sepolia,
  137: polygon,
  80002: polygonAmoy,
};

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** Well-known USDC contract addresses by chainId. */
const USDC_ADDRESSES: Record<number, string> = {
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum Mainnet
  11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Ethereum Sepolia
  137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon Mainnet (Polymarket)
  80002: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', // Polygon Amoy (Polymarket Testnet)
};

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
  ) {}

  /** Return the user's wallet address and supported deposit tokens. */
  async getDepositInfo(userId: string) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    return {
      walletAddress: wallet.walletAddress,
      chainId: Number(wallet.chainId),
      status: wallet.status,
      supportedTokens: ['USDC', 'ETH'],
    };
  }

  /** Sign data with the user's backend wallet (no transaction broadcast). */
  async sign(userId: string, params: SignDto) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    let data: string;
    switch (params.type) {
      case 'message':
        // Convert plain-text message to hex-encoded bytes
        data = '0x' + Buffer.from(params.message!, 'utf-8').toString('hex');
        break;
      case 'typed_data': {
        // Compute EIP-712 struct hash → raw ECDSA sign
        const { domain, types, primaryType, message } = params.typedData!;
        data = hashTypedData({ domain, types, primaryType, message } as any);
        break;
      }
      case 'hash':
        data = params.hash!;
        break;
    }

    const signature = await this.openfort.signData(wallet.openfortAccountId, data);

    return {
      signature,
      walletAddress: wallet.walletAddress,
      type: params.type,
    };
  }

  /** Return ETH and USDC balances for the user's wallet. */
  async getBalances(userId: string) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const chainId = Number(wallet.chainId);
    const walletAddress = wallet.walletAddress as `0x${string}`;
    const usdcAddress = (USDC_ADDRESSES[chainId] ?? USDC_ADDRESSES[84532]) as `0x${string}`;
    const chain = CHAIN_MAP[chainId];

    const publicClient = createPublicClient({ chain, transport: http() });

    type BalanceEntry =
      | { token: string; raw: string; formatted: string; contractAddress?: string }
      | { token: string; raw: null; formatted: null; error: string; contractAddress?: string };

    const balances: BalanceEntry[] = [];

    // ETH balance
    try {
      const raw = await publicClient.getBalance({ address: walletAddress });
      balances.push({ token: 'ETH', raw: raw.toString(), formatted: formatEther(raw) });
    } catch {
      balances.push({ token: 'ETH', raw: null, formatted: null, error: 'fetch failed' });
    }

    // USDC balance
    try {
      const raw = await publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [walletAddress],
      });
      balances.push({
        token: 'USDC',
        raw: raw.toString(),
        formatted: (Number(raw) / 1e6).toFixed(2),
        contractAddress: usdcAddress,
      });
    } catch {
      balances.push({
        token: 'USDC',
        raw: null,
        formatted: null,
        error: 'fetch failed',
        contractAddress: usdcAddress,
      });
    }

    return { walletAddress, chainId, balances };
  }

  /** Create a withdrawal transaction intent. */
  async withdraw(userId: string, params: WithdrawDto) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    // Guard: wallet must be active before any outbound transfer
    if (wallet.status !== 'active') {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    // Guard: prevent self-withdrawal (sending to own wallet address)
    if (params.to.toLowerCase() === wallet.walletAddress.toLowerCase()) {
      throw new BadRequestException('Cannot withdraw to your own wallet address');
    }

    const chainId = Number(wallet.chainId);
    const usdcAddress = (USDC_ADDRESSES[chainId] ?? USDC_ADDRESSES[84532]) as `0x${string}`;
    const walletAddress = wallet.walletAddress as `0x${string}`;

    // Guard: idempotency — reject duplicate pending withdrawal with same key
    if (params.idempotencyKey) {
      const duplicate = await this.prisma.transaction.findFirst({
        where: {
          userId,
          status: 'pending',
          details: { path: ['idempotencyKey'], equals: params.idempotencyKey },
        },
      });
      if (duplicate) {
        throw new ConflictException(
          `A pending withdrawal with idempotencyKey "${params.idempotencyKey}" already exists (transactionId: ${duplicate.id})`,
        );
      }
    }

    // Guard: verify on-chain USDC balance is sufficient before submitting intent
    const chain = CHAIN_MAP[chainId];
    if (chain) {
      const publicClient = createPublicClient({ chain, transport: http() });
      let usdcBalance: bigint;
      try {
        usdcBalance = await publicClient.readContract({
          address: usdcAddress,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [walletAddress],
        });
      } catch {
        throw new BadRequestException('Unable to verify USDC balance — please retry');
      }

      const requestedAmount = BigInt(params.amount);
      if (usdcBalance < requestedAmount) {
        throw new BadRequestException(
          `Insufficient USDC balance: have ${usdcBalance.toString()} units, requested ${params.amount} units`,
        );
      }
    }

    const txIntent = await this.openfort.createTransactionIntent({
      chainId,
      accountId: wallet.openfortAccountId,
      interactions: [
        {
          contract: usdcAddress,
          functionName: 'transfer',
          functionArgs: [params.to, params.amount],
        },
      ],
    });

    const tx = await this.prisma.transaction.create({
      data: {
        userId,
        intentId: txIntent.id,
        status: 'pending',
        chainId: BigInt(chainId),
        walletAddress: wallet.walletAddress,
        details: {
          type: 'withdraw',
          to: params.to,
          amount: params.amount,
          token: params.token,
          contractAddress: usdcAddress,
          ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        },
      },
    });

    return {
      transactionId: tx.id,
      intentId: txIntent.id,
      status: 'pending',
    };
  }
}

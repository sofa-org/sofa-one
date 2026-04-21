import { Injectable, NotFoundException } from '@nestjs/common';
import { hashTypedData } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import type { SignDto } from './dto/sign.dto';

/** Well-known USDC contract addresses by chainId. */
const USDC_ADDRESSES: Record<number, string> = {
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum Mainnet
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

  /** Create a withdrawal transaction intent. */
  async withdraw(userId: string, params: { to: string; amount: string; token: string }) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const chainId = Number(wallet.chainId);
    const usdcAddress = USDC_ADDRESSES[chainId] || USDC_ADDRESSES[84532];

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

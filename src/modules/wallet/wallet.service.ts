import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createPublicClient, formatEther, hashMessage, hashTypedData, http } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { assertAllowedApiKeyChain, getSupportedChain } from '../../common/chains/supported-chains';
import { hashRequest } from '../../common/utils/request-hash';
import type { SignDto, SignMessage } from './dto/sign.dto';
import type { WithdrawDto } from './dto/withdraw.dto';

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

type ApiKeySigningContext = {
  id?: string;
  keyPrefix?: string;
  name?: string | null;
  allowedChains: number[];
};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
  ) {}

  /** Return the user's wallet address and supported deposit tokens. */
  async getDepositInfo(userId: string, chainId: number) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const supportedChain = getSupportedChain(chainId);

    return {
      walletAddress: wallet.walletAddress,
      chainId,
      chainName: supportedChain.name,
      status: wallet.status,
      supportedTokens: ['USDC', supportedChain.nativeCurrencySymbol],
    };
  }

  /** Sign data with the user's backend wallet (no transaction broadcast). */
  async sign(userId: string, params: SignDto, apiKeyRecord?: ApiKeySigningContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required for signing');
    }

    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const chainId = this.resolveSigningChainId(params);
    if (chainId !== undefined) {
      getSupportedChain(chainId);
      assertAllowedApiKeyChain(apiKeyRecord, chainId);
    }

    let data: string;
    switch (params.type) {
      case 'message':
        // Compute EIP-191 personal message hash → raw ECDSA sign
        data = this.hashSignMessage(params.message!);
        break;
      case 'typed_data': {
        // Compute EIP-712 struct hash → raw ECDSA sign
        const { domain, types, primaryType, message } = params.typedData!;
        data = hashTypedData({ domain, types, primaryType, message } as any);
        break;
      }
    }

    const signingRequest = await this.prisma.signingRequest.create({
      data: {
        userId,
        apiKeyId: apiKeyRecord?.id,
        authMethod: 'api_key',
        apiKeyPrefix: apiKeyRecord?.keyPrefix,
        apiKeyName: apiKeyRecord?.name,
        type: params.type,
        chainId: chainId === undefined ? undefined : BigInt(chainId),
        walletAddress: wallet.walletAddress,
        requestHash: hashRequest({ type: params.type, chainId, digest: data }),
        digest: data,
        status: 'submitting',
      },
    });

    let signature: string;
    try {
      signature = await this.openfort.signData(wallet.openfortAccountId, data);
    } catch (err) {
      await this.updateSigningRequestStatus(signingRequest.id, 'failed');
      throw err;
    }

    await this.updateSigningRequestStatus(signingRequest.id, 'signed');

    return {
      signature,
      walletAddress: wallet.walletAddress,
      type: params.type,
    };
  }

  private async updateSigningRequestStatus(id: string, status: 'signed' | 'failed'): Promise<void> {
    try {
      await this.prisma.signingRequest.update({
        where: { id },
        data: { status, completedAt: new Date() },
      });
    } catch (err) {
      this.logger.error(
        `Failed to mark signing request ${id} as ${status}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  /** Return native token and USDC balances for the user's wallet on the requested chain. */
  async getBalances(userId: string, chainId: number) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const walletAddress = wallet.walletAddress as `0x${string}`;

    const supportedChain = getSupportedChain(chainId);
    const publicClient = createPublicClient({ chain: supportedChain.chain, transport: http() });
    const usdcAddress = supportedChain.usdcAddress;

    type BalanceEntry =
      | { token: string; raw: string; formatted: string; contractAddress?: string }
      | { token: string; raw: null; formatted: null; error: string; contractAddress?: string };

    const [ethResult, usdcResult] = await Promise.all([
      publicClient
        .getBalance({ address: walletAddress })
        .then(
          (raw): BalanceEntry => ({
            token: supportedChain.nativeCurrencySymbol,
            raw: raw.toString(),
            formatted: formatEther(raw),
          }),
        )
        .catch(
          (): BalanceEntry => ({
            token: supportedChain.nativeCurrencySymbol,
            raw: null,
            formatted: null,
            error: 'fetch failed',
          }),
        ),

      usdcAddress
        ? publicClient
            .readContract({
              address: usdcAddress,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [walletAddress],
            })
            .then(
              (raw): BalanceEntry => ({
                token: 'USDC',
                raw: raw.toString(),
                formatted: (Number(raw) / 1e6).toFixed(2),
                contractAddress: usdcAddress,
              }),
            )
            .catch(
              (): BalanceEntry => ({
                token: 'USDC',
                raw: null,
                formatted: null,
                error: 'fetch failed',
                contractAddress: usdcAddress,
              }),
            )
        : Promise.resolve(null),
    ]);

    const balances: BalanceEntry[] = [ethResult];
    if (usdcResult !== null) balances.push(usdcResult);

    const chains = [{ chainId, chainName: supportedChain.name, balances }];

    return { walletAddress, chains };
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

    const chainId = params.chainId;
    const supportedChain = getSupportedChain(chainId);
    const usdcAddressHex = supportedChain.usdcAddress;
    const walletAddress = wallet.walletAddress as `0x${string}`;

    // Guard: verify on-chain USDC balance is sufficient before submitting intent
    {
      const publicClient = createPublicClient({ chain: supportedChain.chain, transport: http() });
      let usdcBalance: bigint;
      try {
        usdcBalance = await publicClient.readContract({
          address: usdcAddressHex,
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

    const requestHash = hashRequest({
      operationType: 'withdraw',
      chainId,
      to: params.to,
      amount: params.amount,
      token: params.token,
      contractAddress: usdcAddressHex,
    });

    const { tx, created } = await this.createPendingWithdrawalOrReturnExisting(userId, {
      idempotencyKey: params.idempotencyKey!,
      chainId,
      requestHash,
      walletAddress: wallet.walletAddress,
      details: {
        type: 'withdraw',
        to: params.to,
        amount: params.amount,
        token: params.token,
        contractAddress: usdcAddressHex,
        idempotencyKey: params.idempotencyKey,
        requestHash,
      },
    });

    if (!created || tx.intentId || tx.status !== 'submitting') {
      return {
        transactionId: tx.id,
        intentId: tx.intentId,
        status: tx.status,
      };
    }

    try {
      const txIntent = await this.openfort.createTransactionIntent({
        chainId,
        accountId: wallet.openfortAccountId,
        interactions: [
          {
            contract: usdcAddressHex,
            functionName: 'transfer',
            functionArgs: [params.to, params.amount],
          },
        ],
      });

      const updated = await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          intentId: txIntent.id,
          status: 'pending',
        },
      });

      return {
        transactionId: updated.id,
        intentId: updated.intentId,
        status: updated.status,
      };
    } catch (error) {
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { status: 'unknown' },
      });
      throw error;
    }
  }

  private async createPendingWithdrawalOrReturnExisting(
    userId: string,
    params: {
      idempotencyKey: string;
      chainId: number;
      requestHash: string;
      walletAddress: string;
      details: Record<string, unknown>;
    },
  ) {
    try {
      const tx = await this.prisma.transaction.create({
        data: {
          userId,
          intentId: null,
          status: 'submitting',
          chainId: BigInt(params.chainId),
          walletAddress: params.walletAddress,
          operationType: 'withdraw',
          idempotencyKey: params.idempotencyKey,
          requestHash: params.requestHash,
          details: params.details as any,
        },
      });
      return { tx, created: true };
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;

      const existing = await this.prisma.transaction.findFirst({
        where: {
          userId,
          operationType: 'withdraw',
          chainId: BigInt(params.chainId),
          idempotencyKey: params.idempotencyKey,
        },
      });
      if (!existing) throw error;
      if (existing.requestHash && existing.requestHash !== params.requestHash) {
        throw new BadRequestException('Idempotency key was already used for a different request');
      }
      return { tx: existing, created: false };
    }
  }

  private resolveSigningChainId(params: SignDto): number | undefined {
    if ((params as { type: string }).type === 'hash') {
      throw new BadRequestException('hash signing is not allowed');
    }

    const typedDataChainId = params.typedData?.domain?.chainId;

    if (params.type === 'typed_data') {
      if (params.chainId === undefined) {
        throw new BadRequestException(
          'chainId is required when signing typed data with an API key',
        );
      }
      if (typeof typedDataChainId !== 'number') {
        throw new BadRequestException(
          'typedData.domain.chainId is required when signing typed data with an API key',
        );
      }
      if (typedDataChainId !== params.chainId) {
        throw new BadRequestException('typedData.domain.chainId must match chainId');
      }
    }

    const chainId =
      params.chainId ?? (typeof typedDataChainId === 'number' ? typedDataChainId : undefined);
    if (chainId === undefined) {
      throw new BadRequestException('chainId is required when signing with an API key');
    }
    return chainId;
  }

  private hashSignMessage(message: SignMessage): string {
    if (typeof message === 'string') {
      return hashMessage(message);
    }

    return hashMessage({ raw: message.raw });
  }
}

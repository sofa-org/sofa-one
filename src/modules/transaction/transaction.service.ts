import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';

@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
  ) {}

  /**
   * Submit a transaction intent with one or more contract interactions.
   * Openfort handles signing, UserOperation bundling, and paymaster.
   */
  async createIntent(
    userId: string,
    params: {
      chainId: number;
      policyId?: string;
      interactions: Array<{
        contract: string;
        functionName: string;
        functionArgs?: string[];
      }>;
    },
  ) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const txIntent = await this.openfort.createTransactionIntent({
      chainId: params.chainId,
      accountId: wallet.openfortAccountId,
      policyId: params.policyId,
      interactions: params.interactions,
    });

    const tx = await this.prisma.transaction.create({
      data: {
        userId,
        intentId: txIntent.id,
        status: 'pending',
        chainId: BigInt(params.chainId),
        walletAddress: wallet.walletAddress,
        details: {
          type: 'intent',
          policyId: params.policyId ?? null,
          interactions: params.interactions,
        },
      },
    });

    return {
      transactionId: tx.id,
      intentId: txIntent.id,
      status: 'pending',
    };
  }

  /** Paginated transaction history for the authenticated user. */
  async getHistory(userId: string, limit = 50, offset = 0) {
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.transaction.count({ where: { userId } }),
    ]);

    return {
      transactions: transactions.map((tx) => ({
        id: tx.id,
        intentId: tx.intentId,
        status: tx.status,
        txHash: tx.txHash,
        chainId: tx.chainId ? Number(tx.chainId) : null,
        walletAddress: tx.walletAddress,
        createdAt: tx.createdAt,
      })),
      total,
      limit,
      offset,
    };
  }
}

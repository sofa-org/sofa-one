import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { assertAllowedApiKeyChain, getSupportedChain } from '../../common/chains/supported-chains';
import { hashRequest } from '../../common/utils/request-hash';
import { RequestContextService } from '../../common/request-context/request-context.service';
import type { SendTransactionDto } from './dto/send-transaction.dto';

const TERMINAL_TRANSACTION_STATUSES = new Set(['confirmed', 'failed', 'unknown']);

type ApiKeyTransactionContext = {
  id?: string;
  keyPrefix?: string;
  name?: string | null;
  allowedChains: number[];
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    @Optional()
    private readonly requestContext?: RequestContextService,
  ) {}

  /** Send a raw transaction from the user's backend wallet. */
  async send(userId: string, dto: SendTransactionDto, apiKeyRecord?: ApiKeyTransactionContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required');
    }

    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (wallet.status !== 'active' || !wallet.walletAddress || !wallet.openfortAccountId) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    const chainId = dto.chainId;
    getSupportedChain(chainId);
    assertAllowedApiKeyChain(apiKeyRecord, chainId);

    const requestHash = hashRequest({
      operationType: 'send',
      chainId,
      interactions: dto.interactions,
      policyId: dto.policyId ?? null,
    });
    const interactionsHash = hashRequest(dto.interactions);

    const existingTransaction = await this.findExistingTransactionRequest(userId, {
      operationType: 'send',
      chainId,
      idempotencyKey: dto.idempotencyKey!,
      requestHash,
    });
    if (existingTransaction) {
      this.logExistingTransaction(existingTransaction, chainId, apiKeyRecord.keyPrefix);
      return this.toSendResponse(existingTransaction);
    }

    if (dto.policyId) {
      const policy = await this.prisma.userPolicy.findUnique({
        where: {
          userId_openfortPolicyId: {
            userId,
            openfortPolicyId: dto.policyId,
          },
        },
      });
      if (!policy) throw new NotFoundException('Policy not found');
    }

    const { tx, created } = await this.createPendingOrReturnExisting(userId, {
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      apiKeyName: apiKeyRecord.name,
      operationType: 'send',
      idempotencyKey: dto.idempotencyKey!,
      chainId,
      requestHash,
      interactionsHash,
      walletAddress: wallet.walletAddress,
      details: {
        type: 'send',
        interactionCount: dto.interactions.length,
        interactionsHash,
        ...(dto.policyId ? { policyId: dto.policyId } : {}),
        idempotencyKey: dto.idempotencyKey,
        requestHash,
      },
    });

    if (!created || tx.intentId || tx.txHash || tx.status !== 'submitting') {
      this.logExistingTransaction(tx, chainId, apiKeyRecord.keyPrefix);
      return this.toSendResponse(tx);
    }

    try {
      this.logger.log(
        this.logContext({
          message: 'Submitting transaction to Openfort',
          transactionId: tx.id,
          chainId,
          interactionCount: dto.interactions.length,
          apiKeyPrefix: apiKeyRecord.keyPrefix,
        }),
      );
      const { intentId, transactionHash } = await this.openfort.sendTransaction({
        accountId: wallet.openfortAccountId,
        chainId,
        interactions: dto.interactions,
        policyId: dto.policyId,
      });

      const updated = await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          intentId: intentId ?? transactionHash ?? null,
          txHash: transactionHash ?? null,
          status: transactionHash ? 'confirmed' : 'pending',
          completedAt: transactionHash ? new Date() : null,
        },
      });

      this.logger.log(
        this.logContext({
          message: 'Transaction submission recorded',
          transactionId: updated.id,
          status: updated.status,
          chainId,
          apiKeyPrefix: apiKeyRecord.keyPrefix,
          hasTransactionHash: Boolean(transactionHash),
        }),
      );

      return {
        transactionId: updated.id,
        transactionHash,
        status: updated.status,
      };
    } catch (error) {
      this.logger.error(
        this.logContext({
          message: 'Transaction submission failed',
          transactionId: tx.id,
          chainId,
          apiKeyPrefix: apiKeyRecord.keyPrefix,
        }),
        error instanceof Error ? error.stack : undefined,
      );
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          status: 'failed',
          failureReason: this.toFailureReason(error),
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  /** Return a safe transaction status view, refreshing Openfort intent state when possible. */
  async getStatus(userId: string, transactionId: string, apiKeyRecord?: ApiKeyTransactionContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required');
    }

    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!tx) throw new NotFoundException('Transaction not found');

    assertAllowedApiKeyChain(apiKeyRecord, Number(tx.chainId));

    const refreshed = await this.refreshTransactionStatusBestEffort(tx);
    return this.toStatusResponse(refreshed);
  }

  /** Reconcile stale in-flight transactions that have an Openfort intent id. */
  async reconcileStaleTransactions(params: { olderThan: Date; limit?: number }) {
    const stale = await this.prisma.transaction.findMany({
      where: {
        status: { in: ['submitting', 'pending'] },
        intentId: { not: null },
        createdAt: { lt: params.olderThan },
      },
      orderBy: { createdAt: 'asc' },
      take: params.limit ?? 50,
    });

    const results = [];
    for (const tx of stale) {
      try {
        results.push(await this.refreshTransactionStatus(tx));
      } catch {
        results.push(tx);
      }
    }
    return { checked: stale.length, transactions: results.map((tx) => this.toStatusResponse(tx)) };
  }

  private async createPendingOrReturnExisting(
    userId: string,
    params: {
      apiKeyId?: string;
      apiKeyPrefix?: string;
      apiKeyName?: string | null;
      operationType: string;
      idempotencyKey: string;
      chainId: number;
      requestHash: string;
      interactionsHash: string;
      walletAddress: string;
      details: Record<string, unknown>;
    },
  ) {
    try {
      const tx = await this.prisma.transaction.create({
        data: {
          userId,
          apiKeyId: params.apiKeyId,
          authMethod: 'api_key',
          apiKeyPrefix: params.apiKeyPrefix,
          apiKeyName: params.apiKeyName,
          intentId: null,
          status: 'submitting',
          chainId: BigInt(params.chainId),
          walletAddress: params.walletAddress,
          operationType: params.operationType,
          idempotencyKey: params.idempotencyKey,
          requestHash: params.requestHash,
          interactionsHash: params.interactionsHash,
          details: params.details as any,
        },
      });
      return { tx, created: true };
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;

      const existing = await this.findExistingTransactionRequest(userId, {
        operationType: params.operationType,
        chainId: params.chainId,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
      });
      if (!existing) throw error;
      return { tx: existing, created: false };
    }
  }

  private async findExistingTransactionRequest(
    userId: string,
    params: { operationType: string; chainId: number; idempotencyKey: string; requestHash: string },
  ) {
    const existing = await this.prisma.transaction.findFirst({
      where: {
        userId,
        operationType: params.operationType,
        chainId: BigInt(params.chainId),
        idempotencyKey: params.idempotencyKey,
      },
    });

    if (!existing) return null;
    if (existing.requestHash && existing.requestHash !== params.requestHash) {
      throw new BadRequestException('Idempotency key was already used for a different request');
    }

    return existing;
  }

  private logExistingTransaction(tx: any, chainId: number, apiKeyPrefix: string | undefined): void {
    this.logger.log(
      this.logContext({
        message: 'Returning existing transaction request',
        transactionId: tx.id,
        status: tx.status,
        chainId,
        apiKeyPrefix,
      }),
    );
  }

  private toSendResponse(tx: any) {
    return {
      transactionId: tx.id,
      transactionHash: tx.txHash ?? tx.intentId,
      status: tx.status,
    };
  }

  private async refreshTransactionStatus(tx: any) {
    if (!this.canRefreshFromOpenfort(tx)) return tx;

    const intent = await this.openfort.getTransactionIntent(tx.intentId);
    const nextStatus = this.toLocalTransactionStatus(intent?.status, tx.status);
    const transactionHash = this.extractTransactionHash(intent) ?? tx.txHash;
    const terminal = TERMINAL_TRANSACTION_STATUSES.has(nextStatus);

    if (nextStatus === tx.status && transactionHash === tx.txHash) return tx;

    return this.prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: nextStatus,
        txHash: transactionHash,
        failureReason:
          nextStatus === 'failed' ? this.extractFailureReason(intent) : tx.failureReason,
        completedAt: terminal ? (tx.completedAt ?? new Date()) : tx.completedAt,
      },
    });
  }

  private canRefreshFromOpenfort(tx: any) {
    return Boolean(
      tx.intentId &&
      !TERMINAL_TRANSACTION_STATUSES.has(tx.status) &&
      !this.looksLikeTransactionHash(tx.intentId),
    );
  }

  private async refreshTransactionStatusBestEffort(tx: any) {
    try {
      return await this.refreshTransactionStatus(tx);
    } catch (error) {
      this.logger.warn(
        this.logContext({
          message: 'Transaction status refresh failed',
          transactionId: tx.id,
          intentId: tx.intentId,
        }),
      );
      return tx;
    }
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
  }

  private looksLikeTransactionHash(value: string) {
    return /^0x[a-fA-F0-9]{64}$/.test(value);
  }

  private toLocalTransactionStatus(openfortStatus: unknown, currentStatus: string) {
    const status = String(openfortStatus ?? '').toLowerCase();
    if (['confirmed', 'succeeded', 'successful', 'success', 'completed'].includes(status)) {
      return 'confirmed';
    }
    if (['failed', 'cancelled', 'canceled', 'reverted'].includes(status)) {
      return 'failed';
    }
    if (['pending', 'broadcast', 'broadcasted', 'submitted', 'processing'].includes(status)) {
      return 'pending';
    }
    return currentStatus;
  }

  private extractTransactionHash(intent: any) {
    return (
      intent?.transactionHash ??
      intent?.response?.transactionHash ??
      intent?.transaction?.hash ??
      intent?.receipt?.transactionHash ??
      null
    );
  }

  private extractFailureReason(intent: any) {
    const reason =
      intent?.failureReason ?? intent?.error?.message ?? intent?.message ?? 'Transaction failed';
    return String(reason).slice(0, 500);
  }

  private toStatusResponse(tx: any) {
    return {
      transactionId: tx.id,
      transactionHash: tx.txHash,
      status: tx.status,
      chainId: Number(tx.chainId),
      walletAddress: tx.walletAddress,
      failureReason: tx.failureReason ? 'Transaction failed' : null,
      createdAt: tx.createdAt,
      completedAt: tx.completedAt,
    };
  }

  private toFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Transaction submission failed';
    return message.slice(0, 500);
  }
}

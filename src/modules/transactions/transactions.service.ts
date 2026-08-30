import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { hashRequest } from '../../common/utils/request-hash';
import { sanitizeErrorMessage } from '../../common/utils/sanitize';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { AgentStatus } from '../../common/agent/agent-status';
import type { ExecutionMode, SendTransactionDto } from './dto/send-transaction.dto';
import type { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { EoaExecutionPolicyService } from '../eoa-execution/eoa-execution-policy.service';
import { TransactionPolicyService } from './transaction-policy.service';
import { TransactionSimulationService } from './transaction-simulation.service';
import { RiskEvaluationService } from '../security-events/risk-evaluation.service';
import { SessionKeyPolicyService } from '../session-key/session-key-policy.service';

type ApiKeyTransactionContext = {
  id?: string;
  keyPrefix?: string;
  name?: string | null;
  allowedIps?: string[] | null;
  expiresAt?: Date | string | null;
  canSendTransaction?: boolean;
  canReadTransactionStatus?: boolean;
  canUseEoaExecution?: boolean;
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
  dailySpendLimit?: string | null;
  monthlySpendLimit?: string | null;
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly transactionPolicy: TransactionPolicyService,
    @Optional()
    private readonly eoaExecutionPolicy?: EoaExecutionPolicyService,
    @Optional()
    private readonly transactionSimulation?: TransactionSimulationService,
    @Optional()
    private readonly riskEvaluation?: RiskEvaluationService,
    @Optional()
    private readonly sessionKeyPolicy?: SessionKeyPolicyService,
    @Optional()
    private readonly requestContext?: RequestContextService,
  ) {}

  /** Send a transaction from the user's EIP-7702 delegated EOA via the backend agent signer. */
  async send(userId: string, dto: SendTransactionDto, apiKeyRecord?: ApiKeyTransactionContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required');
    }
    this.assertPermission(
      apiKeyRecord.canSendTransaction,
      'API key is not allowed to send transactions',
    );

    const chainId = dto.chainId;
    getSupportedChain(chainId);
    const executionMode = this.resolveExecutionMode(dto.executionMode);
    if (executionMode === 'eoa') {
      this.assertPermission(
        apiKeyRecord.canUseEoaExecution,
        'API key is not allowed to use EOA execution',
      );
      await this.assertEoaExecutionAllowed(userId, apiKeyRecord, {
        operation: 'send_transaction',
        chainId,
        metadata: { interactionCount: dto.interactions.length },
      });
      this.logSecurityWarning({
        message: 'Privileged EOA transaction requested',
        userId,
        chainId,
        executionMode,
        interactionCount: dto.interactions.length,
        apiKeyPrefix: apiKeyRecord.keyPrefix,
      });
    }
    await this.transactionPolicy.assertAllowed(dto, {
      userId,
      chainId,
      executionMode,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      allowedContracts: apiKeyRecord.allowedContracts,
      allowedFunctionSelectors: apiKeyRecord.allowedFunctionSelectors,
      dailySpendLimit: apiKeyRecord.dailySpendLimit,
      monthlySpendLimit: apiKeyRecord.monthlySpendLimit,
    });
    // Evaluate multi-factor risk before proceeding
    const riskAssessment = await this.riskEvaluation?.evaluateRisk({
      userId,
      apiKeyId: apiKeyRecord.id,
      walletId: undefined,
      operationType: 'transaction_send',
    });
    if (riskAssessment && riskAssessment.action !== 'allow') {
      await this.riskEvaluation!.enforceRiskAction(riskAssessment, {
        userId,
        apiKeyId: apiKeyRecord.id,
        walletId: undefined,
        operationType: 'transaction_send',
      });
    }
    const wallet = await this.prisma.userWallet.findUnique({
      where: { userId },
      include: {
        chainAuthorizations: { where: { chainId: BigInt(chainId) } },
      },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');

    this.assertWalletNotFrozen(wallet);
    this.assertWalletReady(wallet);
    const accountAddress = wallet.walletAddress!;
    if (executionMode === 'session_key') {
      this.assertAgentWalletReady(wallet, wallet.chainAuthorizations?.[0]);
      await this.sessionKeyPolicy?.assertSessionKeyAllowed({
        userId,
        walletId: wallet.id,
        apiKeyId: apiKeyRecord.id,
        apiKeyPrefix: apiKeyRecord.keyPrefix,
        chainId,
        accountAddress,
        keyHash: wallet.agentKeyHash!,
        operation: 'send_transaction',
        allowedContracts: apiKeyRecord.allowedContracts,
        allowedFunctionSelectors: apiKeyRecord.allowedFunctionSelectors,
        dailySpendLimit: apiKeyRecord.dailySpendLimit,
        monthlySpendLimit: apiKeyRecord.monthlySpendLimit,
        apiKeyExpiresAt: apiKeyRecord.expiresAt,
      });
    } else {
      this.assertBackendWalletReady(wallet);
    }
    const transactionWalletAddress =
      executionMode === 'eoa' ? wallet.agentWalletAddress! : accountAddress;

    const sponsorship = executionMode === 'session_key' ? (dto.sponsorship ?? 'none') : undefined;
    const requestHash = hashRequest({
      operationType: 'send',
      chainId,
      executionMode,
      ...(sponsorship ? { sponsorship } : {}),
      interactions: dto.interactions,
    });
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

    await this.assertTransactionSimulatable(userId, dto, apiKeyRecord, {
      chainId,
      executionMode,
      from: transactionWalletAddress,
    });

    const { tx, created } = await this.createPendingOrReturnExisting(userId, {
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      apiKeyName: apiKeyRecord.name,
      operationType: 'send',
      idempotencyKey: dto.idempotencyKey!,
      chainId,
      requestHash,
      walletAddress: transactionWalletAddress,
      details: {
        type: 'send',
        execution: executionMode === 'session_key' ? 'calibur_agent_user_operation' : 'backend_eoa',
        executionMode,
        ...(sponsorship ? { sponsorship } : {}),
        interactionCount: dto.interactions.length,
        agentWalletAddress: wallet.agentWalletAddress,
        agentKeyHash: wallet.agentKeyHash,
        idempotencyKey: dto.idempotencyKey,
        requestHash,
      },
    });

    if (!created || tx.txHash || tx.status !== 'submitting') {
      this.logExistingTransaction(tx, chainId, apiKeyRecord.keyPrefix);
      return this.toSendResponse(tx);
    }

    let observedUserOpHash = (tx as any).userOpHash ?? (
      tx.details && typeof tx.details === 'object' && !Array.isArray(tx.details) &&
      typeof (tx.details as Record<string, unknown>).userOpHash === 'string'
        ? (tx.details as Record<string, unknown>).userOpHash as string : null
    );
    try {
      this.logger.log(
        this.logContext({
          message:
            executionMode === 'session_key'
              ? 'Submitting UserOperation to Openfort bundler'
              : 'Submitting backend EOA transaction to Openfort',
          transactionId: tx.id,
          chainId,
          executionMode,
          interactionCount: dto.interactions.length,
          apiKeyPrefix: apiKeyRecord.keyPrefix,
        }),
      );
      let submission = await this.submitTransaction(executionMode, {
        accountAddress,
        chainId,
        interactions: dto.interactions,
        agentOpenfortAccountId: wallet.agentOpenfortAccountId!,
        agentKeyHash: wallet.agentKeyHash!,
        sponsorship,
        onUserOperationHash: async (userOpHash) => {
          observedUserOpHash = userOpHash;
          await this.prisma.transaction.updateMany({
            where: this.sendCasWhere(tx, userId, chainId, dto.idempotencyKey!, requestHash, {
              billingReconciledAt: null,
              userOpHash: null,
              status: { in: ['submitting', 'unknown', 'pending'] },
            }),
            data: { userOpHash, status: 'pending', completedAt: null },
          });
        },
      });

      if (submission.userOpHash) {
        observedUserOpHash = submission.userOpHash;
        // Persist the UserOperation identity before any provider wait. A wait
        // timeout is therefore recoverable without resubmission.
        await this.prisma.transaction.updateMany({
          where: this.sendCasWhere(tx, userId, chainId, dto.idempotencyKey!, requestHash, {
            status: { in: ['submitting', 'unknown', 'pending'] }, userOpHash: null, billingReconciledAt: null,
          }),
          data: { userOpHash: submission.userOpHash, status: 'pending', completedAt: null,
            details: { ...((tx.details as Record<string, unknown>) ?? {}), userOpHash: submission.userOpHash } as any },
        });
        try {
          const receipt = await this.openfort.waitForUserOperationReceipt({ chainId, userOpHash: submission.userOpHash });
          submission = { ...submission, transactionHash: receipt.transactionHash, userOperationSuccess: receipt.success };
        } catch (error) {
          await this.prisma.transaction.updateMany({
            where: this.sendCasWhere(tx, userId, chainId, dto.idempotencyKey!, requestHash,
              { status: { in: ['submitting', 'pending', 'unknown'] }, userOpSuccess: { not: true }, billingReconciledAt: null }),
            data: { status: 'unknown', completedAt: null },
          });
          throw error;
        }
      }

      let finalStatus: 'confirmed' | 'pending' | 'unknown' = submission.transactionHash ? 'confirmed' : 'pending';
      if (submission.userOperationSuccess === false) finalStatus = 'unknown';
      if (submission.transactionHash) {
        try {
          const receipt = await this.openfort.getTransactionReceipt(chainId, submission.transactionHash);
          finalStatus = submission.userOperationSuccess === false
            ? 'unknown'
            : receipt.status === 'success' ? 'confirmed' : 'unknown';
        } catch {
          // The broadcast already returned a hash; inability to read its receipt
          // is recoverable uncertainty, never a failed submission.
          finalStatus = 'unknown';
        }
      }
      const finalData = {
        ...(submission.transactionHash ? { txHash: submission.transactionHash } : {}),
        ...(submission.userOpHash ? { userOpSuccess: submission.transactionHash ? submission.userOperationSuccess ?? null : null } : {}),
        status: submission.userOpHash && submission.userOperationSuccess === true && !submission.transactionHash
          ? 'unknown' : finalStatus,
        completedAt: finalStatus === 'confirmed' ? new Date() : null,
        details: {
          ...((tx.details as Record<string, unknown>) ?? {}),
          ...(submission.userOpHash ? { userOpHash: submission.userOpHash } : {}),
          ...(submission.userOperationSuccess !== undefined ? { userOperationSuccess: submission.userOperationSuccess } : {}),
        } as any,
      };
      const finalWrite = await this.prisma.transaction.updateMany({
        where: this.sendCasWhere(tx, userId, chainId, dto.idempotencyKey!, requestHash, {
          status: { in: ['submitting', 'pending', 'unknown'] },
          ...(submission.userOpHash ? { userOpHash: submission.userOpHash } : { txHash: null }),
          // The completion is only allowed to establish typed truth from the
          // unresolved state. A reconciler that already wrote true (or false)
          // wins and this late request becomes a safe CAS no-op.
          ...(submission.userOpHash ? { userOpSuccess: null } : {}),
          billingReconciledAt: null,
        }),
        data: finalData,
      });
      if (finalWrite.count !== 1) return this.toSendResponse(tx);
      const updated = { ...tx, ...finalData } as any;

      this.logger.log(
        this.logContext({
          message: 'Transaction submission recorded',
          transactionId: updated.id,
          status: updated.status,
          chainId,
          apiKeyPrefix: apiKeyRecord.keyPrefix,
          hasTransactionHash: Boolean(submission.transactionHash),
        }),
      );

      return {
        transactionId: updated.id,
        transactionHash: submission.transactionHash,
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
      const uncertain = isOpenfortTimeout(error);
      const knownUserOperation = Boolean(observedUserOpHash);
      await this.prisma.transaction.updateMany({
        where: this.sendCasWhere(tx, userId, chainId, dto.idempotencyKey!, requestHash, {
          status: { in: ['submitting', 'pending', 'unknown'] }, userOpSuccess: { not: true }, billingReconciledAt: null,
          ...(knownUserOperation ? { OR: [{ userOpHash: observedUserOpHash }, { userOpHash: null }] } : {}),
        }),
        data: {
          ...(knownUserOperation ? { userOpHash: observedUserOpHash, status: 'unknown', failureReason: null, completedAt: null } : {
            status: uncertain ? 'unknown' : 'failed',
            failureReason: uncertain ? null : this.toFailureReason(error),
            completedAt: uncertain ? null : new Date(),
          }),
        },
      });
      throw error;
    }
  }

  private resolveExecutionMode(mode?: ExecutionMode): ExecutionMode {
    return mode ?? 'session_key';
  }

  private sendCasWhere(tx: any, userId: string, chainId: number, idempotencyKey: string, requestHash: string, extra: Record<string, unknown>) {
    return { id: tx.id, userId, operationType: 'send', chainId: BigInt(chainId), idempotencyKey, requestHash, ...extra };
  }

  private async assertEoaExecutionAllowed(
    userId: string,
    apiKeyRecord: ApiKeyTransactionContext,
    context: { operation: 'send_transaction'; chainId: number; metadata?: Record<string, unknown> },
  ) {
    if (!this.eoaExecutionPolicy) {
      throw new ForbiddenException('EOA execution policy is not available');
    }
    await this.eoaExecutionPolicy.assertAllowed({
      operation: context.operation,
      userId,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      allowedIps: apiKeyRecord.allowedIps,
      clientIp: this.requestContext?.getClientIp(),
      expiresAt: apiKeyRecord.expiresAt,
      chainId: context.chainId,
      metadata: context.metadata as any,
    });
  }

  private assertWalletReady(wallet: { status: string; walletAddress?: string | null }): void {
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
  }

  private assertWalletNotFrozen(wallet: { frozenAt?: Date | string | null; frozenReason?: string | null }): void {
    if (wallet.frozenAt) {
      throw new ForbiddenException(wallet.frozenReason ?? 'Wallet is frozen');
    }
  }

  private async submitTransaction(
    executionMode: ExecutionMode,
    params: {
      accountAddress: string;
      chainId: number;
      interactions: SendTransactionDto['interactions'];
      agentOpenfortAccountId: string;
      agentKeyHash: string;
      sponsorship?: SendTransactionDto['sponsorship'];
      onUserOperationHash?: (userOpHash: string) => void | Promise<void>;
    },
  ): Promise<{ transactionHash?: string | null; userOpHash?: string; userOperationSuccess?: boolean | null }> {
    if (executionMode === 'eoa') {
      return this.openfort.sendBackendTransaction({
        accountId: params.agentOpenfortAccountId,
        chainId: params.chainId,
        interactions: params.interactions,
      });
    }

    return this.openfort.submitUserOperation({
      agentAccountId: params.agentOpenfortAccountId,
      accountAddress: params.accountAddress,
      chainId: params.chainId,
      keyHash: params.agentKeyHash,
      interactions: params.interactions,
      sponsorship: params.sponsorship,
      onUserOperationHash: params.onUserOperationHash,
    });
  }

  private assertAgentWalletReady(
    wallet: {
      status: string;
      walletAddress?: string | null;
      agentOpenfortAccountId?: string | null;
      agentWalletAddress?: string | null;
      agentKeyHash?: string | null;
    },
    authorization?: { status: string; expiresAt?: Date | string | null } | null,
  ): void {
    if (
      wallet.status !== 'active' ||
      !wallet.walletAddress ||
      !wallet.agentOpenfortAccountId ||
      !wallet.agentWalletAddress ||
      !wallet.agentKeyHash
    ) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    if (authorization?.status !== AgentStatus.Registered) {
      throw new BadRequestException('API access is not authorized for this chain');
    }

    const expiresAt = authorization.expiresAt ? new Date(authorization.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new BadRequestException('API access authorization is expired for this chain');
    }
  }

  private assertBackendWalletReady(wallet: {
    status: string;
    agentOpenfortAccountId?: string | null;
    agentWalletAddress?: string | null;
  }): void {
    if (wallet.status !== 'active' || !wallet.agentOpenfortAccountId || !wallet.agentWalletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
  }

  private async assertTransactionSimulatable(
    userId: string,
    dto: SendTransactionDto,
    apiKeyRecord: ApiKeyTransactionContext,
    context: { chainId: number; executionMode: ExecutionMode; from: string },
  ): Promise<void> {
    if (!this.transactionSimulation) {
      throw new BadRequestException('Transaction simulation service is not available');
    }
    await this.transactionSimulation.assertSimulatable(dto, {
      userId,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      chainId: context.chainId,
      executionMode: context.executionMode,
      from: context.from,
    });
  }

  /** List transactions for a user with optional filtering and pagination. */
  async list(userId: string, query: ListTransactionsQueryDto) {
    const { status, chainId, page = 1, limit = 20 } = query;

    const where: any = { userId };
    if (status) {
      where.status = status;
    }
    if (chainId) {
      where.chainId = BigInt(chainId);
    }

    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      items: items.map((tx) => this.toListItemResponse(tx)),
      total,
      page,
      limit,
    };
  }

  /** Return a safe dashboard detail view (dashboard-only, ownership-enforced). */
  async getDashboardDetail(userId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!tx) throw new NotFoundException('Transaction not found');

    return this.toDashboardDetailResponse(tx);
  }

  /** Return a safe transaction status view. */
  async getStatus(userId: string, transactionId: string, apiKeyRecord?: ApiKeyTransactionContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required');
    }
    this.assertPermission(
      apiKeyRecord.canReadTransactionStatus,
      'API key is not allowed to read transaction status',
    );

    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId, operationType: 'send', authMethod: 'api_key' },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.operationType !== 'send' || tx.authMethod !== 'api_key') {
      throw new NotFoundException('Transaction not found');
    }

    return this.toStatusResponse(tx);
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
      walletAddress: string;
      details: Record<string, unknown>;
    },
  ) {
    const createdAt = new Date();
    const billingPeriodStart = new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1));
    try {
      const tx = await this.prisma.transaction.create({
        data: {
          userId,
          apiKeyId: params.apiKeyId,
          authMethod: 'api_key',
          apiKeyPrefix: params.apiKeyPrefix,
          apiKeyName: params.apiKeyName,
          status: 'submitting',
          chainId: BigInt(params.chainId),
          walletAddress: params.walletAddress,
          operationType: params.operationType,
          idempotencyKey: params.idempotencyKey,
          requestHash: params.requestHash,
          createdAt,
          billingPeriodStart,
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
      transactionHash: tx.txHash,
      status: tx.status,
    };
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
  }

  private logSecurityWarning(extra: Record<string, unknown>): void {
    this.logger.warn(this.logContext({ event: 'security', ...extra }));
  }

  private toListItemResponse(tx: any) {
    return {
      id: tx.id,
      status: tx.status,
      txHash: tx.txHash,
      chainId: Number(tx.chainId),
      walletAddress: tx.walletAddress,
      operationType: tx.operationType,
      apiKeyPrefix: tx.apiKeyPrefix,
      apiKeyName: tx.apiKeyName,
      createdAt: tx.createdAt,
      completedAt: tx.completedAt,
      failureReason: tx.failureReason ? 'Transaction failed' : null,
    };
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

  private toDashboardDetailResponse(tx: any) {
    return {
      id: tx.id,
      status: tx.status,
      txHash: tx.txHash,
      chainId: Number(tx.chainId),
      walletAddress: tx.walletAddress,
      operationType: tx.operationType,
      authMethod: tx.authMethod,
      apiKeyPrefix: tx.apiKeyPrefix,
      apiKeyName: tx.apiKeyName,
      idempotencyKey: tx.idempotencyKey,
      failureReason: tx.failureReason ? 'Transaction failed' : null,
      createdAt: tx.createdAt,
      completedAt: tx.completedAt,
      // For withdrawals, include safe withdrawal details from the details JSON
      withdrawal:
        tx.operationType === 'withdraw' && tx.details
          ? {
              to: (tx.details as any)?.to ?? null,
              amount: (tx.details as any)?.amount ?? null,
              token: (tx.details as any)?.token ?? null,
            }
          : null,
    };
  }

  private toFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Transaction submission failed';
    return sanitizeErrorMessage(message);
  }

  private assertPermission(allowed: boolean | undefined, message: string): void {
    if (allowed !== true) {
      throw new ForbiddenException(message);
    }
  }
}

function isOpenfortTimeout(error: unknown): boolean {
  const candidate = error as { message?: unknown; response?: unknown };
  const message = [candidate?.message, candidate?.response]
    .map((value) => typeof value === 'string' ? value : JSON.stringify(value))
    .join(' ');
  return /timed out|timeout|timedout/i.test(message);
}

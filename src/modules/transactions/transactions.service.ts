import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { getAddress, isAddress } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import { hashRequest } from '../../common/utils/request-hash';
import { sanitizeErrorMessage } from '../../common/utils/sanitize';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { AgentStatus } from '../../common/agent/agent-status';
import type { ExecutionMode, SendTransactionDto } from './dto/send-transaction.dto';
import type { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { EoaExecutionPolicyService } from '../eoa-execution/eoa-execution-policy.service';
import { TransactionPolicyService } from './transaction-policy.service';
import {
  AssetFlowSimulationUnavailableError,
  TransactionSimulationService,
} from './transaction-simulation.service';
import { RiskEvaluationService } from '../security-events/risk-evaluation.service';
import { SessionKeyPolicyService } from '../session-key/session-key-policy.service';
import { BillingDebtService } from '../billing/billing-debt.service';
import {
  isDeferredDestinationPolicyDenial,
  WithdrawalDestinationPolicyService,
} from '../withdrawal-destination/withdrawal-destination-policy.service';
import {
  classifyTransactionAssetFlow,
  type AssetFlowBatchClassification,
} from './transaction-asset-flow.policy';
import {
  computeAssetFlowPlanDigest,
  verifyTransactionAssetFlow,
  type AssetFlowSimulationMode,
  type AssetFlowVerificationResult,
} from './transaction-asset-flow.verifier';
import {
  extractDirectTransferIntents,
  uniqueDirectTransferDestinations,
  type DirectTransferIntent,
} from './direct-transfer-intents';

/** Exact outer-gate proof binding carried into the create transaction (no raw evidence). */
type BoundAssetFlowVerification = {
  status: 'verified';
  planDigest: string;
  ownerAddress: string;
  chainId: number;
  executionMode: ExecutionMode;
  simulationMode: AssetFlowSimulationMode;
};

type BillingAssetFlowGateContext = {
  userId: string;
  walletId?: string;
  executionMode: ExecutionMode;
  /** Trusted execution owner used for classification + evidence binding. */
  ownerAddress: string;
  /** Full ordered interaction plan (binding source of truth). */
  interactions: ReadonlyArray<{ to: string; data: string; value?: string }>;
  assetFlow: AssetFlowBatchClassification;
  apiKeyPrefix?: string;
  /**
   * Exact verified proof from the outer gate when debt was present and verified.
   * Null when outer observed no debt (inner must reject if debt appears without proof).
   */
  verification: BoundAssetFlowVerification | null;
};

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
  /** BILL-016: null/undefined = not authorized for new direct-egress sends. */
  directEgressPolicyAcceptedAt?: Date | string | null;
};

type DestinationGateContext = {
  userId: string;
  destinations: string[];
  intents: DirectTransferIntent[];
  chainId: number;
  walletId?: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  executionMode: ExecutionMode;
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly transactionPolicy: TransactionPolicyService,
    private readonly billingDebt: BillingDebtService,
    private readonly config: ConfigService,
    private readonly destinationPolicy: WithdrawalDestinationPolicyService,
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
      // Idempotent hit: no destination re-check, no Openfort, no broadcast.
      this.logExistingTransaction(existingTransaction, chainId, apiKeyRecord.keyPrefix);
      return this.toSendResponse(existingTransaction);
    }

    // Owner for asset-flow classification + destination policy + evidence binding:
    // session_key executes as the user wallet; eoa executes as the agent backend wallet.
    const assetFlowOwnerAddress =
      executionMode === 'eoa' ? wallet.agentWalletAddress! : wallet.walletAddress!;

    // BILL-016: direct ERC-20-shaped transfer destinations (preflight).
    // Self-transfers (recipient === execution owner) are excluded by the parser.
    const destinationExtract = extractDirectTransferIntents(
      dto.interactions,
      assetFlowOwnerAddress,
    );
    if (!destinationExtract.ok) {
      throw new BadRequestException(destinationExtract.message);
    }
    const destinationGate: DestinationGateContext | null =
      destinationExtract.intents.length > 0
        ? {
            userId,
            destinations: uniqueDirectTransferDestinations(destinationExtract.intents),
            intents: destinationExtract.intents,
            chainId,
            walletId: wallet.id,
            apiKeyId: apiKeyRecord.id,
            apiKeyPrefix: apiKeyRecord.keyPrefix,
            executionMode,
          }
        : null;

    if (destinationGate) {
      this.assertDirectEgressReauthorized(apiKeyRecord);
      await this.destinationPolicy.assertDestinationsAllowed(userId, destinationGate.destinations, {
        actorType: 'api_key',
        chainId,
        walletId: wallet.id,
        apiKeyId: apiKeyRecord.id,
        apiKeyPrefix: apiKeyRecord.keyPrefix,
        executionMode,
      });
    }

    const assetFlow = classifyTransactionAssetFlow({
      interactions: dto.interactions,
      ownerAddress: assetFlowOwnerAddress,
      chainId,
    });
    // Outer debt gate (may RPC for evidence). Idempotent hits returned above skip this entirely.
    const boundVerification = await this.evaluateOuterBillingAssetFlowGate(userId, {
      chainId,
      walletId: wallet.id,
      executionMode,
      ownerAddress: assetFlowOwnerAddress,
      interactions: dto.interactions,
      assetFlow,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
    });

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
      billingGate: {
        userId,
        walletId: wallet.id,
        executionMode,
        ownerAddress: assetFlowOwnerAddress,
        interactions: dto.interactions,
        assetFlow,
        apiKeyPrefix: apiKeyRecord.keyPrefix,
        verification: boundVerification,
      },
      destinationGate,
    });

    if (!created || tx.txHash || tx.status !== 'submitting') {
      this.logExistingTransaction(tx, chainId, apiKeyRecord.keyPrefix);
      return this.toSendResponse(tx);
    }

    let observedUserOpHash =
      (tx as any).userOpHash ??
      (tx.details &&
      typeof tx.details === 'object' &&
      !Array.isArray(tx.details) &&
      typeof (tx.details as Record<string, unknown>).userOpHash === 'string'
        ? ((tx.details as Record<string, unknown>).userOpHash as string)
        : null);
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
            status: { in: ['submitting', 'unknown', 'pending'] },
            userOpHash: null,
            billingReconciledAt: null,
          }),
          data: {
            userOpHash: submission.userOpHash,
            status: 'pending',
            completedAt: null,
            details: {
              ...((tx.details as Record<string, unknown>) ?? {}),
              userOpHash: submission.userOpHash,
            } as any,
          },
        });
        try {
          const receipt = await this.openfort.waitForUserOperationReceipt({
            chainId,
            userOpHash: submission.userOpHash,
          });
          submission = {
            ...submission,
            transactionHash: receipt.transactionHash,
            userOperationSuccess: receipt.success,
          };
        } catch (error) {
          await this.prisma.transaction.updateMany({
            where: this.sendCasWhere(tx, userId, chainId, dto.idempotencyKey!, requestHash, {
              status: { in: ['submitting', 'pending', 'unknown'] },
              userOpSuccess: null,
              billingReconciledAt: null,
            }),
            data: { status: 'unknown', completedAt: null },
          });
          throw error;
        }
      }

      let finalStatus: 'confirmed' | 'pending' | 'unknown' = submission.transactionHash
        ? 'confirmed'
        : 'pending';
      if (submission.userOperationSuccess === false) finalStatus = 'unknown';
      if (submission.transactionHash) {
        try {
          const receipt = await this.openfort.getTransactionReceipt(
            chainId,
            submission.transactionHash,
          );
          finalStatus =
            submission.userOperationSuccess === false
              ? 'unknown'
              : receipt.status === 'success'
                ? 'confirmed'
                : 'unknown';
        } catch {
          // The broadcast already returned a hash; inability to read its receipt
          // is recoverable uncertainty, never a failed submission.
          finalStatus = 'unknown';
        }
      }
      const finalData = {
        ...(submission.transactionHash ? { txHash: submission.transactionHash } : {}),
        ...(submission.userOpHash
          ? {
              userOpSuccess: submission.transactionHash
                ? (submission.userOperationSuccess ?? null)
                : null,
            }
          : {}),
        status:
          submission.userOpHash &&
          submission.userOperationSuccess === true &&
          !submission.transactionHash
            ? 'unknown'
            : finalStatus,
        completedAt: finalStatus === 'confirmed' ? new Date() : null,
        details: {
          ...((tx.details as Record<string, unknown>) ?? {}),
          ...(submission.userOpHash ? { userOpHash: submission.userOpHash } : {}),
          ...(submission.userOperationSuccess !== undefined
            ? { userOperationSuccess: submission.userOperationSuccess }
            : {}),
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
          status: { in: ['submitting', 'pending', 'unknown'] },
          userOpSuccess: null,
          billingReconciledAt: null,
          ...(knownUserOperation
            ? { OR: [{ userOpHash: observedUserOpHash }, { userOpHash: null }] }
            : {}),
        }),
        data: {
          ...(knownUserOperation
            ? {
                userOpHash: observedUserOpHash,
                status: 'unknown',
                failureReason: null,
                completedAt: null,
              }
            : {
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

  private sendCasWhere(
    tx: any,
    userId: string,
    chainId: number,
    idempotencyKey: string,
    requestHash: string,
    extra: Record<string, unknown>,
  ) {
    return {
      id: tx.id,
      userId,
      operationType: 'send',
      chainId: BigInt(chainId),
      idempotencyKey,
      requestHash,
      ...extra,
    };
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

  private assertWalletNotFrozen(wallet: {
    frozenAt?: Date | string | null;
    frozenReason?: string | null;
  }): void {
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
  ): Promise<{
    transactionHash?: string | null;
    userOpHash?: string;
    userOperationSuccess?: boolean | null;
  }> {
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
    if (
      wallet.status !== 'active' ||
      !wallet.agentOpenfortAccountId ||
      !wallet.agentWalletAddress
    ) {
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
      billingGate?: BillingAssetFlowGateContext;
      destinationGate?: DestinationGateContext | null;
    },
  ) {
    // Interactive transaction: inner idempotency + destination lock/recheck +
    // debt recheck (no RPC) + create only.
    // On unique-key race (P2002) the interactive tx aborts — never re-query on the
    // failed txClient. Recover outside with the root PrismaService after rollback.
    try {
      return await this.prisma.$transaction(async (txClient) => {
        const existingInTx = await this.findExistingTransactionRequest(
          userId,
          {
            operationType: params.operationType,
            chainId: params.chainId,
            idempotencyKey: params.idempotencyKey,
            requestHash: params.requestHash,
          },
          txClient,
        );
        if (existingInTx) {
          return { tx: existingInTx, created: false };
        }

        // BILL-016: user-scoped destination lock + live API-key reauth + destination
        // re-assert before insert. Never trust the HTTP-auth snapshot alone.
        // Lock first so allowlist mutations cannot race acceptance. No RPC here.
        if (params.destinationGate && params.destinationGate.destinations.length > 0) {
          await this.destinationPolicy.acquireUserDestinationLock(userId, txClient);
          await this.assertDirectEgressKeyStateInTx(userId, params.apiKeyId, txClient);
          // deferAudit: never write security_events under ApiKey FOR UPDATE
          // (FK key-share would deadlock). Caller records after rollback.
          await this.destinationPolicy.assertDestinationsAllowed(
            userId,
            params.destinationGate.destinations,
            {
              actorType: 'api_key',
              chainId: params.destinationGate.chainId,
              walletId: params.destinationGate.walletId,
              apiKeyId: params.destinationGate.apiKeyId,
              apiKeyPrefix: params.destinationGate.apiKeyPrefix,
              executionMode: params.destinationGate.executionMode,
            },
            { prisma: txClient, deferAudit: true },
          );
        }

        if (params.billingGate) {
          await this.assertInnerBillingAssetFlowGate(
            params.billingGate.userId,
            {
              chainId: params.chainId,
              gate: params.billingGate,
            },
            txClient,
          );
        }

        const createdAt = new Date();
        const billingPeriodStart = new Date(
          Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1),
        );
        const tx = await txClient.transaction.create({
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
      });
    } catch (error: any) {
      // After TX rollback: locks released — safe to audit deferred destination denials.
      if (isDeferredDestinationPolicyDenial(error)) {
        await this.destinationPolicy.recordDeferredDenial(error);
        throw error.httpException;
      }
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

  /**
   * BILL-016: canSendTransaction keys must explicitly acknowledge destination
   * policy before any new direct-egress send. Read/status and non-egress calls
   * are unaffected. Never auto-set on key create. Outer preflight only — the
   * create transaction re-reads key state via assertDirectEgressKeyStateInTx.
   */
  private assertDirectEgressReauthorized(apiKeyRecord: ApiKeyTransactionContext): void {
    if (apiKeyRecord.directEgressPolicyAcceptedAt) {
      return;
    }
    this.throwDirectEgressReauthRequired();
  }

  /**
   * Live ApiKey row check under the create transaction. Takes
   * `SELECT ... FOR UPDATE` on the owned api_keys row (after the user destination
   * advisory lock) so revoke/freeze/expiry updates serialize with acceptance.
   * Lock is held until the interactive TX commits/rolls back. No Openfort/RPC
   * while locked. Missing/invalid keys → stable reauth 403 (no Transaction create).
   */
  private async assertDirectEgressKeyStateInTx(
    userId: string,
    apiKeyId: string | undefined,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    if (!apiKeyId) {
      this.throwDirectEgressReauthRequired();
    }

    type KeyRow = {
      user_id: string;
      revoked: boolean;
      frozen_at: Date | null;
      expires_at: Date | null;
      can_send_transaction: boolean;
      direct_egress_policy_accepted_at: Date | null;
    };

    let rows: KeyRow[];
    try {
      // FOR UPDATE blocks concurrent non-key-field updates (revoke/freeze/reauth)
      // until this acceptance TX ends. Table/column names match Prisma @@map.
      rows = await db.$queryRaw<KeyRow[]>`
        SELECT
          "user_id",
          "revoked",
          "frozen_at",
          "expires_at",
          "can_send_transaction",
          "direct_egress_policy_accepted_at"
        FROM "api_keys"
        WHERE "id" = ${apiKeyId}::uuid
        FOR UPDATE`;
    } catch {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: 'API key state is temporarily unavailable',
      });
    }

    const key = rows[0];
    if (
      !key ||
      key.user_id !== userId ||
      key.revoked ||
      key.frozen_at != null ||
      (key.expires_at != null && key.expires_at.getTime() <= Date.now()) ||
      !key.can_send_transaction ||
      key.direct_egress_policy_accepted_at == null
    ) {
      this.throwDirectEgressReauthRequired();
    }
  }

  private throwDirectEgressReauthRequired(): never {
    throw new ForbiddenException({
      code: API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED,
      message:
        'API key direct-egress reauthorization required. Authorize this key for destination-policy-bound sends before transferring assets.',
    });
  }

  private async findExistingTransactionRequest(
    userId: string,
    params: { operationType: string; chainId: number; idempotencyKey: string; requestHash: string },
    prisma: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const existing = await prisma.transaction.findFirst({
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

  /**
   * Outer debt-aware asset-flow gate (may perform RPC evidence simulation).
   * - no debt → null proof (existing path unchanged; no evidence simulation)
   * - debt + static external_transfer → BILLING_OUTBOUND_BLOCKED (no simulation)
   * - debt + retained/unknown → simulate full ordered plan + verify; only exact
   *   `status === 'verified'` AND `simulationMode === 'calibur_atomic'` yields a
   *   bound proof (complete evidence.binding, no context fallback); otherwise fail closed
   */
  private async evaluateOuterBillingAssetFlowGate(
    userId: string,
    context: {
      chainId: number;
      walletId?: string;
      executionMode: ExecutionMode;
      ownerAddress: string;
      interactions: ReadonlyArray<{ to: string; data: string; value?: string }>;
      assetFlow: AssetFlowBatchClassification;
      apiKeyPrefix?: string;
    },
  ): Promise<BoundAssetFlowVerification | null> {
    const snapshot = await this.getBillingDebtSnapshot(userId, context, this.prisma);
    if (!snapshot.hasDebt) {
      return null;
    }

    if (context.assetFlow.classification === 'external_transfer') {
      this.logBillingAssetFlowBlocked(
        userId,
        context,
        snapshot.invoiceIds.length,
        'external_transfer',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED,
        message: 'Outbound transfers are blocked until outstanding invoices are settled',
      });
    }

    // Debt + retained/unknown: require simulation evidence + verifier (DB-tx outside).
    return this.verifyDebtSensitiveAssetFlowWithEvidence(
      userId,
      context,
      snapshot.invoiceIds.length,
    );
  }

  /**
   * Inner gate: debt recheck under txClient only — never RPC/simulation/verifier network.
   * Debt without an exact bound verified proof fails closed.
   */
  private async assertInnerBillingAssetFlowGate(
    userId: string,
    params: { chainId: number; gate: BillingAssetFlowGateContext },
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const snapshot = await this.getBillingDebtSnapshot(
      userId,
      {
        chainId: params.chainId,
        walletId: params.gate.walletId,
        executionMode: params.gate.executionMode,
        assetFlow: params.gate.assetFlow,
        apiKeyPrefix: params.gate.apiKeyPrefix,
      },
      db,
    );
    if (!snapshot.hasDebt) {
      return;
    }

    const verification = params.gate.verification;
    if (
      !verification ||
      verification.status !== 'verified' ||
      verification.simulationMode !== 'calibur_atomic'
    ) {
      this.logBillingAssetFlowBlocked(
        userId,
        {
          chainId: params.chainId,
          walletId: params.gate.walletId,
          executionMode: params.gate.executionMode,
          assetFlow: params.gate.assetFlow,
          apiKeyPrefix: params.gate.apiKeyPrefix,
        },
        snapshot.invoiceIds.length,
        !verification
          ? 'missing_bound_verification'
          : verification.simulationMode !== 'calibur_atomic'
            ? 'non_atomic_bound_verification'
            : 'unverified_bound_verification',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    this.assertBoundVerificationMatchesPlan(verification, {
      chainId: params.chainId,
      executionMode: params.gate.executionMode,
      ownerAddress: params.gate.ownerAddress,
      interactions: params.gate.interactions,
    });
  }

  private async verifyDebtSensitiveAssetFlowWithEvidence(
    userId: string,
    context: {
      chainId: number;
      walletId?: string;
      executionMode: ExecutionMode;
      ownerAddress: string;
      interactions: ReadonlyArray<{ to: string; data: string; value?: string }>;
      assetFlow: AssetFlowBatchClassification;
      apiKeyPrefix?: string;
    },
    invoiceCount: number,
  ): Promise<BoundAssetFlowVerification> {
    const rpcUrl = this.resolveSimulationRpcUrl(context.chainId);
    if (!rpcUrl) {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'missing_simulation_rpc');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    if (!this.transactionSimulation?.simulateAssetFlowEvidence) {
      this.logBillingAssetFlowBlocked(
        userId,
        context,
        invoiceCount,
        'simulation_service_unavailable',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    let evidence: Awaited<ReturnType<TransactionSimulationService['simulateAssetFlowEvidence']>>;
    try {
      evidence = await this.transactionSimulation.simulateAssetFlowEvidence({
        interactions: context.interactions,
        ownerAddress: context.ownerAddress,
        chainId: context.chainId,
        executionMode: context.executionMode,
        rpcUrl,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Asset flow evidence simulation unavailable under billing debt',
        userId,
        walletId: context.walletId,
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix,
        classification: context.assetFlow.classification,
        rule: context.assetFlow.rule,
        errorName:
          error instanceof AssetFlowSimulationUnavailableError
            ? error.name
            : error instanceof Error
              ? error.name
              : typeof error,
      });
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    let verdict: AssetFlowVerificationResult;
    try {
      verdict = verifyTransactionAssetFlow({
        ownerAddress: context.ownerAddress,
        chainId: context.chainId,
        executionMode: context.executionMode,
        interactions: context.interactions,
        evidence,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Asset flow verifier failed under billing debt',
        userId,
        walletId: context.walletId,
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix,
        classification: context.assetFlow.classification,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    if (verdict.status === 'external_transfer') {
      this.logBillingAssetFlowBlocked(
        userId,
        context,
        invoiceCount,
        verdict.rule || 'verified_external',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED,
        message: 'Outbound transfers are blocked until outstanding invoices are settled',
      });
    }

    // Defense-in-depth: never accept non-atomic modes even if a mock/compromised
    // verifier returns status=verified. Only calibur_atomic may become a bound proof.
    if (verdict.status !== 'verified' || verdict.simulationMode !== 'calibur_atomic') {
      this.logBillingAssetFlowBlocked(
        userId,
        context,
        invoiceCount,
        verdict.simulationMode && verdict.simulationMode !== 'calibur_atomic'
          ? 'non_atomic_verification'
          : verdict.rule || 'verification_not_verified',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    // No context fallback: evidence.binding must be complete and exact-match the plan.
    const binding = evidence?.binding;
    if (!binding || typeof binding !== 'object') {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'missing_evidence_binding');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    if (typeof binding.planDigest !== 'string' || binding.planDigest.length === 0) {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'missing_binding_plan_digest');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (typeof binding.ownerAddress !== 'string' || !isAddress(binding.ownerAddress)) {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'missing_binding_owner');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (typeof binding.chainId !== 'number' || binding.chainId !== context.chainId) {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'binding_chain_mismatch');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (
      binding.executionMode !== context.executionMode ||
      (binding.executionMode !== 'session_key' && binding.executionMode !== 'eoa')
    ) {
      this.logBillingAssetFlowBlocked(
        userId,
        context,
        invoiceCount,
        'binding_execution_mode_mismatch',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (!isAddress(context.ownerAddress)) {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'invalid_plan_owner');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    const boundOwner = getAddress(binding.ownerAddress);
    const planOwner = getAddress(context.ownerAddress);
    if (boundOwner !== planOwner) {
      this.logBillingAssetFlowBlocked(userId, context, invoiceCount, 'binding_owner_mismatch');
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    const expectedDigest = computeAssetFlowPlanDigest({
      ownerAddress: context.ownerAddress,
      chainId: context.chainId,
      executionMode: context.executionMode,
      interactions: context.interactions,
    });
    if (!expectedDigest || binding.planDigest !== expectedDigest) {
      this.logBillingAssetFlowBlocked(
        userId,
        context,
        invoiceCount,
        'binding_plan_digest_mismatch',
      );
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    const bound: BoundAssetFlowVerification = {
      status: 'verified',
      planDigest: binding.planDigest,
      ownerAddress: boundOwner,
      chainId: binding.chainId,
      executionMode: binding.executionMode,
      simulationMode: 'calibur_atomic',
    };

    // Defense in depth: refuse to carry a proof that does not match the current plan
    // or is not an atomic verified mode.
    this.assertBoundVerificationMatchesPlan(bound, {
      chainId: context.chainId,
      executionMode: context.executionMode,
      ownerAddress: context.ownerAddress,
      interactions: context.interactions,
    });

    return bound;
  }

  private assertBoundVerificationMatchesPlan(
    verification: BoundAssetFlowVerification,
    plan: {
      chainId: number;
      executionMode: ExecutionMode;
      ownerAddress: string;
      interactions: ReadonlyArray<{ to: string; data: string; value?: string }>;
    },
  ): void {
    if (verification.status !== 'verified' || verification.simulationMode !== 'calibur_atomic') {
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (
      verification.chainId !== plan.chainId ||
      verification.executionMode !== plan.executionMode
    ) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (!isAddress(plan.ownerAddress) || !isAddress(verification.ownerAddress)) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
    if (getAddress(verification.ownerAddress) !== getAddress(plan.ownerAddress)) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }

    const expectedDigest = computeAssetFlowPlanDigest({
      ownerAddress: plan.ownerAddress,
      chainId: plan.chainId,
      executionMode: plan.executionMode,
      interactions: plan.interactions,
    });
    if (!expectedDigest || verification.planDigest !== expectedDigest) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.BILLING_ASSET_FLOW_UNVERIFIABLE,
        message: 'Asset flow could not be verified while outstanding invoices remain unpaid',
      });
    }
  }

  private async getBillingDebtSnapshot(
    userId: string,
    context: {
      chainId: number;
      walletId?: string;
      executionMode: ExecutionMode;
      assetFlow: AssetFlowBatchClassification;
      apiKeyPrefix?: string;
    },
    db: Prisma.TransactionClient,
  ): Promise<{ hasDebt: boolean; invoiceIds: string[] }> {
    try {
      return await this.billingDebt.getDebt(userId, db);
    } catch (error) {
      this.logger.error({
        message: 'Billing debt check unavailable',
        userId,
        walletId: context.walletId,
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix,
        classification: context.assetFlow.classification,
        rule: context.assetFlow.rule,
        decisiveIndex: context.assetFlow.decisiveIndex,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.BILLING_DEBT_CHECK_UNAVAILABLE,
        message: 'Billing debt check is temporarily unavailable',
      });
    }
  }

  /**
   * Strict explicit simulation RPC lookup from `simulation.rpcUrls.<chainId>`.
   * Never falls back to public http() or request-supplied URLs.
   * Missing/empty/non-https values fail closed at the call site
   * (BILLING_ASSET_FLOW_UNVERIFIABLE). Startup validation already enforces
   * supported-chain keys + https for declared env entries.
   */
  private resolveSimulationRpcUrl(chainId: number): string | null {
    const raw = this.config.get<unknown>(`simulation.rpcUrls.${chainId}`);
    if (typeof raw !== 'string') return null;
    const url = raw.trim();
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    return url;
  }

  private logBillingAssetFlowBlocked(
    userId: string,
    context: {
      chainId: number;
      walletId?: string;
      executionMode: ExecutionMode;
      assetFlow: AssetFlowBatchClassification;
      apiKeyPrefix?: string;
    },
    invoiceCount: number,
    reason: string,
  ): void {
    this.logger.warn({
      message: 'Transaction send blocked by billing debt asset-flow gate',
      userId,
      walletId: context.walletId,
      chainId: context.chainId,
      executionMode: context.executionMode,
      apiKeyPrefix: context.apiKeyPrefix,
      classification: context.assetFlow.classification,
      rule: context.assetFlow.rule,
      decisiveIndex: context.assetFlow.decisiveIndex,
      invoiceCount,
      reason,
    });
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
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ');
  return /timed out|timeout|timedout/i.test(message);
}

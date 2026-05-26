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
import { RequestContextService } from '../../common/request-context/request-context.service';
import { AgentStatus } from '../../common/agent/agent-status';
import type { ExecutionMode, SendTransactionDto } from './dto/send-transaction.dto';
import type { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';

const MAX_TRANSACTION_INTERACTIONS = 10;
const ZERO_NATIVE_VALUE = 0n;
const MAX_UINT256 = (1n << 256n) - 1n;

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const ERC721_ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR = '0xa22cb465';
const BLOCKED_PERMIT_SELECTORS = new Set([
  '0xd505accf', // ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  '0x8fcbaf0c', // DAI-style permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)
  '0x2b67b570', // Permit2 permit(address,PermitSingle,bytes)
  '0xb7f13ed4', // Permit2 compact/single permit variant
  '0x002a3e3a', // Permit2 permitBatch(address,PermitBatch,bytes)
]);

type ApiKeyTransactionContext = {
  id?: string;
  keyPrefix?: string;
  name?: string | null;
  canSendTransaction?: boolean;
  canReadTransactionStatus?: boolean;
  canUseEoaExecution?: boolean;
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
      this.logSecurityWarning({
        message: 'Privileged EOA transaction requested',
        userId,
        chainId,
        executionMode,
        interactionCount: dto.interactions.length,
        apiKeyPrefix: apiKeyRecord.keyPrefix,
      });
    }
    this.assertTransactionPolicy(dto, {
      userId,
      chainId,
      executionMode,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
    });
    const wallet = await this.prisma.userWallet.findUnique({
      where: { userId },
      include: {
        chainAuthorizations: { where: { chainId: BigInt(chainId) } },
      },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');

    this.assertWalletReady(wallet);
    const accountAddress = wallet.walletAddress!;
    if (executionMode === 'session_key') {
      this.assertAgentWalletReady(wallet, wallet.chainAuthorizations?.[0]);
      await this.openfort.verifyAgentKeyRegistration({
        accountAddress,
        chainId,
        keyHash: wallet.agentKeyHash!,
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
      const submission = await this.submitTransaction(executionMode, {
        accountAddress,
        chainId,
        interactions: dto.interactions,
        agentOpenfortAccountId: wallet.agentOpenfortAccountId!,
        agentKeyHash: wallet.agentKeyHash!,
        sponsorship,
      });

      const updated = await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          txHash: submission.transactionHash ?? null,
          status: submission.transactionHash ? 'confirmed' : 'pending',
          completedAt: submission.transactionHash ? new Date() : null,
          details: {
            ...((tx.details as Record<string, unknown>) ?? {}),
            ...(submission.userOpHash ? { userOpHash: submission.userOpHash } : {}),
          } as any,
        },
      });

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

  private resolveExecutionMode(mode?: ExecutionMode): ExecutionMode {
    return mode ?? 'session_key';
  }

  private assertTransactionPolicy(
    dto: SendTransactionDto,
    context: {
      userId: string;
      chainId: number;
      executionMode: ExecutionMode;
      apiKeyPrefix?: string;
    },
  ): void {
    if (dto.interactions.length > MAX_TRANSACTION_INTERACTIONS) {
      this.rejectTransactionPolicy(
        `Transaction contains too many interactions; maximum is ${MAX_TRANSACTION_INTERACTIONS}`,
        context,
        { interactionCount: dto.interactions.length },
      );
    }

    dto.interactions.forEach((interaction, index) => {
      const value = BigInt(interaction.value ?? '0');
      if (value !== ZERO_NATIVE_VALUE) {
        this.rejectTransactionPolicy(
          'Native value transfers are not allowed for API key transactions',
          context,
          { interactionIndex: index, hasNativeValue: true },
        );
      }

      if (interaction.data.length > 2 && interaction.data.length < 10) {
        this.rejectTransactionPolicy(`Interaction ${index + 1} calldata is too short`, context, {
          interactionIndex: index,
          calldataLength: interaction.data.length,
        });
      }

      const selector = this.getFunctionSelector(interaction.data);
      if (!selector) return;

      if (BLOCKED_PERMIT_SELECTORS.has(selector)) {
        this.rejectTransactionPolicy('Permit signatures are not allowed in transaction calldata', context, {
          interactionIndex: index,
          selector,
        });
      }

      if (selector === ERC20_APPROVE_SELECTOR && this.isMaxUint256Approval(interaction.data)) {
        this.rejectTransactionPolicy('Infinite token approvals are not allowed', context, {
          interactionIndex: index,
          selector,
        });
      }

      if (
        selector === ERC721_ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR &&
        this.isApprovalForAllEnabled(interaction.data)
      ) {
        this.rejectTransactionPolicy('NFT operator approvals are not allowed', context, {
          interactionIndex: index,
          selector,
        });
      }
    });
  }

  private rejectTransactionPolicy(
    reason: string,
    context: {
      userId: string;
      chainId: number;
      executionMode: ExecutionMode;
      apiKeyPrefix?: string;
    },
    extra: Record<string, unknown> = {},
  ): never {
    this.logSecurityWarning({
      message: 'Transaction policy rejected request',
      reason,
      ...context,
      ...extra,
    });
    throw new BadRequestException(reason);
  }

  private getFunctionSelector(data: string): string | null {
    if (data === '0x') return null;
    if (data.length < 10) return null;
    return data.slice(0, 10).toLowerCase();
  }

  private isMaxUint256Approval(data: string): boolean {
    const amountWord = this.getAbiWord(data, 1);
    if (!amountWord) return false;
    return BigInt(`0x${amountWord}`) === MAX_UINT256;
  }

  private isApprovalForAllEnabled(data: string): boolean {
    const approvedWord = this.getAbiWord(data, 1);
    if (!approvedWord) return false;
    return BigInt(`0x${approvedWord}`) !== 0n;
  }

  private getAbiWord(data: string, wordIndex: number): string | null {
    const start = 10 + wordIndex * 64;
    const end = start + 64;
    if (data.length < end) return null;
    return data.slice(start, end);
  }

  private assertWalletReady(wallet: { status: string; walletAddress?: string | null }): void {
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
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
    },
  ): Promise<{ transactionHash: string | null; userOpHash?: string }> {
    if (executionMode === 'eoa') {
      return this.openfort.sendBackendTransaction({
        accountId: params.agentOpenfortAccountId,
        chainId: params.chainId,
        interactions: params.interactions,
      });
    }

    return this.openfort.sendUserOperation({
      agentAccountId: params.agentOpenfortAccountId,
      accountAddress: params.accountAddress,
      chainId: params.chainId,
      keyHash: params.agentKeyHash,
      interactions: params.interactions,
      sponsorship: params.sponsorship,
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

  private toFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Transaction submission failed';
    return message.slice(0, 500);
  }

  private assertPermission(allowed: boolean | undefined, message: string): void {
    if (allowed !== true) {
      throw new ForbiddenException(message);
    }
  }
}

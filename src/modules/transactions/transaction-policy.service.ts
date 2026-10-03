import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  MAX_INTERACTION_CALLDATA_BYTES,
  MAX_TRANSACTION_INTERACTIONS,
  type ExecutionMode,
  type SendTransactionDto,
} from './dto/send-transaction.dto';
import { SecurityEventService } from '../security-events/security-event.service';
import { PrismaService } from '../../core/database/prisma.service';

const MAX_TRANSACTION_CALLDATA_BYTES = 64 * 1024;
const MAX_DISTINCT_TARGETS = 5;

const ERC721_ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR = '0xa22cb465';
const BLOCKED_PERMIT_SELECTORS = new Set([
  '0xd505accf', // ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  '0x8fcbaf0c', // DAI-style permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)
  '0x2b67b570', // Permit2 permit(address,PermitSingle,bytes)
  '0xb7f13ed4', // Permit2 compact/single permit variant
  '0x002a3e3a', // Permit2 permitBatch(address,PermitBatch,bytes)
]);

type TransactionPolicyContext = {
  userId: string;
  chainId: number;
  executionMode: ExecutionMode;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  dailySpendLimit?: string | null;
  monthlySpendLimit?: string | null;
};

const BUDGETED_TRANSACTION_STATUSES = ['submitting', 'pending', 'confirmed', 'unknown', 'needs_review'];

export class TransactionSpendBudgetDenial extends BadRequestException {
  constructor(
    readonly audit: { userId: string; apiKeyId: string; reason: string; metadata: Record<string, string> },
  ) {
    super(audit.reason);
  }
}

@Injectable()
export class TransactionPolicyService {
  private readonly logger = new Logger(TransactionPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents?: SecurityEventService,
  ) {}

  async assertAllowed(dto: SendTransactionDto, context: TransactionPolicyContext): Promise<void> {
    if (dto.interactions.length > MAX_TRANSACTION_INTERACTIONS) {
      await this.reject(
        `Transaction contains too many interactions; maximum is ${MAX_TRANSACTION_INTERACTIONS}`,
        context,
        { interactionCount: dto.interactions.length },
      );
    }

    const totalCalldataBytes = dto.interactions.reduce(
      (total, interaction) => total + this.getCalldataByteLength(interaction.data),
      0,
    );
    if (totalCalldataBytes > MAX_TRANSACTION_CALLDATA_BYTES) {
      await this.reject('Transaction calldata exceeds maximum total size of 64 KB', context, {
        interactionCount: dto.interactions.length,
        totalCalldataBytes,
      });
    }

    const distinctTargets = new Set(
      dto.interactions.map((interaction) => interaction.to.toLowerCase()),
    );
    if (distinctTargets.size > MAX_DISTINCT_TARGETS) {
      await this.reject('Transaction targets too many distinct contracts', context, {
        interactionCount: dto.interactions.length,
        distinctTargetCount: distinctTargets.size,
      });
    }

    for (const [index, interaction] of dto.interactions.entries()) {
      const calldataBytes = this.getCalldataByteLength(interaction.data);
      if (calldataBytes > MAX_INTERACTION_CALLDATA_BYTES) {
        await this.reject(
          `Interaction ${index + 1} calldata exceeds maximum size of 64 KB`,
          context,
          {
            interactionIndex: index,
            calldataBytes,
          },
        );
      }

      if (interaction.data.length > 2 && interaction.data.length < 10) {
        await this.reject(`Interaction ${index + 1} calldata is too short`, context, {
          interactionIndex: index,
          calldataLength: interaction.data.length,
        });
      }

      const selector = this.getFunctionSelector(interaction.data);

      if (!selector) continue;

      if (BLOCKED_PERMIT_SELECTORS.has(selector)) {
        await this.reject('Permit signatures are not allowed in transaction calldata', context, {
          interactionIndex: index,
          selector,
        });
      }

      if (
        selector === ERC721_ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR &&
        this.isApprovalForAllEnabled(interaction.data)
      ) {
        await this.reject('NFT operator approvals are not allowed', context, {
          interactionIndex: index,
          selector,
        });
      }
    }

    await this.recordAllowed(context, {
      interactionCount: dto.interactions.length,
      distinctTargetCount: distinctTargets.size,
      totalCalldataBytes,
    });
  }

  private async recordAllowed(
    context: TransactionPolicyContext,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.securityEvents?.record({
      actorType: 'api_key',
      eventType: 'transaction.policy_allowed',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: 'low',
      result: 'allowed',
      reason: 'transaction_policy_allowed',
      metadata: {
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        hasSpendLimit: Boolean(context.dailySpendLimit || context.monthlySpendLimit),
        ...extra,
      },
    });
  }

  /** Must run after the acceptance transaction has locked this API-key row FOR UPDATE. */
  async assertSpendAllowedInTx(
    tx: Prisma.TransactionClient,
    params: { userId: string; apiKeyId: string; nativeValueWei: string; acceptedAt: Date },
  ): Promise<void> {
    const key = await tx.apiKey.findUnique({
      where: { id: params.apiKeyId },
      select: { userId: true, dailySpendLimit: true, monthlySpendLimit: true },
    });
    if (!key || key.userId !== params.userId) throw new ServiceUnavailableException('API-key spend budget unavailable');
    const current = parseNonnegativeInteger(params.nativeValueWei);
    if (current === null) throw new ServiceUnavailableException('API-key spend budget unavailable');

    for (const [period, limit] of [['daily', key.dailySpendLimit], ['monthly', key.monthlySpendLimit]] as const) {
      if (limit == null) continue;
      const parsedLimit = parseNonnegativeInteger(limit);
      if (parsedLimit === null) throw new ServiceUnavailableException('API-key spend budget unavailable');
      const startsAt = period === 'daily'
        ? new Date(Date.UTC(params.acceptedAt.getUTCFullYear(), params.acceptedAt.getUTCMonth(), params.acceptedAt.getUTCDate()))
        : new Date(Date.UTC(params.acceptedAt.getUTCFullYear(), params.acceptedAt.getUTCMonth(), 1));
      const endsAt = period === 'daily'
        ? new Date(Date.UTC(params.acceptedAt.getUTCFullYear(), params.acceptedAt.getUTCMonth(), params.acceptedAt.getUTCDate() + 1))
        : new Date(Date.UTC(params.acceptedAt.getUTCFullYear(), params.acceptedAt.getUTCMonth() + 1, 1));
      const spent = await this.getSpentInPeriod(tx, params.apiKeyId, startsAt, endsAt);
      if (spent + current > parsedLimit) {
        throw new TransactionSpendBudgetDenial({
          userId: params.userId,
          apiKeyId: params.apiKeyId,
          reason: `Transaction would exceed ${period} spend limit for this API key`,
          metadata: { period, current: current.toString(), spent: spent.toString(), limit: parsedLimit.toString() },
        });
      }
    }
  }

  async recordSpendBudgetDenial(denial: TransactionSpendBudgetDenial): Promise<void> {
    try {
      await this.securityEvents?.record({
        actorType: 'api_key', eventType: 'transaction.policy_denied',
        userId: denial.audit.userId, apiKeyId: denial.audit.apiKeyId,
        riskLevel: 'high', result: 'denied', reason: denial.audit.reason,
        metadata: { ...denial.audit.metadata },
      });
    } catch { /* audit failure must not mask a budget denial */ }
  }

  private async reject(
    reason: string,
    context: TransactionPolicyContext,
    extra: Record<string, unknown> = {},
  ): Promise<never> {
    this.logger.warn({
      event: 'security',
      message: 'Transaction policy rejected request',
      reason,
      ...context,
      ...extra,
    });
    await this.securityEvents?.record({
      actorType: 'api_key',
      eventType: 'transaction.policy_denied',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: 'high',
      result: 'denied',
      reason,
      metadata: {
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        ...extra,
      },
    });
    throw new BadRequestException(reason);
  }

  private getFunctionSelector(data: string): string | null {
    if (data === '0x') return null;
    if (data.length < 10) return null;
    return data.slice(0, 10).toLowerCase();
  }

  private getCalldataByteLength(data: string): number {
    if (data === '0x') return 0;
    return Math.ceil((data.length - 2) / 2);
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

  private async getSpentInPeriod(
    db: Pick<Prisma.TransactionClient, 'transaction'>,
    apiKeyId: string,
    since: Date,
    untilExclusive: Date,
  ): Promise<bigint> {
    const transactions = await db.transaction.findMany({
      where: {
      apiKeyId,
        status: { in: BUDGETED_TRANSACTION_STATUSES },
      createdAt: { gte: since, lt: untilExclusive },
      },
      select: { details: true },
    });

    return transactions.reduce((total, tx) => total + this.extractTransactionValue(tx.details), 0n);
  }

  private extractTransactionValue(details: unknown): bigint {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return 0n;
    const record = details as { nativeValueWei?: unknown; interactions?: unknown };
    if (Object.prototype.hasOwnProperty.call(record, 'nativeValueWei')) {
      const scalar = parseNonnegativeInteger(record.nativeValueWei);
      if (scalar === null) throw new ServiceUnavailableException('API-key spend budget history unavailable');
      return scalar;
    }
    // Legacy rows predate the scalar and generic policy required every call value
    // to be zero. Retain a conservative reader for any historical interaction list.
    if (!Array.isArray(record.interactions)) return 0n;
    return record.interactions.reduce((sum: bigint, interaction: unknown) => {
      if (!interaction || typeof interaction !== 'object') throw new ServiceUnavailableException('API-key spend budget history unavailable');
      const value = (interaction as { value?: unknown }).value;
      if (value === undefined) return sum;
      const parsed = parseNonnegativeInteger(value);
      if (parsed === null || parsed > (1n << 256n) - 1n) throw new ServiceUnavailableException('API-key spend budget history unavailable');
      return sum + parsed;
    }, 0n);
  }
}

function parseNonnegativeInteger(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

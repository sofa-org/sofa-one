import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

type TransactionPolicyContext = {
  userId: string;
  chainId: number;
  executionMode: ExecutionMode;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
  dailySpendLimit?: string | null;
  monthlySpendLimit?: string | null;
};

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

    // Cumulative spend limit check: sum past transactions + current value against limits
    if (context.dailySpendLimit || context.monthlySpendLimit) {
      const now = new Date();
      const totalValue = dto.interactions.reduce(
        (sum, interaction) => sum + BigInt(interaction.value ?? '0'),
        0n,
      );

      if (context.dailySpendLimit) {
        const dailyLimit = BigInt(context.dailySpendLimit);
        const dayStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const dailySpent = await this.getSpentInPeriod(context.apiKeyId, dayStart, null);
        if (dailySpent + totalValue > dailyLimit) {
          await this.reject(
            'Transaction would exceed daily spend limit for this API key',
            context,
            {
              totalValue: totalValue.toString(),
              dailySpent: dailySpent.toString(),
              dailyLimit: context.dailySpendLimit,
            },
          );
        }
      }

      if (context.monthlySpendLimit) {
        const monthlyLimit = BigInt(context.monthlySpendLimit);
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const monthlySpent = await this.getSpentInPeriod(context.apiKeyId, monthStart, null);
        if (monthlySpent + totalValue > monthlyLimit) {
          await this.reject(
            'Transaction would exceed monthly spend limit for this API key',
            context,
            {
              totalValue: totalValue.toString(),
              monthlySpent: monthlySpent.toString(),
              monthlyLimit: context.monthlySpendLimit,
            },
          );
        }
      }
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

      const value = BigInt(interaction.value ?? '0');
      if (value !== ZERO_NATIVE_VALUE) {
        await this.reject(
          'Native value transfers are not allowed for API key transactions',
          context,
          {
            interactionIndex: index,
            hasNativeValue: true,
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

      // Contract allowlist check: if the API key defines allowedContracts, the target must be in the list.
      if (context.allowedContracts && context.allowedContracts.length > 0) {
        const target = interaction.to.toLowerCase();
        if (!context.allowedContracts.some((c) => c.toLowerCase() === target)) {
          await this.reject(
            `Interaction ${index + 1} targets a contract not allowed by this API key`,
            context,
            {
              interactionIndex: index,
              target,
              allowedContractCount: context.allowedContracts.length,
            },
          );
        }
      }

      // Function selector allowlist check: if the API key defines allowedFunctionSelectors, the selector must be in the list.
      if (context.allowedFunctionSelectors && context.allowedFunctionSelectors.length > 0) {
        if (
          !selector ||
          !context.allowedFunctionSelectors.some((s) => s.toLowerCase() === selector)
        ) {
          await this.reject(
            `Interaction ${index + 1} uses a function selector not allowed by this API key`,
            context,
            {
              interactionIndex: index,
              selector,
              allowedSelectorCount: context.allowedFunctionSelectors.length,
            },
          );
        }
      }

      if (!selector) continue;

      if (BLOCKED_PERMIT_SELECTORS.has(selector)) {
        await this.reject('Permit signatures are not allowed in transaction calldata', context, {
          interactionIndex: index,
          selector,
        });
      }

      if (selector === ERC20_APPROVE_SELECTOR && this.isMaxUint256Approval(interaction.data)) {
        await this.reject('Infinite token approvals are not allowed', context, {
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
        hasContractAllowlist: Boolean(context.allowedContracts?.length),
        hasSelectorAllowlist: Boolean(context.allowedFunctionSelectors?.length),
        hasSpendLimit: Boolean(context.dailySpendLimit || context.monthlySpendLimit),
        ...extra,
      },
    });
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

  private async getSpentInPeriod(
    apiKeyId: string | undefined,
    since: Date,
    until: Date | null,
  ): Promise<bigint> {
    if (!apiKeyId) return 0n;

    const where: Record<string, unknown> = {
      apiKeyId,
      status: { in: ['submitting', 'pending', 'confirmed', 'unknown'] },
      createdAt: { gte: since },
    };
    if (until) {
      (where.createdAt as Record<string, unknown>).lte = until;
    }

    const transactions = await this.prisma.transaction.findMany({
      where: where as any,
      select: { details: true },
    });

    return transactions.reduce((total, tx) => total + this.extractTransactionValue(tx.details), 0n);
  }

  private extractTransactionValue(details: unknown): bigint {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return 0n;
    const interactions = (details as { interactions?: unknown }).interactions;
    if (!Array.isArray(interactions)) return 0n;
    return interactions.reduce((sum: bigint, interaction: unknown) => {
      if (!interaction || typeof interaction !== 'object') return sum;
      const value = (interaction as { value?: unknown }).value;
      if (typeof value !== 'string' || !/^\d+$/.test(value)) return sum;
      return sum + BigInt(value);
    }, 0n);
  }
}

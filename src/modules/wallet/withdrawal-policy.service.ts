import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getAddress } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import {
  NATIVE_HIGH_VALUE_AMOUNT,
  NATIVE_MAX_AMOUNT,
  USDC_HIGH_VALUE_AMOUNT,
  USDC_MAX_AMOUNT,
  type WithdrawalToken,
  type WithdrawDto,
} from './dto/withdraw.dto';
import type { CreateWithdrawalAddressDto } from './dto/withdrawal-address.dto';
import { SecurityEventService } from '../security-events/security-event.service';
import {
  isDeferredDestinationPolicyDenial,
  WithdrawalDestinationPolicyService,
  type DeferredDestinationPolicyDenial,
} from '../withdrawal-destination/withdrawal-destination-policy.service';

type WithdrawalPolicyRecord = {
  id: string;
  singleWithdrawalLimit: string;
  dailyWithdrawalLimit: string | null;
  requireAddressAllowlist: boolean;
  newAddressCooldownHours: number;
  requireStepUp: boolean;
};

type WithdrawalAddressRecord = {
  id: string;
  address: string;
  label: string | null;
  availableAt: Date;
  createdAt: Date;
};

type WithdrawalPolicyClient = PrismaService | Prisma.TransactionClient;

const WITHDRAWAL_COUNTED_STATUSES = ['submitting', 'pending', 'confirmed', 'unknown'] as const;

@Injectable()
export class WithdrawalPolicyService {
  private readonly logger = new Logger(WithdrawalPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly destinationPolicy: WithdrawalDestinationPolicyService,
    @Optional()
    private readonly securityEvents?: SecurityEventService,
  ) {}

  async listWithdrawalAddresses(userId: string) {
    const [policy, addresses] = await Promise.all([
      this.getPolicy(userId),
      this.prisma.withdrawalAddress.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }) as Promise<WithdrawalAddressRecord[]>,
    ]);

    return {
      policy: {
        requireAddressAllowlist: policy?.requireAddressAllowlist ?? false,
        newAddressCooldownHours: policy?.newAddressCooldownHours ?? 24,
      },
      addresses: addresses.map((address) => this.toWithdrawalAddressResponse(address)),
    };
  }

  async addWithdrawalAddress(userId: string, dto: CreateWithdrawalAddressDto) {
    const normalizedAddress = this.normalizeAddress(dto.address);
    const label = dto.label?.trim() || null;

    let address: WithdrawalAddressRecord;
    let cooldownHours: number;
    try {
      // BILL-016: hold the shared user destination advisory lock for the whole
      // mutation so send/withdraw acceptance cannot race allowlist writes.
      // No RPC/Openfort inside the lock.
      const created = await this.prisma.$transaction(async (tx) => {
        await this.destinationPolicy.acquireUserDestinationLock(userId, tx);
        const policy = await tx.withdrawalPolicy.upsert({
          where: { userId },
          update: { requireAddressAllowlist: true },
          create: { userId, requireAddressAllowlist: true },
        });
        const availableAt = new Date(
          Date.now() + Math.max(0, policy.newAddressCooldownHours) * 60 * 60 * 1000,
        );
        const row = (await tx.withdrawalAddress.create({
          data: {
            userId,
            address: normalizedAddress,
            label,
            availableAt,
          },
        })) as WithdrawalAddressRecord;
        return { row, cooldownHours: policy.newAddressCooldownHours };
      });
      address = created.row;
      cooldownHours = created.cooldownHours;
    } catch (error: unknown) {
      if (this.isPrismaUniqueConstraintError(error)) {
        throw new BadRequestException('Withdrawal address is already allowlisted');
      }
      throw error;
    }

    this.logger.warn({
      event: 'security',
      message: 'Withdrawal address allowlisted',
      userId,
      withdrawalAddressId: address.id,
      address: normalizedAddress,
      availableAt: address.availableAt.toISOString(),
      cooldownHours,
    });
    await this.recordSecurityEvent({
      eventType: 'withdrawal_address.added',
      userId,
      riskLevel: 'medium',
      result: 'allowed',
      reason: 'withdrawal_address_added',
      metadata: {
        withdrawalAddressId: address.id,
        address: normalizedAddress,
        availableAt: address.availableAt.toISOString(),
        cooldownHours,
      },
    });

    return this.toWithdrawalAddressResponse(address);
  }

  async removeWithdrawalAddress(userId: string, addressId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.destinationPolicy.acquireUserDestinationLock(userId, tx);
      return tx.withdrawalAddress.deleteMany({
        where: { id: addressId, userId },
      });
    });
    if (result.count === 0) {
      throw new BadRequestException('Withdrawal address not found');
    }

    this.logger.warn({
      event: 'security',
      message: 'Withdrawal address removed',
      userId,
      withdrawalAddressId: addressId,
    });
    await this.recordSecurityEvent({
      eventType: 'withdrawal_address.removed',
      userId,
      riskLevel: 'medium',
      result: 'allowed',
      reason: 'withdrawal_address_removed',
      metadata: { withdrawalAddressId: addressId },
    });

    return { success: true };
  }

  /**
   * Shared user-scoped destination advisory lock (BILL-016). Must run inside an
   * interactive transaction. Never perform RPC/Openfort while holding it.
   */
  async acquireUserDestinationLock(
    userId: string,
    prisma: Prisma.TransactionClient,
  ): Promise<void> {
    await this.destinationPolicy.acquireUserDestinationLock(userId, prisma);
  }

  /**
   * Final in-TX destination/cooldown check for withdraw acceptance.
   * Caller should already hold the user destination advisory lock.
   * Fail closed via WithdrawalDestinationPolicyService.
   */
  async assertDestinationAllowedInTx(
    userId: string,
    to: string,
    context: { chainId: number; walletId?: string; walletAddress?: string },
    prisma: WithdrawalPolicyClient,
  ): Promise<void> {
    await this.destinationPolicy.assertDestinationsAllowed(
      userId,
      [to],
      {
        // IAM/dashboard withdraw — never attribute denials to an API key.
        actorType: 'user',
        chainId: context.chainId,
        walletId: context.walletId,
      },
      // Always defer when called under a TX client so no root audit runs while
      // destination advisory / policy row locks are held.
      { prisma, deferAudit: true },
    );
  }

  /** Post-rollback audit for deferred destination denials (wallet withdraw path). */
  async recordDeferredDestinationDenial(err: unknown): Promise<void> {
    if (isDeferredDestinationPolicyDenial(err)) {
      await this.destinationPolicy.recordDeferredDenial(err);
    }
  }

  rethrowDeferredDestinationDenial(err: unknown): never {
    if (isDeferredDestinationPolicyDenial(err)) {
      throw (err as DeferredDestinationPolicyDenial).httpException;
    }
    throw err;
  }

  async assertWithdrawalAllowed(
    userId: string,
    params: WithdrawDto,
    context: {
      chainId: number;
      walletId?: string;
      walletAddress?: string;
      stepUpVerified?: boolean;
    },
    options: { skipDailyLimit?: boolean; prisma?: WithdrawalPolicyClient } = {},
  ): Promise<void> {
    const client = options.prisma ?? this.prisma;
    const policy = await this.getPolicy(userId, client);
    const amount = this.parseAmount(params.amount);
    const defaultSingleLimit = this.getDefaultSingleLimit(params.token);
    const singleLimit = this.parsePositiveLimit(
      policy?.singleWithdrawalLimit,
      defaultSingleLimit,
      'singleWithdrawalLimit',
    );

    // Defense-in-depth: if the user's policy requires step-up, verify it was performed.
    // The controller enforces @RequireStepUp() on the withdraw route, but this check
    // ensures the policy is enforced even if the route decorator is removed or bypassed.
    if (policy?.requireStepUp && !context.stepUpVerified) {
      await this.reject('Withdrawal requires step-up verification', {
        ...context,
        userId,
        policyId: policy.id,
      });
    }

    if (amount > singleLimit) {
      await this.reject('Withdrawal amount exceeds single-withdrawal limit', {
        ...context,
        userId,
        token: params.token,
        amountUnits: params.amount,
        maxAmountUnits: singleLimit.toString(),
        policyId: policy?.id,
      });
    }

    if (!options.skipDailyLimit) {
      await this.assertDailyLimit(userId, params, amount, policy, context, client);
    }
    await this.assertAddressAllowed(userId, params, policy, context, client);

    const highValueThreshold = this.getHighValueThreshold(params.token);
    if (amount >= highValueThreshold) {
      this.logger.warn({
        event: 'security',
        message: 'High-value withdrawal requested',
        userId,
        chainId: context.chainId,
        token: params.token,
        amountUnits: params.amount,
        thresholdUnits: highValueThreshold.toString(),
        policyId: policy?.id,
      });
      await this.recordSecurityEvent({
        eventType: 'withdrawal.high_value_requested',
        userId,
        walletId: context.walletId,
        riskLevel: 'high',
        result: 'allowed',
        reason: 'high_value_withdrawal',
        metadata: {
          chainId: context.chainId,
          token: params.token,
          amountUnits: params.amount,
          thresholdUnits: highValueThreshold.toString(),
          policyId: policy?.id ?? null,
        },
      });
    }
  }

  async assertDailyLimitWithUserLock(
    userId: string,
    params: WithdrawDto,
    context: { chainId: number; walletId?: string; walletAddress?: string },
    prisma: WithdrawalPolicyClient,
  ): Promise<void> {
    await prisma.$queryRaw`SELECT id FROM withdrawal_policies WHERE user_id = ${userId}::uuid FOR UPDATE`;
    const policy = await this.getPolicy(userId, prisma);
    if (!policy?.dailyWithdrawalLimit) return;
    await this.assertDailyLimit(
      userId,
      params,
      this.parseAmount(params.amount),
      policy,
      context,
      prisma,
    );
  }

  private async getPolicy(
    userId: string,
    prisma: WithdrawalPolicyClient = this.prisma,
  ): Promise<WithdrawalPolicyRecord | null> {
    return prisma.withdrawalPolicy.findUnique({
      where: { userId },
    }) as Promise<WithdrawalPolicyRecord | null>;
  }

  private toWithdrawalAddressResponse(address: WithdrawalAddressRecord) {
    const now = new Date();
    return {
      id: address.id,
      address: address.address,
      label: address.label,
      availableAt: address.availableAt,
      createdAt: address.createdAt,
      isAvailable: address.availableAt <= now,
    };
  }

  private normalizeAddress(address: string): string {
    try {
      return getAddress(address).toLowerCase();
    } catch {
      throw new BadRequestException('Invalid Ethereum address');
    }
  }

  private isPrismaUniqueConstraintError(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      (typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'P2002')
    );
  }

  private async assertDailyLimit(
    userId: string,
    params: WithdrawDto,
    amount: bigint,
    policy: WithdrawalPolicyRecord | null,
    context: { chainId: number; walletId?: string; walletAddress?: string },
    prisma: WithdrawalPolicyClient = this.prisma,
  ): Promise<void> {
    if (!policy?.dailyWithdrawalLimit) return;

    const dailyLimit = this.parsePositiveLimit(
      policy.dailyWithdrawalLimit,
      null,
      'dailyWithdrawalLimit',
    );
    const dayStart = this.startOfUtcDay(new Date());
    // BILL-016 Phase 2B (B2): daily limit aggregates withdraw + billing_payment.
    // Settled/historical rows are UTC-day bounded; unresolved active reservations
    // (submitting/pending/unknown) count regardless of createdAt so yesterday's
    // unknown wallet-pay still blocks today's spend.
    const UNRESOLVED = ['submitting', 'pending', 'unknown'] as const;
    const [dayBounded, unresolved] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          userId,
          operationType: { in: ['withdraw', 'billing_payment'] },
          chainId: BigInt(params.chainId),
          status: { in: [...WITHDRAWAL_COUNTED_STATUSES] },
          createdAt: { gte: dayStart },
          details: { path: ['token'], equals: params.token },
        },
        select: { id: true, details: true },
      }),
      prisma.transaction.findMany({
        where: {
          userId,
          operationType: { in: ['withdraw', 'billing_payment'] },
          chainId: BigInt(params.chainId),
          status: { in: [...UNRESOLVED] },
          createdAt: { lt: dayStart },
          details: { path: ['token'], equals: params.token },
        },
        select: { id: true, details: true },
      }),
    ]);
    const seen = new Set<string>();
    let usedToday = 0n;
    for (const row of [...dayBounded, ...unresolved]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      usedToday += this.extractWithdrawalAmount(row.details);
    }
    if (usedToday + amount > dailyLimit) {
      await this.reject('Withdrawal amount exceeds daily withdrawal limit', {
        ...context,
        userId,
        token: params.token,
        amountUnits: params.amount,
        usedTodayUnits: usedToday.toString(),
        dailyLimitUnits: dailyLimit.toString(),
        policyId: policy.id,
      });
    }
  }

  private async assertAddressAllowed(
    userId: string,
    params: WithdrawDto,
    policy: WithdrawalPolicyRecord | null,
    context: { chainId: number; walletId?: string; walletAddress?: string },
    prisma: WithdrawalPolicyClient = this.prisma,
  ): Promise<void> {
    if (policy?.requireAddressAllowlist !== true) return;

    const address = params.to.toLowerCase();
    const allowlisted = (await prisma.withdrawalAddress.findUnique({
      where: { userId_address: { userId, address } },
    })) as WithdrawalAddressRecord | null;

    if (!allowlisted) {
      await this.reject('Withdrawal address is not allowlisted', {
        ...context,
        userId,
        policyId: policy.id,
      });
      return;
    }

    if (allowlisted.availableAt > new Date()) {
      await this.reject('Withdrawal address is still in cooldown', {
        ...context,
        userId,
        policyId: policy.id,
        availableAt: allowlisted.availableAt.toISOString(),
        cooldownHours: policy.newAddressCooldownHours,
      });
    }
  }

  private parseAmount(value: string): bigint {
    try {
      return BigInt(value);
    } catch {
      throw new BadRequestException('Withdrawal amount must be a valid integer');
    }
  }

  private parsePositiveLimit(
    value: string | null | undefined,
    fallback: bigint | null,
    field: string,
  ): bigint {
    if (!value) {
      if (fallback !== null) return fallback;
      throw new BadRequestException(`Withdrawal policy ${field} is not configured`);
    }
    const parsed = this.parseAmount(value);
    if (parsed <= 0n) {
      throw new BadRequestException(`Withdrawal policy ${field} must be positive`);
    }
    return parsed;
  }

  private extractWithdrawalAmount(details: unknown): bigint {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return 0n;
    const amount = (details as { amount?: unknown }).amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return 0n;
    return BigInt(amount);
  }

  private getDefaultSingleLimit(token: WithdrawalToken): bigint {
    return token === 'NATIVE' ? NATIVE_MAX_AMOUNT : USDC_MAX_AMOUNT;
  }

  private getHighValueThreshold(token: WithdrawalToken): bigint {
    return token === 'NATIVE' ? NATIVE_HIGH_VALUE_AMOUNT : USDC_HIGH_VALUE_AMOUNT;
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  private async reject(reason: string, context: Record<string, unknown>): Promise<never> {
    this.logger.warn({
      event: 'security',
      message: 'Withdrawal policy rejected request',
      reason,
      ...context,
    });
    await this.recordSecurityEvent({
      eventType: 'withdrawal.policy_denied',
      userId: typeof context.userId === 'string' ? context.userId : undefined,
      walletId: typeof context.walletId === 'string' ? context.walletId : undefined,
      riskLevel: 'high',
      result: 'denied',
      reason,
      metadata: this.toSafeMetadata(context),
    });
    throw new BadRequestException(reason);
  }

  private async recordSecurityEvent(input: {
    eventType: string;
    userId?: string;
    walletId?: string;
    riskLevel: 'medium' | 'high';
    result: 'allowed' | 'denied';
    reason: string;
    metadata: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.securityEvents?.record({
        actorType: 'user',
        ...input,
      });
    } catch (error) {
      this.logger.error('Withdrawal security event recording failed', error);
    }
  }

  private toSafeMetadata(context: Record<string, unknown>): Prisma.InputJsonObject {
    const metadata: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) continue;
      if (typeof value === 'bigint') {
        metadata[key] = value.toString();
      } else if (value instanceof Date) {
        metadata[key] = value.toISOString();
      } else if (value === null) {
        continue;
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        metadata[key] = value;
      }
    }
    return metadata as Prisma.InputJsonObject;
  }
}

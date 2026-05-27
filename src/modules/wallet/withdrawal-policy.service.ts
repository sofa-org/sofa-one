import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getAddress } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { USDC_HIGH_VALUE_AMOUNT, USDC_MAX_AMOUNT, type WithdrawDto } from './dto/withdraw.dto';
import type { CreateWithdrawalAddressDto } from './dto/withdrawal-address.dto';
import { SecurityEventService } from '../security-events/security-event.service';

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

const WITHDRAWAL_COUNTED_STATUSES = ['submitting', 'pending', 'confirmed', 'unknown'] as const;

@Injectable()
export class WithdrawalPolicyService {
  private readonly logger = new Logger(WithdrawalPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
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
    const policy = await this.prisma.withdrawalPolicy.upsert({
      where: { userId },
      update: { requireAddressAllowlist: true },
      create: { userId, requireAddressAllowlist: true },
    });
    const availableAt = new Date(
      Date.now() + Math.max(0, policy.newAddressCooldownHours) * 60 * 60 * 1000,
    );

    try {
      const address = (await this.prisma.withdrawalAddress.create({
        data: {
          userId,
          address: normalizedAddress,
          label,
          availableAt,
        },
      })) as WithdrawalAddressRecord;

      this.logger.warn({
        event: 'security',
        message: 'Withdrawal address allowlisted',
        userId,
        withdrawalAddressId: address.id,
        address: normalizedAddress,
        availableAt: address.availableAt.toISOString(),
        cooldownHours: policy.newAddressCooldownHours,
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
          cooldownHours: policy.newAddressCooldownHours,
        },
      });

      return this.toWithdrawalAddressResponse(address);
    } catch (error: unknown) {
      if (this.isPrismaUniqueConstraintError(error)) {
        throw new BadRequestException('Withdrawal address is already allowlisted');
      }
      throw error;
    }
  }

  async removeWithdrawalAddress(userId: string, addressId: string) {
    const result = await this.prisma.withdrawalAddress.deleteMany({
      where: { id: addressId, userId },
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

  async assertWithdrawalAllowed(
    userId: string,
    params: WithdrawDto,
    context: { chainId: number; walletId?: string; walletAddress?: string },
  ): Promise<void> {
    const policy = await this.getPolicy(userId);
    const amount = this.parseAmount(params.amount);
    const singleLimit = this.parsePositiveLimit(
      policy?.singleWithdrawalLimit,
      USDC_MAX_AMOUNT,
      'singleWithdrawalLimit',
    );

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

    await this.assertDailyLimit(userId, params, amount, policy, context);
    await this.assertAddressAllowed(userId, params, policy, context);

    if (amount >= USDC_HIGH_VALUE_AMOUNT) {
      this.logger.warn({
        event: 'security',
        message: 'High-value withdrawal requested',
        userId,
        chainId: context.chainId,
        token: params.token,
        amountUnits: params.amount,
        thresholdUnits: USDC_HIGH_VALUE_AMOUNT.toString(),
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
          thresholdUnits: USDC_HIGH_VALUE_AMOUNT.toString(),
          policyId: policy?.id ?? null,
        },
      });
    }
  }

  private async getPolicy(userId: string): Promise<WithdrawalPolicyRecord | null> {
    return this.prisma.withdrawalPolicy.findUnique({ where: { userId } }) as Promise<WithdrawalPolicyRecord | null>;
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

  private isPrismaUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002')
    );
  }

  private async assertDailyLimit(
    userId: string,
    params: WithdrawDto,
    amount: bigint,
    policy: WithdrawalPolicyRecord | null,
    context: { chainId: number; walletId?: string; walletAddress?: string },
  ): Promise<void> {
    if (!policy?.dailyWithdrawalLimit) return;

    const dailyLimit = this.parsePositiveLimit(policy.dailyWithdrawalLimit, null, 'dailyWithdrawalLimit');
    const dayStart = this.startOfUtcDay(new Date());
    const withdrawals = await this.prisma.transaction.findMany({
      where: {
        userId,
        operationType: 'withdraw',
        chainId: BigInt(params.chainId),
        status: { in: [...WITHDRAWAL_COUNTED_STATUSES] },
        createdAt: { gte: dayStart },
      },
      select: { details: true },
    });

    const usedToday = withdrawals.reduce((total, tx) => total + this.extractWithdrawalAmount(tx.details), 0n);
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
  ): Promise<void> {
    if (policy?.requireAddressAllowlist !== true) return;

    const address = params.to.toLowerCase();
    const allowlisted = (await this.prisma.withdrawalAddress.findUnique({
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

  private parsePositiveLimit(value: string | null | undefined, fallback: bigint | null, field: string): bigint {
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

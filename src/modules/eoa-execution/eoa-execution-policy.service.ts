import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { IpAllowlistService } from '../../common/guards/ip-allowlist.service';
import { SecurityEventService } from '../security-events/security-event.service';

const EOA_EXECUTION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EOA_EXECUTION_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const EOA_EXECUTION_RATE_LIMIT_COUNT = 1;

type EoaPolicyPrismaClient = {
  securityEvent: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
};

export type EoaExecutionOperation = 'sign' | 'send_transaction' | 'polymarket_order_sign';
export type EoaPrerequisiteOperation = 'polymarket_order_sign';

export type EoaExecutionPolicyContext = {
  operation: EoaExecutionOperation;
  userId: string;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  allowedIps?: string[] | null;
  clientIp?: string;
  expiresAt?: Date | string | null;
  chainId: number;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class EoaExecutionPolicyService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
    @Optional() private readonly ipAllowlist?: IpAllowlistService,
  ) {}

  async assertAllowed(context: EoaExecutionPolicyContext): Promise<void> {
    await this.assertPrerequisites(context);

    const recentAllowedCount = await (this.prisma as unknown as EoaPolicyPrismaClient).securityEvent.count({
      where: {
        apiKeyId: context.apiKeyId ?? undefined,
        eventType: 'eoa_execution_allowed',
        createdAt: { gt: new Date(Date.now() - EOA_EXECUTION_RATE_LIMIT_WINDOW_MS) },
      },
    });
    if (recentAllowedCount >= EOA_EXECUTION_RATE_LIMIT_COUNT) {
      await this.recordDecision(context, 'denied', 'eoa_execution_rate_limited');
      throw new ForbiddenException('EOA execution rate limit exceeded');
    }

    await this.recordDecision(context, 'allowed', 'eoa_execution_allowed');
  }

  /**
   * Validate EOA opt-in, IP allowlisting and short TTL without consuming the
   * generic one-per-minute EOA budget. Only the wallet Polymarket-order path
   * should call this method; it deliberately does not record an allowed event.
   */
  async assertPolymarketOrderPrerequisites(
    context: Omit<EoaExecutionPolicyContext, 'operation'> & { operation: EoaPrerequisiteOperation },
  ): Promise<void> {
    await this.assertPrerequisites(context);
  }

  private async assertPrerequisites(
    context: EoaExecutionPolicyContext,
  ): Promise<void> {
    if (!this.isGloballyEnabled()) {
      await this.recordDecision(context, 'denied', 'eoa_execution_disabled');
      throw new ForbiddenException('EOA execution is disabled');
    }

    if (!context.allowedIps?.length) {
      await this.recordDecision(context, 'denied', 'eoa_execution_requires_ip_allowlist');
      throw new ForbiddenException('EOA execution requires an API key IP allowlist');
    }

    if (!context.clientIp) {
      await this.recordDecision(context, 'denied', 'eoa_execution_requires_request_ip');
      throw new ForbiddenException('EOA execution requires a verifiable request IP');
    }

    if (!this.ipAllowlist) {
      await this.recordDecision(context, 'denied', 'eoa_execution_ip_allowlist_unavailable');
      throw new ForbiddenException('EOA execution IP allowlist validation is unavailable');
    }

    await this.ipAllowlist.assertIpAllowed(context.clientIp, context.allowedIps, {
      actorType: 'api_key',
      apiKeyId: context.apiKeyId ?? undefined,
      apiKeyPrefix: context.apiKeyPrefix ?? undefined,
      userId: context.userId,
      clientIp: context.clientIp,
      allowedIpCount: context.allowedIps.length,
    });

    if (!this.hasShortTtl(context.expiresAt)) {
      await this.recordDecision(context, 'denied', 'eoa_execution_requires_short_ttl');
      throw new ForbiddenException('EOA execution requires an API key TTL of 30 days or less');
    }

  }

  private isGloballyEnabled(): boolean {
    return this.config.get<string>('EOA_EXECUTION_ENABLED') === 'true';
  }

  private hasShortTtl(expiresAt: Date | string | null | undefined): boolean {
    if (!expiresAt) return false;
    const expires = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(expires.getTime())) return false;
    const remainingMs = expires.getTime() - Date.now();
    return remainingMs > 0 && remainingMs <= EOA_EXECUTION_MAX_TTL_MS;
  }

  private recordDecision(
    context: EoaExecutionPolicyContext,
    result: 'allowed' | 'denied',
    reason: string,
  ) {
    return this.securityEvents.record({
      actorType: 'api_key',
      eventType: result === 'allowed' ? 'eoa_execution_allowed' : 'eoa_execution_denied',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: result === 'allowed' ? 'high' : 'critical',
      result,
      reason,
      metadata: {
        operation: context.operation,
        chainId: context.chainId,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        ...(context.metadata && typeof context.metadata === 'object' && !Array.isArray(context.metadata)
          ? context.metadata
          : {}),
      },
    });
  }
}

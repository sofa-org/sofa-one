/**
 * Destination/cooldown-only leaf for API-key direct egress (BILL-016).
 *
 * Reuses WithdrawalPolicy / WithdrawalAddress rows but does NOT depend on
 * WalletModule, step-up, amount limits, or secrets. When
 * `requireAddressAllowlist` is not true (missing policy or disabled),
 * destinations are allowed (existing allow-all). DB failures fail closed (503).
 *
 * **Audit locking:** when `deferAudit: true` (inner acceptance TX that already
 * holds api_keys FOR UPDATE / destination advisory locks), denials throw
 * `DeferredDestinationPolicyDenial` **without** writing security_events.
 * Callers must `recordDeferredDenial` on the root client **after** TX rollback
 * so FK key-share locks cannot deadlock against ApiKey FOR UPDATE.
 */
import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getAddress, isAddress } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import { SecurityEventService } from '../security-events/security-event.service';

type DestinationClient = PrismaService | Prisma.TransactionClient;

/** Who triggered the destination check — drives denial audit actorType. */
export type DestinationPolicyActorType = 'api_key' | 'user';

export type DestinationPolicyContext = {
  /**
   * Audit actor for denials. Defaults to `api_key` (API-key send path).
   * Wallet/IAM withdraw must pass `user` and must not set apiKey* fields.
   */
  actorType?: DestinationPolicyActorType;
  chainId?: number;
  walletId?: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  executionMode?: string;
};

export type DestinationDenialAuditPayload = {
  actorType: DestinationPolicyActorType;
  userId: string;
  apiKeyId?: string;
  walletId?: string;
  reason: string;
  metadata: Prisma.InputJsonObject;
};

/**
 * Thrown instead of Forbidden/503 when `deferAudit: true`. Carries the stable
 * HTTP exception plus sanitized audit context for post-rollback recording.
 */
export class DeferredDestinationPolicyDenial extends Error {
  readonly name = 'DeferredDestinationPolicyDenial';
  constructor(
    readonly httpException: HttpException,
    readonly audit: DestinationDenialAuditPayload,
  ) {
    super('deferred_destination_policy_denial');
  }
}

export function isDeferredDestinationPolicyDenial(
  err: unknown,
): err is DeferredDestinationPolicyDenial {
  return err instanceof DeferredDestinationPolicyDenial;
}

@Injectable()
export class WithdrawalDestinationPolicyService {
  private readonly logger = new Logger(WithdrawalDestinationPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * User-scoped advisory lock so destination policy reads cannot race with
   * allowlist mutations even when no withdrawal_policies row exists yet.
   * Must be called inside an interactive transaction; holds until commit/rollback.
   * Never perform RPC/Openfort/root audit while holding this lock.
   */
  async acquireUserDestinationLock(userId: string, db: Prisma.TransactionClient): Promise<void> {
    const key = `withdrawal_dest:${userId}`;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * Assert every destination is allowlisted and past cooldown when the user's
   * address allowlist policy is enabled. Empty destination list is a no-op.
   * Self-transfers must be filtered by the caller before invoking this.
   *
   * @param options.deferAudit When true (inner acceptance TX), never writes
   *   security_events; throws DeferredDestinationPolicyDenial for the caller
   *   to record after locks are released.
   */
  async assertDestinationsAllowed(
    userId: string,
    destinations: readonly string[],
    context: DestinationPolicyContext = {},
    options: { prisma?: DestinationClient; deferAudit?: boolean } = {},
  ): Promise<void> {
    if (destinations.length === 0) return;

    const client = options.prisma ?? this.prisma;
    const deferAudit = options.deferAudit === true;
    let policy: {
      id: string;
      requireAddressAllowlist: boolean;
      newAddressCooldownHours: number;
    } | null;

    try {
      policy = await client.withdrawalPolicy.findUnique({
        where: { userId },
        select: {
          id: true,
          requireAddressAllowlist: true,
          newAddressCooldownHours: true,
        },
      });
    } catch (err) {
      this.logger.error(
        {
          message: 'Destination policy lookup failed',
          userId,
          apiKeyPrefix: context.apiKeyPrefix,
        },
        err instanceof Error ? err.stack : undefined,
      );
      return await this.deny(
        userId,
        'Withdrawal destination policy is temporarily unavailable',
        API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE,
        context,
        deferAudit,
        503,
      );
    }

    // Policy missing or allowlist not required → existing allow-all.
    if (!policy || policy.requireAddressAllowlist !== true) {
      return;
    }

    let normalized: string[];
    try {
      normalized = destinations.map((d) => this.normalizeDestination(d));
    } catch (err) {
      if (err instanceof ForbiddenException) {
        return await this.deny(
          userId,
          'Withdrawal address is not allowlisted',
          API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
          { ...context, policyId: policy.id },
          deferAudit,
          403,
        );
      }
      throw err;
    }
    const unique = [...new Set(normalized)];

    for (const address of unique) {
      let row: { availableAt: Date } | null;
      try {
        row = await client.withdrawalAddress.findUnique({
          where: { userId_address: { userId, address } },
          select: { availableAt: true },
        });
      } catch (err) {
        this.logger.error(
          {
            message: 'Destination allowlist lookup failed',
            userId,
            apiKeyPrefix: context.apiKeyPrefix,
          },
          err instanceof Error ? err.stack : undefined,
        );
        return await this.deny(
          userId,
          'Withdrawal destination policy is temporarily unavailable',
          API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE,
          context,
          deferAudit,
          503,
        );
      }

      if (!row) {
        return await this.deny(
          userId,
          'Withdrawal address is not allowlisted',
          API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
          {
            ...context,
            policyId: policy.id,
            addressPrefix: address.slice(0, 10),
          },
          deferAudit,
          403,
        );
      }

      if (row.availableAt.getTime() > Date.now()) {
        return await this.deny(
          userId,
          'Withdrawal address is still in cooldown',
          API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN,
          {
            ...context,
            policyId: policy.id,
            addressPrefix: address.slice(0, 10),
            availableAt: row.availableAt.toISOString(),
            cooldownHours: policy.newAddressCooldownHours,
          },
          deferAudit,
          403,
        );
      }
    }
  }

  /**
   * Record a single deferred denial on the root path after locks are released.
   * Failures are logged and swallowed so the original HTTP denial still surfaces.
   */
  async recordDeferredDenial(denial: DeferredDestinationPolicyDenial): Promise<void> {
    try {
      await this.securityEvents?.record({
        actorType: denial.audit.actorType,
        userId: denial.audit.userId,
        apiKeyId: denial.audit.apiKeyId,
        walletId: denial.audit.walletId,
        eventType: 'transaction.destination_policy_denied',
        riskLevel: 'high',
        result: 'denied',
        reason: denial.audit.reason,
        metadata: denial.audit.metadata,
      });
    } catch (err) {
      this.logger.warn({
        message: 'Deferred destination denial audit failed',
        userId: denial.audit.userId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  private normalizeDestination(address: string): string {
    if (!isAddress(address, { strict: false })) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        message: 'Withdrawal address is not allowlisted',
      });
    }
    try {
      return getAddress(address).toLowerCase();
    } catch {
      return `0x${address.trim().slice(2).toLowerCase()}`;
    }
  }

  private async deny(
    userId: string,
    message: string,
    code: string,
    metadata: Record<string, unknown>,
    deferAudit: boolean,
    status: 403 | 503,
  ): Promise<never> {
    const actorType: DestinationPolicyActorType =
      metadata.actorType === 'user' ? 'user' : 'api_key';

    const eventMetadata: Prisma.InputJsonObject = {
      code,
      ...(typeof metadata.chainId === 'number' ? { chainId: metadata.chainId } : {}),
      ...(typeof metadata.addressPrefix === 'string'
        ? { addressPrefix: metadata.addressPrefix }
        : {}),
      ...(typeof metadata.policyId === 'string' ? { policyId: metadata.policyId } : {}),
      ...(typeof metadata.availableAt === 'string' ? { availableAt: metadata.availableAt } : {}),
      ...(typeof metadata.cooldownHours === 'number'
        ? { cooldownHours: metadata.cooldownHours }
        : {}),
      ...(actorType === 'api_key' && typeof metadata.apiKeyPrefix === 'string'
        ? { apiKeyPrefix: metadata.apiKeyPrefix }
        : {}),
      ...(actorType === 'api_key' && typeof metadata.executionMode === 'string'
        ? { executionMode: metadata.executionMode }
        : {}),
    };

    const audit: DestinationDenialAuditPayload = {
      actorType,
      userId,
      apiKeyId:
        actorType === 'api_key' && typeof metadata.apiKeyId === 'string'
          ? metadata.apiKeyId
          : undefined,
      walletId: typeof metadata.walletId === 'string' ? metadata.walletId : undefined,
      reason: message,
      metadata: eventMetadata,
    };

    const httpException =
      status === 503
        ? new ServiceUnavailableException({ code, message })
        : new ForbiddenException({ code, message });

    if (deferAudit) {
      throw new DeferredDestinationPolicyDenial(httpException, audit);
    }

    try {
      await this.securityEvents?.record({
        actorType: audit.actorType,
        userId: audit.userId,
        apiKeyId: audit.apiKeyId,
        walletId: audit.walletId,
        eventType: 'transaction.destination_policy_denied',
        riskLevel: 'high',
        result: 'denied',
        reason: audit.reason,
        metadata: audit.metadata,
      });
    } catch {
      // Audit must not block the deny path.
    }

    throw httpException;
  }
}

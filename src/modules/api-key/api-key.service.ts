import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { getApiKeyPrefix } from '../../common/api-key/api-key-prefix';
import { SecurityEventService } from '../security-events/security-event.service';

const MAX_ACTIVE_API_KEYS = 10;
const DEFAULT_API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_API_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Maximum TTL per permission level.
 * The most restrictive high-risk permission determines the cap.
 * Read-only keys (canReadTransactionStatus only) get the full 365-day window.
 */
const PERMISSION_MAX_TTL_MS: Record<string, number> = {
  canUseEoaExecution: 30 * 24 * 60 * 60 * 1000, // 30 days
  canSign: 90 * 24 * 60 * 60 * 1000, // 90 days
  canSendTransaction: 90 * 24 * 60 * 60 * 1000, // 90 days
  canReadTransactionStatus: 365 * 24 * 60 * 60 * 1000, // 365 days (read-only default)
};

const HIGH_RISK_PERMISSIONS: (keyof ApiKeyPermissions)[] = [
  'canSign',
  'canSendTransaction',
  'canUseEoaExecution',
];

type ApiKeyCreateOptions = {
  name: string;
  expiresAt?: string | Date;
  allowedIps?: string[];
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
  spendLimits?: { daily?: string; monthly?: string };
  permissions?: Partial<ApiKeyPermissions>;
};

export type ApiKeyPermissions = {
  canSign: boolean;
  canSendTransaction: boolean;
  canReadTransactionStatus: boolean;
  canUseEoaExecution: boolean;
};

export type ApiKeySpendLimits = {
  daily?: string | null;
  monthly?: string | null;
};

const DEFAULT_API_KEY_PERMISSIONS: ApiKeyPermissions = {
  canSign: false,
  canSendTransaction: false,
  canReadTransactionStatus: true,
  canUseEoaExecution: false,
};

type PrismaTransaction = Prisma.TransactionClient;

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  /**
   * Generate a new API key for the given user.
   * Returns the raw key **once** — it cannot be recovered after this call.
   */
  async createApiKey(userId: string, options: ApiKeyCreateOptions) {
    const normalized = this.normalizeCreateOptions(options);
    const keyMaterial = await this.generateKeyMaterial();

    const createdKey = await this.prisma.$transaction(async (tx) => {
      await this.assertCanCreateKey(tx, userId, normalized.name);

      const created = await tx.apiKey.create({
        data: {
          userId,
          apiKeyHash: keyMaterial.hash,
          keyPrefix: keyMaterial.keyPrefix,
          name: normalized.name,
          expiresAt: normalized.expiresAt,
          allowedIps: normalized.allowedIps,
          allowedContracts: normalized.allowedContracts,
          allowedFunctionSelectors: normalized.allowedFunctionSelectors,
          dailySpendLimit: normalized.dailySpendLimit,
          monthlySpendLimit: normalized.monthlySpendLimit,
          ...normalized.permissions,
        },
      });

      await this.audit(tx, userId, created.id, 'api_key.created', {
        keyPrefix: created.keyPrefix,
        keyName: created.name,
        metadata: {
          allowedIps: created.allowedIps,
          expiresAt: created.expiresAt?.toISOString() ?? null,
          permissions: this.toPermissions(created),
        },
      });

      return created;
    });

    return {
      rawKey: keyMaterial.rawKey,
      id: createdKey.id,
      displayPrefix: this.toDisplayPrefix(createdKey.keyPrefix),
      name: createdKey.name,
      expiresAt: createdKey.expiresAt,
      createdAt: createdKey.createdAt,
      permissions: this.toPermissions(createdKey),
    };
  }

  /** Revoke a single API key owned by the user. */
  async revokeApiKey(keyId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      // BILL-016: FOR UPDATE serializes with direct-egress send acceptance which
      // locks the same api_keys row before reading live reauth/revoke state.
      const locked = await tx.$queryRaw<
        Array<{ id: string; key_prefix: string | null; name: string | null; revoked: boolean }>
      >`
        SELECT "id", "key_prefix", "name", "revoked"
        FROM "api_keys"
        WHERE "id" = ${keyId}::uuid AND "user_id" = ${userId}::uuid
        FOR UPDATE`;
      const existing = locked[0];
      if (!existing) {
        throw new NotFoundException('API key not found');
      }
      if (existing.revoked) {
        return { count: 0 };
      }

      const result = await tx.apiKey.updateMany({
        where: { id: keyId, userId, revoked: false },
        data: { revoked: true },
      });

      await this.audit(tx, userId, existing.id, 'api_key.revoked', {
        keyPrefix: existing.key_prefix,
        keyName: existing.name,
      });

      return result;
    });
  }

  /** Revoke every active key for a user (used during key refresh). */
  async revokeAllKeys(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const activeKeys = await tx.apiKey.findMany({
        where: { userId, revoked: false },
        select: { id: true, keyPrefix: true, name: true },
      });
      const result = await tx.apiKey.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });

      for (const key of activeKeys) {
        await this.audit(tx, userId, key.id, 'api_key.revoked', {
          keyPrefix: key.keyPrefix,
          keyName: key.name,
          metadata: { reason: 'bulk_revoke' },
        });
      }

      return result;
    });
  }

  /** Atomically revoke all active keys and issue a replacement key. */
  async rotateApiKey(userId: string, name: string) {
    const normalized = this.normalizeCreateOptions({ name });
    const keyMaterial = await this.generateKeyMaterial();

    const createdKey = await this.prisma.$transaction(async (tx) => {
      const activeKeys = await tx.apiKey.findMany({
        where: { userId, revoked: false },
        select: { id: true, keyPrefix: true, name: true },
      });

      await tx.apiKey.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });

      for (const key of activeKeys) {
        await this.audit(tx, userId, key.id, 'api_key.revoked', {
          keyPrefix: key.keyPrefix,
          keyName: key.name,
          metadata: { reason: 'rotation' },
        });
      }

      const created = await tx.apiKey.create({
        data: {
          userId,
          apiKeyHash: keyMaterial.hash,
          keyPrefix: keyMaterial.keyPrefix,
          name: normalized.name,
          expiresAt: normalized.expiresAt,
          allowedIps: [],
          ...normalized.permissions,
        },
      });

      await this.audit(tx, userId, created.id, 'api_key.rotated', {
        keyPrefix: created.keyPrefix,
        keyName: created.name,
        metadata: {
          revokedKeyCount: activeKeys.length,
          expiresAt: created.expiresAt?.toISOString() ?? null,
          permissions: this.toPermissions(created),
        },
      });

      return created;
    });

    return {
      rawKey: keyMaterial.rawKey,
      id: createdKey.id,
      displayPrefix: this.toDisplayPrefix(createdKey.keyPrefix),
      name: createdKey.name,
      expiresAt: createdKey.expiresAt,
      createdAt: createdKey.createdAt,
      permissions: this.toPermissions(createdKey),
    };
  }

  /** List all API keys (metadata only — no secrets). */
  async listApiKeys(userId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        revoked: true,
        frozenAt: true,
        frozenReason: true,
        expiresAt: true,
        createdAt: true,
        lastUsedAt: true,
        lastUsedIp: true,
        lastUsedUserAgent: true,
        canSign: true,
        canSendTransaction: true,
        canReadTransactionStatus: true,
        canUseEoaExecution: true,
        allowedIps: true,
        allowedContracts: true,
        allowedFunctionSelectors: true,
        dailySpendLimit: true,
        monthlySpendLimit: true,
        directEgressPolicyAcceptedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return keys.map((key) => ({
      id: key.id,
      displayPrefix: this.toDisplayPrefix(key.keyPrefix),
      name: key.name,
      revoked: key.revoked,
      frozenAt: key.frozenAt,
      frozenReason: key.frozenReason,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      lastUsedIp: key.lastUsedIp,
      lastUsedUserAgent: key.lastUsedUserAgent,
      permissions: this.toPermissions(key),
      allowedIps: key.allowedIps,
      allowedContracts: key.allowedContracts,
      allowedFunctionSelectors: key.allowedFunctionSelectors,
      dailySpendLimit: key.dailySpendLimit,
      monthlySpendLimit: key.monthlySpendLimit,
      directEgressPolicyAcceptedAt: key.directEgressPolicyAcceptedAt,
    }));
  }

  /**
   * BILL-016: acknowledge destination-policy binding for API-key direct egress.
   * IAM + FrontendOnly + StepUp (controller). Idempotent CAS: already-accepted
   * keys return success without rewriting. Never auto-set on create/rotate.
   */
  async authorizeDirectEgress(keyId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Same row FOR UPDATE as send acceptance / revoke so state transitions serialize.
      type LockedKey = {
        id: string;
        key_prefix: string | null;
        name: string | null;
        revoked: boolean;
        frozen_at: Date | null;
        expires_at: Date | null;
        can_send_transaction: boolean;
        direct_egress_policy_accepted_at: Date | null;
      };
      const locked = await tx.$queryRaw<LockedKey[]>`
        SELECT
          "id",
          "key_prefix",
          "name",
          "revoked",
          "frozen_at",
          "expires_at",
          "can_send_transaction",
          "direct_egress_policy_accepted_at"
        FROM "api_keys"
        WHERE "id" = ${keyId}::uuid AND "user_id" = ${userId}::uuid
        FOR UPDATE`;
      const existing = locked[0];
      if (!existing) {
        throw new NotFoundException('API key not found');
      }
      if (existing.revoked) {
        throw new ForbiddenException('API key is revoked');
      }
      if (existing.frozen_at) {
        throw new ForbiddenException('API key is frozen');
      }
      if (existing.expires_at && existing.expires_at.getTime() <= Date.now()) {
        throw new ForbiddenException('API key is expired');
      }
      if (!existing.can_send_transaction) {
        throw new ForbiddenException({
          code: API_ERROR_CODES.BAD_REQUEST,
          message: 'API key is not allowed to send transactions',
        });
      }

      if (existing.direct_egress_policy_accepted_at) {
        return {
          id: existing.id,
          directEgressPolicyAcceptedAt: existing.direct_egress_policy_accepted_at,
          outcome: 'unchanged' as const,
        };
      }

      const acceptedAt = new Date();
      const result = await tx.apiKey.updateMany({
        where: {
          id: keyId,
          userId,
          revoked: false,
          frozenAt: null,
          canSendTransaction: true,
          directEgressPolicyAcceptedAt: null,
        },
        data: { directEgressPolicyAcceptedAt: acceptedAt },
      });

      if (result.count === 0) {
        const again = await tx.$queryRaw<Array<{ direct_egress_policy_accepted_at: Date | null }>>`
          SELECT "direct_egress_policy_accepted_at"
          FROM "api_keys"
          WHERE "id" = ${keyId}::uuid AND "user_id" = ${userId}::uuid`;
        if (again[0]?.direct_egress_policy_accepted_at) {
          return {
            id: existing.id,
            directEgressPolicyAcceptedAt: again[0].direct_egress_policy_accepted_at,
            outcome: 'unchanged' as const,
          };
        }
        throw new ForbiddenException('API key cannot authorize direct egress in its current state');
      }

      await this.audit(tx, userId, existing.id, 'api_key.direct_egress_authorized', {
        keyPrefix: existing.key_prefix,
        keyName: existing.name,
        metadata: {
          directEgressPolicyAcceptedAt: acceptedAt.toISOString(),
        },
      });

      return {
        id: existing.id,
        directEgressPolicyAcceptedAt: acceptedAt,
        outcome: 'authorized' as const,
      };
    });
  }

  private normalizeCreateOptions(options: ApiKeyCreateOptions) {
    const name = options.name?.trim();
    if (!name) {
      throw new BadRequestException('API key name is required');
    }

    const permissions = this.normalizePermissions(options.permissions);
    const allowedIps = options.allowedIps ?? [];
    const allowedContracts = this.normalizeAddresses(options.allowedContracts);
    const allowedFunctionSelectors = this.normalizeSelectors(options.allowedFunctionSelectors);
    const { dailySpendLimit, monthlySpendLimit } = this.normalizeSpendLimits(options.spendLimits);

    this.assertIpAllowlistForHighRiskPermissions(permissions, allowedIps);

    const expiresAt = this.normalizeExpiresAt(options.expiresAt, permissions);

    return {
      name,
      expiresAt,
      allowedIps,
      allowedContracts,
      allowedFunctionSelectors,
      dailySpendLimit,
      monthlySpendLimit,
      permissions,
    };
  }

  private normalizePermissions(permissions?: Partial<ApiKeyPermissions>): ApiKeyPermissions {
    return {
      ...DEFAULT_API_KEY_PERMISSIONS,
      ...(permissions ?? {}),
    };
  }

  /** Normalize and lowercase Ethereum addresses for contract allowlist. */
  private normalizeAddresses(addresses?: string[]): string[] {
    if (!addresses || addresses.length === 0) return [];
    return addresses.map((addr) => addr.toLowerCase());
  }

  /** Normalize and lowercase function selectors (0x + 8 hex chars). */
  private normalizeSelectors(selectors?: string[]): string[] {
    if (!selectors || selectors.length === 0) return [];
    return selectors.map((s) => s.toLowerCase());
  }

  /** Validate and normalize spend limits. Returns null for absent limits. */
  private normalizeSpendLimits(limits?: { daily?: string; monthly?: string }): {
    dailySpendLimit: string | null;
    monthlySpendLimit: string | null;
  } {
    const dailySpendLimit = limits?.daily?.trim() || null;
    const monthlySpendLimit = limits?.monthly?.trim() || null;

    if (dailySpendLimit !== null && BigInt(dailySpendLimit) < 0n) {
      throw new BadRequestException('dailySpendLimit must be a non-negative amount');
    }
    if (monthlySpendLimit !== null && BigInt(monthlySpendLimit) < 0n) {
      throw new BadRequestException('monthlySpendLimit must be a non-negative amount');
    }

    return { dailySpendLimit, monthlySpendLimit };
  }

  private toPermissions(key: Partial<ApiKeyPermissions>): ApiKeyPermissions {
    return {
      canSign: key.canSign ?? DEFAULT_API_KEY_PERMISSIONS.canSign,
      canSendTransaction: key.canSendTransaction ?? DEFAULT_API_KEY_PERMISSIONS.canSendTransaction,
      canReadTransactionStatus:
        key.canReadTransactionStatus ?? DEFAULT_API_KEY_PERMISSIONS.canReadTransactionStatus,
      canUseEoaExecution: key.canUseEoaExecution ?? DEFAULT_API_KEY_PERMISSIONS.canUseEoaExecution,
    };
  }

  private normalizeExpiresAt(expiresAt?: string | Date, permissions?: ApiKeyPermissions) {
    const maxTtl = permissions ? this.getMaxTtlForPermissions(permissions) : MAX_API_KEY_TTL_MS;
    const defaultTtl = permissions
      ? Math.min(DEFAULT_API_KEY_TTL_MS, maxTtl)
      : DEFAULT_API_KEY_TTL_MS;

    if (!expiresAt) return new Date(Date.now() + defaultTtl);

    const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('expiresAt must be a valid date');
    }

    const now = Date.now();
    if (date.getTime() <= now) {
      throw new BadRequestException('expiresAt must be in the future');
    }

    if (date.getTime() - now > maxTtl) {
      const maxDays = Math.round(maxTtl / (24 * 60 * 60 * 1000));
      throw new BadRequestException(
        `expiresAt must be within ${maxDays} days for this permission level`,
      );
    }

    return date;
  }

  private toDisplayPrefix(keyPrefix: string) {
    return `${keyPrefix.slice(0, 11)}...`;
  }

  /** Throw if high-risk permissions are enabled without an IP allowlist. */
  private assertIpAllowlistForHighRiskPermissions(
    permissions: ApiKeyPermissions,
    allowedIps: string[],
  ) {
    const hasHighRiskPermission = HIGH_RISK_PERMISSIONS.some((perm) => permissions[perm] === true);
    if (hasHighRiskPermission && allowedIps.length === 0) {
      throw new BadRequestException(
        'IP allowlist is required when requesting high-risk permissions (canSign, canSendTransaction, canUseEoaExecution)',
      );
    }
  }

  /** Return the maximum TTL allowed for the given permission set. */
  private getMaxTtlForPermissions(permissions: ApiKeyPermissions): number {
    if (permissions.canUseEoaExecution) return PERMISSION_MAX_TTL_MS.canUseEoaExecution;
    if (permissions.canSendTransaction) return PERMISSION_MAX_TTL_MS.canSendTransaction;
    if (permissions.canSign) return PERMISSION_MAX_TTL_MS.canSign;
    return PERMISSION_MAX_TTL_MS.canReadTransactionStatus;
  }

  private async assertCanCreateKey(tx: PrismaTransaction, userId: string, name: string) {
    const activeCount = await tx.apiKey.count({
      where: { userId, revoked: false },
    });
    if (activeCount >= MAX_ACTIVE_API_KEYS) {
      throw new BadRequestException('Maximum of 10 active API keys per user');
    }

    const duplicate = await tx.apiKey.findFirst({
      where: { userId, revoked: false, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException('An active API key with this name already exists');
    }
  }

  private async generateKeyMaterial() {
    const secret = randomBytes(32).toString('hex');
    const rawKey = `sk_${secret}`;
    const keyPrefix = getApiKeyPrefix(rawKey);
    const hash = await argon2.hash(rawKey, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    return { rawKey, keyPrefix, hash };
  }

  private audit(
    tx: PrismaTransaction,
    userId: string,
    apiKeyId: string | null,
    action: string,
    data: {
      keyPrefix?: string | null;
      keyName?: string | null;
      metadata?: Prisma.InputJsonValue;
    } = {},
  ) {
    return Promise.all([
      tx.apiKeyEvent.create({
        data: {
          userId,
          apiKeyId,
          action,
          keyPrefix: data.keyPrefix,
          keyName: data.keyName,
          metadata: data.metadata ?? Prisma.JsonNull,
        },
      }),
      this.securityEvents.record(
        {
          actorType: 'user',
          userId,
          apiKeyId,
          eventType: action,
          riskLevel: 'low',
          result: 'allowed',
          metadata: {
            keyPrefix: data.keyPrefix ?? null,
            keyName: data.keyName ?? null,
            details: data.metadata ?? null,
          },
        },
        tx as unknown as Parameters<SecurityEventService['record']>[1],
      ),
    ]);
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { DEFAULT_CHAIN_ID, getSupportedChain } from '../../common/chains/supported-chains';
import { getApiKeyPrefix } from '../../common/api-key/api-key-prefix';

const MAX_ACTIVE_API_KEYS = 10;
const MAX_API_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type ApiKeyCreateOptions = {
  name: string;
  allowedChains?: number[];
  expiresAt?: string | Date;
};

type PrismaTransaction = Prisma.TransactionClient;

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a new API key for the given user.
   * Returns the raw key **once** — it cannot be recovered after this call.
   */
  async createApiKey(userId: string, options: ApiKeyCreateOptions) {
    const normalized = this.normalizeCreateOptions(options);
    const keyMaterial = await this.generateKeyMaterial();

    const apiKey = await this.prisma.$transaction(async (tx) => {
      await this.assertCanCreateKey(tx, userId, normalized.name);

      const created = await tx.apiKey.create({
        data: {
          userId,
          apiKeyHash: keyMaterial.hash,
          keyPrefix: keyMaterial.keyPrefix,
          name: normalized.name,
          expiresAt: normalized.expiresAt,
          allowedIps: [],
          allowedChains: normalized.allowedChains,
        },
      });

      await this.audit(tx, userId, created.id, 'api_key.created', {
        keyPrefix: created.keyPrefix,
        keyName: created.name,
        metadata: {
          allowedChains: created.allowedChains,
          expiresAt: created.expiresAt?.toISOString() ?? null,
        },
      });

      return created;
    });

    return {
      id: apiKey.id,
      rawKey: keyMaterial.rawKey,
      keyPrefix: apiKey.keyPrefix,
      name: apiKey.name,
      allowedChains: apiKey.allowedChains,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    };
  }

  /** Revoke a single API key owned by the user. */
  async revokeApiKey(keyId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.apiKey.findFirst({
        where: { id: keyId, userId },
      });
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
        keyPrefix: existing.keyPrefix,
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

    const apiKey = await this.prisma.$transaction(async (tx) => {
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
          allowedChains: normalized.allowedChains,
        },
      });

      await this.audit(tx, userId, created.id, 'api_key.rotated', {
        keyPrefix: created.keyPrefix,
        keyName: created.name,
        metadata: {
          revokedKeyCount: activeKeys.length,
          allowedChains: created.allowedChains,
        },
      });

      return created;
    });

    return {
      id: apiKey.id,
      rawKey: keyMaterial.rawKey,
      keyPrefix: apiKey.keyPrefix,
      name: apiKey.name,
      allowedChains: apiKey.allowedChains,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    };
  }

  /** List all API keys (metadata only — no secrets). */
  async listApiKeys(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        revoked: true,
        expiresAt: true,
        allowedIps: true,
        allowedChains: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private normalizeCreateOptions(options: ApiKeyCreateOptions) {
    const name = options.name?.trim();
    if (!name) {
      throw new BadRequestException('API key name is required');
    }

    const allowedChains = options.allowedChains?.length
      ? [...new Set(options.allowedChains)]
      : [DEFAULT_CHAIN_ID];
    allowedChains.forEach(getSupportedChain);

    const expiresAt = this.normalizeExpiresAt(options.expiresAt);

    return { name, allowedChains, expiresAt };
  }

  private normalizeExpiresAt(expiresAt?: string | Date) {
    if (!expiresAt) return undefined;

    const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('expiresAt must be a valid date');
    }

    const now = Date.now();
    if (date.getTime() <= now) {
      throw new BadRequestException('expiresAt must be in the future');
    }

    if (date.getTime() - now > MAX_API_KEY_TTL_MS) {
      throw new BadRequestException('expiresAt must be within 365 days');
    }

    return date;
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
    return tx.apiKeyEvent.create({
      data: {
        userId,
        apiKeyId,
        action,
        keyPrefix: data.keyPrefix,
        keyName: data.keyName,
        metadata: data.metadata ?? Prisma.JsonNull,
      },
    });
  }
}

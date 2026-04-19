import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a new API key for the given user.
   * Returns the raw key **once** — it cannot be recovered after this call.
   */
  async createApiKey(userId: string, name?: string) {
    const secret = randomBytes(32).toString('hex');
    const rawKey = `sk_${secret}`;
    const keyPrefix = rawKey.substring(0, 11); // "sk_" + 8 hex chars

    const salt = randomBytes(16).toString('hex');
    const hash = createHash('sha256')
      .update(salt + rawKey)
      .digest('hex');

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId,
        apiKeyHash: hash,
        salt,
        keyPrefix,
        name: name || 'Default',
        allowedIps: [],
        allowedContracts: [],
      },
    });

    return {
      id: apiKey.id,
      rawKey,
      keyPrefix,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
    };
  }

  /** Revoke a single API key owned by the user. */
  async revokeApiKey(keyId: string, userId: string) {
    return this.prisma.apiKey.updateMany({
      where: { id: keyId, userId },
      data: { revoked: true },
    });
  }

  /** Revoke every active key for a user (used during key refresh). */
  async revokeAllKeys(userId: string) {
    return this.prisma.apiKey.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
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
        allowedContracts: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

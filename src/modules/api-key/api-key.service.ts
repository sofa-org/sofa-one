import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a new API key for the given user.
   * Returns the raw key **once** — it cannot be recovered after this call.
   */
  async createApiKey(userId: string, name?: string) {
    const activeCount = await this.prisma.apiKey.count({
      where: { userId, revoked: false },
    });
    if (activeCount >= 10) {
      throw new BadRequestException('Maximum of 10 active API keys per user');
    }

    const secret = randomBytes(32).toString('hex');
    const rawKey = `sk_${secret}`;
    const keyPrefix = rawKey.substring(0, 11); // "sk_" + 8 hex chars

    const hash = await argon2.hash(rawKey, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId,
        apiKeyHash: hash,
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

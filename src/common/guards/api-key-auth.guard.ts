import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';
import { getApiKeyLookupPrefixes } from '../api-key/api-key-prefix';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { isIpAllowed } from '../utils/ip-cidr';

const MAX_USER_AGENT_LENGTH = 255;

/**
 * Authenticates public API routes with X-API-Key only.
 *
 * This guard intentionally does not accept Bearer tokens. Dashboard/human routes
 * should use OpenfortUserGuard, while public programmatic routes should use this
 * guard directly instead of EitherAuthGuard + ApiKeyOnlyGuard.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    if (Array.isArray(apiKey) || !apiKey) {
      throw new UnauthorizedException('Missing API key');
    }

    return this.authenticateWithApiKey(request, apiKey);
  }

  private async authenticateWithApiKey(request: any, apiKey: string): Promise<boolean> {
    const prefixes = getApiKeyLookupPrefixes(apiKey);
    // Use request.ip which is correctly set by Express after trust-proxy processing.
    // Never read X-Forwarded-For directly — it can be forged by the client.
    const clientIp: string = request.ip ?? '';
    const userAgent = this.getUserAgent(request);

    const keyRecords = await this.prisma.apiKey.findMany({
      where: {
        keyPrefix: { in: prefixes },
        revoked: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { user: true },
    });

    if (keyRecords.length === 0) {
      this.logApiKeyAuthenticationFailure('no_active_prefix_candidate', {
        clientIp,
        userAgent,
        lookupPrefixCount: prefixes.length,
      });
      throw new UnauthorizedException('Invalid API key');
    }

    // Verify every prefix candidate. Prefixes are only a lookup hint and are not unique.
    let keyRecord: (typeof keyRecords)[number] | undefined;
    for (const candidate of keyRecords) {
      if (await argon2.verify(candidate.apiKeyHash, apiKey)) {
        keyRecord = candidate;
        break;
      }
    }

    if (!keyRecord) {
      this.logApiKeyAuthenticationFailure('hash_verification_failed', {
        clientIp,
        userAgent,
        candidateCount: keyRecords.length,
      });
      throw new UnauthorizedException('Invalid API key');
    }

    if (keyRecord.allowedIps.length > 0 && !isIpAllowed(clientIp, keyRecord.allowedIps)) {
      this.logApiKeyAuthenticationFailure('ip_allowlist_rejected', {
        apiKeyId: keyRecord.id,
        apiKeyPrefix: keyRecord.keyPrefix,
        userId: keyRecord.user?.id,
        clientIp,
        userAgent,
        allowedIpCount: keyRecord.allowedIps.length,
      });
      throw new ForbiddenException('IP address not allowed for this API key');
    }

    request.user = keyRecord.user;
    request.apiKeyRecord = keyRecord;

    this.logApiKeyUsageAnomaly(keyRecord, clientIp, userAgent);

    // Fire-and-forget: update lastUsedAt without blocking the request.
    void this.prisma.apiKey
      .update({
        where: { id: keyRecord.id },
        data: {
          lastUsedAt: new Date(),
          lastUsedIp: clientIp || null,
          lastUsedUserAgent: userAgent,
        },
      })
      .catch((err) => this.logger.warn('lastUsedAt update failed', err));

    return true;
  }

  private getUserAgent(request: { headers: Record<string, string | string[] | undefined> }): string | null {
    const value = request.headers['user-agent'];
    const userAgent = Array.isArray(value) ? value[0] : value;
    if (!userAgent) return null;
    return userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  }

  private logApiKeyAuthenticationFailure(
    reason: string,
    details: {
      apiKeyId?: string;
      apiKeyPrefix?: string | null;
      userId?: string | null;
      clientIp: string;
      userAgent: string | null;
      lookupPrefixCount?: number;
      candidateCount?: number;
      allowedIpCount?: number;
    },
  ) {
    this.logger.warn({
      event: 'security',
      message: 'API key authentication rejected',
      reason,
      apiKeyId: details.apiKeyId,
      apiKeyPrefix: details.apiKeyPrefix,
      userId: details.userId,
      clientIp: details.clientIp || null,
      userAgent: details.userAgent,
      lookupPrefixCount: details.lookupPrefixCount,
      candidateCount: details.candidateCount,
      allowedIpCount: details.allowedIpCount,
    });
  }

  private logApiKeyUsageAnomaly(
    keyRecord: {
      id: string;
      keyPrefix?: string | null;
      lastUsedIp?: string | null;
      lastUsedUserAgent?: string | null;
      user?: { id?: string | null } | null;
    },
    currentIp: string,
    currentUserAgent: string | null,
  ) {
    const ipChanged = Boolean(keyRecord.lastUsedIp && currentIp && keyRecord.lastUsedIp !== currentIp);
    const userAgentChanged = Boolean(
      keyRecord.lastUsedUserAgent && currentUserAgent && keyRecord.lastUsedUserAgent !== currentUserAgent,
    );

    if (!ipChanged && !userAgentChanged) return;

    this.logger.warn({
      event: 'security',
      message: 'API key usage context changed',
      apiKeyId: keyRecord.id,
      apiKeyPrefix: keyRecord.keyPrefix,
      userId: keyRecord.user?.id,
      ipChanged,
      userAgentChanged,
      previousIp: keyRecord.lastUsedIp ?? null,
      currentIp: currentIp || null,
      previousUserAgent: userAgentChanged ? keyRecord.lastUsedUserAgent : undefined,
      currentUserAgent: userAgentChanged ? currentUserAgent : undefined,
    });
  }
}

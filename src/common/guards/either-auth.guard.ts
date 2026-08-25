import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { SecurityEventService } from '../../modules/security-events/security-event.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { getApiKeyLookupPrefixes } from '../api-key/api-key-prefix';
import { IpAllowlistService } from './ip-allowlist.service';

const SUSPICIOUS_USE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type ApiKeyAuthRecord = {
  id: string;
  userId?: string | null;
  keyPrefix?: string | null;
  frozenAt?: Date | string | null;
  frozenReason?: string | null;
  lastUsedIp?: string | null;
  lastUsedUserAgent?: string | null;
  lastUsedAt?: Date | string | null;
  canSign?: boolean;
  canSendTransaction?: boolean;
  canUseEoaExecution?: boolean;
  allowedIps?: string[];
  user?: { id?: string | null; frozenAt?: Date | string | null; frozenReason?: string | null } | null;
};

const MAX_USER_AGENT_LENGTH = 255;

/**
 * Accepts either Openfort IAM JWT (Authorization: Bearer) or X-API-Key header.
 * In both cases, resolves the full user record and attaches it to request.user
 * so @CurrentUser() works uniformly.
 *
 * Priority: JWT first → API key fallback.
 */
@Injectable()
export class EitherAuthGuard implements CanActivate {
  private readonly logger = new Logger(EitherAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly ipAllowlist: IpAllowlistService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();

    // 1. Try Openfort IAM JWT
    const bearerToken = this.extractBearerToken(request);
    if (bearerToken) {
      return this.authenticateWithJwt(request, bearerToken);
    }

    // 2. Fall back to API key
    const apiKey = request.headers['x-api-key'] as string;
    if (apiKey) {
      return this.authenticateWithApiKey(request, apiKey);
    }

    throw new UnauthorizedException(
      'Missing authentication — provide Authorization Bearer token or X-API-Key header',
    );
  }

  private async authenticateWithJwt(request: any, token: string): Promise<boolean> {
    try {
      const session = await this.openfort.verifyIamSession(token);

      const user = await this.prisma.user.findUnique({
        where: { socialId: session.openfortUserId },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      request.user = user;
      request.openfortUserId = session.openfortUserId;
      request.openfortSession = session.session;
      request.openfortEmail = session.email;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid authorization token');
    }
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

    await this.ipAllowlist.assertIpAllowed(clientIp, keyRecord.allowedIps, {
      actorType: 'api_key',
      apiKeyId: keyRecord.id,
      apiKeyPrefix: keyRecord.keyPrefix,
      userId: keyRecord.user?.id,
      clientIp,
      userAgent,
      allowedIpCount: keyRecord.allowedIps.length,
    });

    // Frozen key check — reject immediately if the API key or user is frozen.
    if (keyRecord.frozenAt) {
      await this.recordApiKeySecurityEvent(keyRecord, 'api_key_frozen_rejected', {
        riskLevel: 'high',
        clientIp,
        userAgent,
        result: 'denied',
        reason: keyRecord.frozenReason ?? 'api_key_frozen',
      });
      throw new ForbiddenException('API key is frozen');
    }

    if (keyRecord.user?.frozenAt) {
      await this.recordApiKeySecurityEvent(keyRecord, 'api_key_user_frozen_rejected', {
        riskLevel: 'high',
        clientIp,
        userAgent,
        result: 'denied',
        reason: keyRecord.user.frozenReason ?? 'user_frozen',
      });
      throw new ForbiddenException('User account is frozen');
    }

    await this.handleApiKeyUsageAnomaly(keyRecord, clientIp, userAgent);

    if (!keyRecord.lastUsedAt) {
      await this.recordApiKeySecurityEvent(keyRecord, 'api_key.first_used', {
        riskLevel: 'low',
        clientIp,
        userAgent,
        result: 'allowed',
        reason: 'first_use',
      });
    }

    request.user = keyRecord.user;
    request.apiKeyRecord = keyRecord;

    // Fire-and-forget: update lastUsedAt without blocking the request
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

  private extractBearerToken(request: { headers: Record<string, string> }): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
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

  private async handleApiKeyUsageAnomaly(
    keyRecord: ApiKeyAuthRecord,
    currentIp: string,
    currentUserAgent: string | null,
  ) {
    const ipChanged = Boolean(keyRecord.lastUsedIp && currentIp && keyRecord.lastUsedIp !== currentIp);
    const userAgentChanged = Boolean(
      keyRecord.lastUsedUserAgent && currentUserAgent && keyRecord.lastUsedUserAgent !== currentUserAgent,
    );

    if (!ipChanged && !userAgentChanged) return;

    this.logApiKeyUsageAnomaly(keyRecord, currentIp, currentUserAgent);

    const highRiskKey = this.hasHighRiskPermission(keyRecord);
    const repeatedSuspiciousUse = highRiskKey ? false : await this.hasRecentSuspiciousUse(keyRecord.id);
    const shouldFreeze = highRiskKey || repeatedSuspiciousUse;
    const reason = highRiskKey ? 'high_risk_context_changed' : 'repeated_context_changed';

    await this.recordApiKeySecurityEvent(keyRecord, 'api_key_suspicious_use', {
      riskLevel: shouldFreeze ? 'high' : 'medium',
      clientIp: currentIp,
      userAgent: currentUserAgent,
      result: shouldFreeze ? 'denied' : 'allowed',
      reason,
      metadata: {
        ipChanged,
        userAgentChanged,
        previousIp: keyRecord.lastUsedIp ?? null,
        currentIp: currentIp || null,
        previousUserAgent: userAgentChanged ? keyRecord.lastUsedUserAgent ?? null : null,
        highRiskKey,
        repeatedSuspiciousUse,
      },
    });

    if (!shouldFreeze) return;

    await this.freezeApiKey(keyRecord, reason);
    throw new ForbiddenException('API key frozen due to suspicious usage');
  }

  private hasHighRiskPermission(keyRecord: ApiKeyAuthRecord) {
    return Boolean(
      keyRecord.canSign || keyRecord.canSendTransaction || keyRecord.canUseEoaExecution,
    );
  }

  private async hasRecentSuspiciousUse(apiKeyId: string) {
    const count = await this.prisma.securityEvent.count({
      where: {
        apiKeyId,
        eventType: 'api_key_suspicious_use',
        createdAt: { gt: new Date(Date.now() - SUSPICIOUS_USE_LOOKBACK_MS) },
      },
    });
    return count > 0;
  }

  private async freezeApiKey(keyRecord: ApiKeyAuthRecord, reason: string) {
    await this.prisma.apiKey.updateMany({
      where: { id: keyRecord.id, frozenAt: null },
      data: { frozenAt: new Date(), frozenReason: reason },
    });
    await this.recordApiKeySecurityEvent(keyRecord, 'api_key_frozen', {
      riskLevel: 'critical',
      result: 'denied',
      reason,
    });
  }

  private async recordApiKeySecurityEvent(
    keyRecord: ApiKeyAuthRecord,
    eventType: string,
    details: {
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      clientIp?: string;
      userAgent?: string | null;
      result: 'allowed' | 'denied';
      reason: string;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    await this.securityEvents
      .record({
        actorType: 'api_key',
        eventType,
        userId: keyRecord.user?.id ?? keyRecord.userId ?? null,
        apiKeyId: keyRecord.id,
        riskLevel: details.riskLevel,
        ip: details.clientIp ?? null,
        userAgent: details.userAgent ?? null,
        result: details.result,
        reason: details.reason,
        metadata: details.metadata,
      })
      .catch((err) => this.logger.warn('security event recording failed', err));
  }
}

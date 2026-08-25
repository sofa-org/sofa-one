import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { SecurityEventService } from '../../modules/security-events/security-event.service';
import { isIpAllowed } from '../utils/ip-cidr';

type IpAllowlistContext = {
  /** The type of actor making the request (e.g. 'api_key', 'user') */
  actorType: 'api_key' | 'user';
  /** The API key ID, if applicable */
  apiKeyId?: string;
  /** The API key prefix, if applicable */
  apiKeyPrefix?: string;
  /** The user ID, if applicable */
  userId?: string;
  /** The client IP address */
  clientIp: string;
  /** The user-agent string */
  userAgent?: string | null;
  /** Number of allowed IPs in the allowlist (for logging) */
  allowedIpCount?: number;
};

/**
 * Centralized IP allowlist enforcement with SecurityEvent audit trail.
 *
 * Replaces duplicated IP allowlist checks in ApiKeyAuthGuard, EitherAuthGuard,
 * and EoaExecutionPolicyService with a single service that also records
 * SecurityEvent entries for IP rejections.
 */
@Injectable()
export class IpAllowlistService {
  private readonly logger = new Logger(IpAllowlistService.name);

  constructor(
    @Optional()
    private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * Assert that the client IP is allowed by the IP allowlist.
   * If the allowlist is empty, all IPs are allowed (no restriction).
   * If the allowlist is non-empty and the IP is not in it, throws ForbiddenException
   * and records a SecurityEvent.
   */
  async assertIpAllowed(clientIp: string, allowedIps: string[], context: IpAllowlistContext): Promise<void> {
    // Empty allowlist means no IP restriction
    if (!allowedIps.length) return;

    if (isIpAllowed(clientIp, allowedIps)) return;

    // IP not in allowlist — reject and record security event
    this.logger.warn({
      event: 'security',
      message: 'IP allowlist rejected',
      actorType: context.actorType,
      apiKeyId: context.apiKeyId,
      apiKeyPrefix: context.apiKeyPrefix,
      userId: context.userId,
      clientIp: context.clientIp || null,
      userAgent: context.userAgent,
      allowedIpCount: context.allowedIpCount ?? allowedIps.length,
    });

    await this.recordIpRejection(context);

    throw new ForbiddenException('IP address not allowed for this API key');
  }

  /**
   * Check whether a client IP is allowed by the IP allowlist.
   * Returns true if allowed, false if not.
   * Does NOT throw or record events — use assertIpAllowed() for that.
   */
  isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    if (!allowedIps.length) return true;
    return isIpAllowed(clientIp, allowedIps);
  }

  private async recordIpRejection(context: IpAllowlistContext): Promise<void> {
    if (!this.securityEvents) return;

    try {
      await this.securityEvents.record({
        actorType: context.actorType,
        eventType: 'api_key.ip_rejected',
        userId: context.userId ?? null,
        apiKeyId: context.apiKeyId ?? null,
        riskLevel: 'high',
        ip: context.clientIp || null,
        userAgent: context.userAgent ?? null,
        result: 'denied',
        reason: 'ip_allowlist_rejected',
        metadata: {
          apiKeyPrefix: context.apiKeyPrefix ?? null,
          allowedIpCount: context.allowedIpCount ?? null,
        },
      });
    } catch (error) {
      this.logger.error('IP rejection security event recording failed', error);
    }
  }
}
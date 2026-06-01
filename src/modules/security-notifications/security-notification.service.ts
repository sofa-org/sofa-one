import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventRiskLevel } from '../security-events/security-event.service';

type NotificationPrismaClient = {
  securityNotification: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findMany(args: Record<string, unknown>): Promise<unknown[]>;
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
};

type CreatedSecurityEvent = {
  id: string;
  actorType?: string | null;
  userId?: string | null;
  eventType: string;
  riskLevel: SecurityEventRiskLevel | string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  result?: string | null;
  reason?: string | null;
  metadata?: unknown;
};

export type ListSecurityNotificationsQuery = {
  unreadOnly?: boolean;
  limit?: number;
};

const ALWAYS_NOTIFY_EVENT_TYPES = new Set([
  'api_key.created',
  'api_key.first_used',
  'api_key_suspicious_use',
  'api_key_frozen',
  'api_key.ip_rejected',
  'login.new_ip',
  'transaction.policy_denied',
  'withdrawal.policy_denied',
  'withdrawal.high_value_requested',
  'withdrawal_address.added',
  'withdrawal_address.removed',
  'eoa_execution_denied',
  'signing.policy_denied',
  'risk.blocked',
  'risk.critical_frozen',
  'risk.step_up_required',
  'session_key.denied',
  'session_key.policy_drift',
]);

const NOTIFY_RISK_LEVELS = new Set(['medium', 'high', 'critical']);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SAFE_CONTEXT_FIELDS = [
  'apiKeyPrefix',
  'keyPrefix',
  'keyName',
  'chainId',
  'executionMode',
  'operation',
  'interactionCount',
  'interactionIndex',
  'functionSelector',
  'selector',
  'target',
  'token',
  'amountUnits',
  'maxAmountUnits',
  'thresholdUnits',
  'address',
  'availableAt',
  'cooldownHours',
  'hasContractAllowlist',
  'hasSelectorAllowlist',
  'hasSpendLimit',
] as const;

type SafeMetadataValue = string | number | boolean | null;

@Injectable()
export class SecurityNotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async notifyForSecurityEvent(event: CreatedSecurityEvent, tx?: NotificationPrismaClient) {
    if (!event.userId || !this.shouldNotify(event)) return null;

    const message = this.buildMessage(event);
    const client = (tx ?? this.prisma) as NotificationPrismaClient;
    return client.securityNotification.create({
      data: {
        userId: event.userId,
        securityEventId: event.id,
        type: event.eventType,
        title: message.title,
        body: message.body,
        riskLevel: event.riskLevel,
        metadata: this.safeNotificationMetadata(event),
      },
    });
  }

  async listForUser(userId: string, query: ListSecurityNotificationsQuery = {}) {
    const limit = this.normalizeLimit(query.limit);
    const where = {
      userId,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const client = this.prisma as unknown as NotificationPrismaClient;
    return client.securityNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async markRead(userId: string, notificationId: string) {
    const client = this.prisma as unknown as NotificationPrismaClient;
    const result = await client.securityNotification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true, updatedCount: result.count };
  }

  async markAllRead(userId: string) {
    const client = this.prisma as unknown as NotificationPrismaClient;
    const result = await client.securityNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true, updatedCount: result.count };
  }

  private shouldNotify(event: CreatedSecurityEvent) {
    return (
      ALWAYS_NOTIFY_EVENT_TYPES.has(event.eventType) || NOTIFY_RISK_LEVELS.has(event.riskLevel)
    );
  }

  private buildMessage(event: CreatedSecurityEvent) {
    switch (event.eventType) {
      case 'api_key.created':
        return {
          title: 'New API key created',
          body: 'A new API key was created for your account.',
        };
      case 'api_key.first_used':
        return {
          title: 'API key used for the first time',
          body: 'An API key was used for the first time.',
        };
      case 'api_key_suspicious_use':
      case 'api_key_frozen':
        return {
          title: 'Suspicious API key activity',
          body: 'Suspicious API key activity was detected. Review your API keys.',
        };
      case 'transaction.policy_denied':
        return {
          title: 'Transaction blocked by policy',
          body: 'A transaction request was blocked by SOFA ONE safety policy.',
        };
      case 'withdrawal.high_value_requested':
        return {
          title: 'High-value withdrawal requested',
          body: 'A high-value withdrawal request was detected for your wallet.',
        };
      case 'withdrawal.policy_denied':
        return {
          title: 'Withdrawal blocked by policy',
          body: 'A withdrawal request was blocked by your withdrawal policy.',
        };
      case 'withdrawal_address.added':
        return {
          title: 'Withdrawal address added',
          body: 'A new withdrawal address was added to your allowlist.',
        };
      case 'withdrawal_address.removed':
        return {
          title: 'Withdrawal address removed',
          body: 'A withdrawal address was removed from your allowlist.',
        };
      case 'eoa_execution_denied':
        return {
          title: 'EOA execution blocked',
          body: 'A high-privilege EOA execution request was blocked.',
        };
      case 'signing.policy_denied':
        return {
          title: 'Signing request blocked by policy',
          body: 'A signing request was blocked by SOFA ONE safety policy.',
        };
      case 'login.new_ip':
        return {
          title: 'New login from unrecognized IP',
          body: 'Your account was accessed from a new IP address. If this was not you, review your security settings.',
        };
      case 'login.failed':
        return {
          title: 'Failed login attempt',
          body: 'An unsuccessful login attempt was detected on your account.',
        };
      case 'api_key.ip_rejected':
        return {
          title: 'API key blocked by IP allowlist',
          body: 'An API key request was blocked because the IP address is not in the allowlist.',
        };
      default:
        return {
          title: 'Security event detected',
          body: 'A security event was recorded for your account.',
        };
    }
  }

  private safeNotificationMetadata(event: CreatedSecurityEvent): Prisma.InputJsonValue {
    const metadata: Record<string, SafeMetadataValue> = {
      eventType: event.eventType,
      result: event.result ?? null,
      reason: event.reason ?? null,
    };

    this.addIfPresent(metadata, 'actorType', event.actorType);
    this.addIfPresent(metadata, 'ip', event.ip);
    this.addIfPresent(metadata, 'userAgent', event.userAgent);
    this.addIfPresent(metadata, 'requestId', event.requestId);

    const eventMetadata = this.asRecord(event.metadata);
    for (const field of SAFE_CONTEXT_FIELDS) {
      this.addIfPresent(metadata, field, eventMetadata[field]);
    }

    return metadata;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private addIfPresent(
    metadata: Record<string, SafeMetadataValue>,
    key: string,
    value: unknown,
  ): void {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = value;
    }
  }

  private normalizeLimit(limit: number | undefined) {
    if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  }
}

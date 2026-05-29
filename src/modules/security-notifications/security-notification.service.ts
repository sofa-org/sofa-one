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
  userId?: string | null;
  eventType: string;
  riskLevel: SecurityEventRiskLevel | string;
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
  'api_key.suspicious_use',
  'api_key_frozen',
  'login.new_ip',
  'transaction.policy_denied',
  'withdrawal.policy_denied',
  'withdrawal.high_value_requested',
  'withdrawal_address.added',
  'withdrawal_address.removed',
  'eoa_execution_denied',
]);

const NOTIFY_RISK_LEVELS = new Set(['medium', 'high', 'critical']);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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
    return ALWAYS_NOTIFY_EVENT_TYPES.has(event.eventType) || NOTIFY_RISK_LEVELS.has(event.riskLevel);
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
      case 'api_key.suspicious_use':
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
      default:
        return {
          title: 'Security event detected',
          body: 'A security event was recorded for your account.',
        };
    }
  }

  private safeNotificationMetadata(event: CreatedSecurityEvent): Prisma.InputJsonValue {
    return {
      eventType: event.eventType,
      reason: event.reason ?? null,
    };
  }

  private normalizeLimit(limit: number | undefined) {
    if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  }
}

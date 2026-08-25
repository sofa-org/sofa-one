import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { sanitizeErrorMessage } from '../../common/utils/sanitize';

type ExportableSecurityEvent = {
  id?: string;
  actorType?: string;
  userId?: string | null;
  apiKeyId?: string | null;
  walletId?: string | null;
  eventType?: string;
  riskLevel?: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  result?: string | null;
  reason?: string | null;
  metadata?: unknown;
  createdAt?: Date | string;
};

type SecurityEventExportPayload = {
  type: 'security_event';
  id: string | null;
  createdAt: string | null;
  actorType: string | null;
  userId: string | null;
  apiKeyId: string | null;
  walletId: string | null;
  eventType: string | null;
  riskLevel: string | null;
  result: string | null;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Prisma.InputJsonValue | typeof Prisma.JsonNull;
};

@Injectable()
export class SecurityEventExportService {
  private readonly logger = new Logger(SecurityEventExportService.name);

  async exportSecurityEvent(event: ExportableSecurityEvent): Promise<void> {
    const webhookUrl = process.env.SECURITY_EVENTS_SIEM_WEBHOOK_URL?.trim();
    if (!webhookUrl) return;

    const payload = this.toPayload(event);
    let response: Response;

    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'sofa-one-security-events/1.0',
          ...(process.env.SECURITY_EVENTS_SIEM_WEBHOOK_SECRET?.trim()
            ? { Authorization: `Bearer ${process.env.SECURITY_EVENTS_SIEM_WEBHOOK_SECRET.trim()}` }
            : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.logger.error(
        `SecurityEvent SIEM webhook request failed: eventType=${payload.eventType ?? 'unknown'}, eventId=${payload.id ?? 'unknown'}`,
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }

    if (!response.ok) {
      this.logger.error(
        `SecurityEvent SIEM webhook returned ${response.status}: eventType=${payload.eventType ?? 'unknown'}, eventId=${payload.id ?? 'unknown'}`,
      );
    }
  }

  private toPayload(event: ExportableSecurityEvent): SecurityEventExportPayload {
    return {
      type: 'security_event',
      id: event.id ?? null,
      createdAt: this.toIsoString(event.createdAt),
      actorType: event.actorType ?? null,
      userId: event.userId ?? null,
      apiKeyId: event.apiKeyId ?? null,
      walletId: event.walletId ?? null,
      eventType: event.eventType ?? null,
      riskLevel: event.riskLevel ?? null,
      result: event.result ?? null,
      reason: event.reason ?? null,
      requestId: event.requestId ?? null,
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      metadata: this.toSafeJson(event.metadata),
    };
  }

  private toIsoString(value: Date | string | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private toSafeJson(value: unknown, depth = 0): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (value === null || value === undefined || value === Prisma.JsonNull) return Prisma.JsonNull;
    if (depth >= 4) return '[truncated]';

    if (typeof value === 'string') return sanitizeErrorMessage(value, 240);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => this.toSafeJson(item, depth + 1)) as Prisma.InputJsonArray;
    }

    if (typeof value === 'object') {
      const safe: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
        if (this.isSensitiveKey(key)) {
          safe[key] = '[redacted]';
          continue;
        }
        safe[key] = this.toSafeJson(raw, depth + 1);
      }
      return safe as Prisma.InputJsonObject;
    }

    return String(value);
  }

  private isSensitiveKey(key: string): boolean {
    return /(?:secret|private|raw|calldata|typeddata|api[_-]?key|authorization|token|signature)/i.test(key);
  }
}

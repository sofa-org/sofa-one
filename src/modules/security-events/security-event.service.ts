import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { SecurityNotificationService } from '../security-notifications/security-notification.service';
import { SecurityEventExportService } from './security-event-export.service';
import { SecurityRiskService } from './security-risk.service';

export type SecurityEventActorType = 'user' | 'api_key' | 'system';
export type SecurityEventRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type SecurityEventResult = 'allowed' | 'denied';

export type RecordSecurityEventInput = {
  actorType: SecurityEventActorType;
  eventType: string;
  userId?: string | null;
  apiKeyId?: string | null;
  walletId?: string | null;
  riskLevel?: SecurityEventRiskLevel;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  result?: SecurityEventResult | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** Trusted persistence timestamp (e.g. sourced from PostgreSQL clock_timestamp()). */
  createdAt?: Date;
};

type SecurityEventClient = {
  securityEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
};

@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    @Optional() private readonly notifications?: SecurityNotificationService,
    @Optional() private readonly riskService?: SecurityRiskService,
    @Optional() private readonly exporter?: SecurityEventExportService,
  ) {}

  async record(input: RecordSecurityEventInput, tx?: SecurityEventClient | Prisma.TransactionClient, options?: { deferExport?: boolean }) {
    const eventType = input.eventType.trim();
    if (!eventType) {
      throw new BadRequestException('Security event type is required');
    }

    const client = (tx ?? this.prisma) as unknown as SecurityEventClient;
    const risk = this.riskService?.score({ ...input, eventType }) ?? {
      riskLevel: input.riskLevel ?? 'low',
    };
    const event = await client.securityEvent.create({
      data: {
        actorType: input.actorType,
        userId: input.userId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        walletId: input.walletId ?? null,
        eventType,
        riskLevel: risk.riskLevel,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? this.requestContext.getRequestId() ?? null,
        result: input.result ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });

    try {
      await this.notifications?.notifyForSecurityEvent(event as never, client as never);
    } catch (error) {
      this.logger.error(
        `Security notification creation failed: eventType=${eventType}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    if (!options?.deferExport) await this.exportCommitted(event as { eventType?: string });

    return event;
  }

  async exportCommitted(event: unknown) {
    try {
      await this.exporter?.exportSecurityEvent(event as never);
    } catch (error) {
      const eventType = typeof event === 'object' && event !== null && 'eventType' in event && typeof event.eventType === 'string' ? event.eventType : 'unknown';
      this.logger.error(
        `SecurityEvent SIEM export failed: eventType=${eventType}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { RequestContextService } from '../../common/request-context/request-context.service';

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
};

type SecurityEventClient = {
  securityEvent: {
    create(args: { data: Record<string, unknown> }): unknown;
  };
};

@Injectable()
export class SecurityEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
  ) {}

  async record(input: RecordSecurityEventInput, tx?: SecurityEventClient) {
    const eventType = input.eventType.trim();
    if (!eventType) {
      throw new BadRequestException('Security event type is required');
    }

    const client = (tx ?? this.prisma) as SecurityEventClient;
    return client.securityEvent.create({
      data: {
        actorType: input.actorType,
        userId: input.userId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        walletId: input.walletId ?? null,
        eventType,
        riskLevel: input.riskLevel ?? 'low',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? this.requestContext.getRequestId() ?? null,
        result: input.result ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
  }
}

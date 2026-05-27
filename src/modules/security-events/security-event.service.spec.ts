import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SecurityEventService } from './security-event.service';

describe('SecurityEventService', () => {
  const prisma = {
    securityEvent: {
      create: jest.fn(),
    },
  };
  const requestContext = {
    getRequestId: jest.fn(),
  };

  let service: SecurityEventService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SecurityEventService(prisma as never, requestContext as never);
  });

  it('records a minimal event with safe defaults', async () => {
    prisma.securityEvent.create.mockResolvedValue({ id: 'event-1' });
    requestContext.getRequestId.mockReturnValue('req-123');

    await service.record({ actorType: 'system', eventType: 'policy.denied' });

    expect(prisma.securityEvent.create).toHaveBeenCalledWith({
      data: {
        actorType: 'system',
        userId: null,
        apiKeyId: null,
        walletId: null,
        eventType: 'policy.denied',
        riskLevel: 'low',
        ip: null,
        userAgent: null,
        requestId: 'req-123',
        result: null,
        reason: null,
        metadata: Prisma.JsonNull,
      },
    });
  });

  it('records full attribution and explicit request context', async () => {
    prisma.securityEvent.create.mockResolvedValue({ id: 'event-2' });

    await service.record({
      actorType: 'api_key',
      userId: 'user-1',
      apiKeyId: 'key-1',
      walletId: 'wallet-1',
      eventType: 'api_key.suspicious_use',
      riskLevel: 'high',
      ip: '203.0.113.10',
      userAgent: 'agent',
      requestId: 'explicit-req',
      result: 'denied',
      reason: 'new_ip_velocity',
      metadata: { previousIp: '198.51.100.5' },
    });

    expect(prisma.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'api_key',
        userId: 'user-1',
        apiKeyId: 'key-1',
        walletId: 'wallet-1',
        eventType: 'api_key.suspicious_use',
        riskLevel: 'high',
        ip: '203.0.113.10',
        userAgent: 'agent',
        requestId: 'explicit-req',
        result: 'denied',
        reason: 'new_ip_velocity',
        metadata: { previousIp: '198.51.100.5' },
      }),
    });
    expect(requestContext.getRequestId).not.toHaveBeenCalled();
  });

  it('uses a transaction client when provided', async () => {
    const tx = { securityEvent: { create: jest.fn().mockResolvedValue({ id: 'event-3' }) } };

    await service.record({ actorType: 'user', userId: 'user-1', eventType: 'api_key.created' }, tx);

    expect(tx.securityEvent.create).toHaveBeenCalled();
    expect(prisma.securityEvent.create).not.toHaveBeenCalled();
  });

  it('rejects blank event types', async () => {
    await expect(service.record({ actorType: 'system', eventType: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.securityEvent.create).not.toHaveBeenCalled();
  });
});

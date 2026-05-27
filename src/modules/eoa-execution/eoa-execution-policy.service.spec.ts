import { ForbiddenException } from '@nestjs/common';
import { EoaExecutionPolicyService } from './eoa-execution-policy.service';

describe('EoaExecutionPolicyService', () => {
  const config = { get: jest.fn() } as any;
  const prisma = { securityEvent: { count: jest.fn() } } as any;
  const securityEvents = { record: jest.fn() } as any;
  let service: EoaExecutionPolicyService;

  const baseContext = {
    operation: 'sign' as const,
    userId: 'user-1',
    apiKeyId: 'api-key-1',
    apiKeyPrefix: 'sk_1234567890abcdef12345678',
    allowedIps: ['203.0.113.10'],
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    chainId: 84532,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue('true');
    prisma.securityEvent.count.mockResolvedValue(0);
    securityEvents.record.mockResolvedValue({ id: 'event-1' });
    service = new EoaExecutionPolicyService(config, prisma, securityEvents);
  });

  it('denies EOA execution when globally disabled by default', async () => {
    config.get.mockReturnValue(undefined);

    await expect(service.assertAllowed(baseContext)).rejects.toThrow(ForbiddenException);

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'eoa_execution_denied',
        result: 'denied',
        reason: 'eoa_execution_disabled',
        riskLevel: 'critical',
      }),
    );
    expect(prisma.securityEvent.count).not.toHaveBeenCalled();
  });

  it('requires an API key IP allowlist at runtime', async () => {
    await expect(service.assertAllowed({ ...baseContext, allowedIps: [] })).rejects.toThrow(
      ForbiddenException,
    );

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'eoa_execution_requires_ip_allowlist' }),
    );
    expect(prisma.securityEvent.count).not.toHaveBeenCalled();
  });

  it('requires an API key TTL of 30 days or less at runtime', async () => {
    await expect(
      service.assertAllowed({
        ...baseContext,
        expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'eoa_execution_requires_short_ttl' }),
    );
    expect(prisma.securityEvent.count).not.toHaveBeenCalled();
  });

  it('rate-limits EOA execution independently by API key security events', async () => {
    prisma.securityEvent.count.mockResolvedValue(1);

    await expect(service.assertAllowed(baseContext)).rejects.toThrow(ForbiddenException);

    expect(prisma.securityEvent.count).toHaveBeenCalledWith({
      where: {
        apiKeyId: 'api-key-1',
        eventType: 'eoa_execution_allowed',
        createdAt: { gt: expect.any(Date) },
      },
    });
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'eoa_execution_rate_limited' }),
    );
  });

  it('records an allowed event when all EOA isolation checks pass', async () => {
    await service.assertAllowed({ ...baseContext, metadata: { interactionCount: 1 } });

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        eventType: 'eoa_execution_allowed',
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        riskLevel: 'high',
        result: 'allowed',
        reason: 'eoa_execution_allowed',
        metadata: expect.objectContaining({
          operation: 'sign',
          chainId: 84532,
          apiKeyPrefix: 'sk_1234567890abcdef12345678',
          interactionCount: 1,
        }),
      }),
    );
  });
});

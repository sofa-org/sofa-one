import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { API_KEY_PREFIX_LENGTH } from '../api-key/api-key-prefix';

jest.mock('argon2', () => ({
  verify: jest.fn(),
}));

function contextWithHeaders(
  headers: Record<string, string | string[] | undefined>,
  ip = '127.0.0.1',
) {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip }),
    }),
  } as any;
}

describe('ApiKeyAuthGuard', () => {
  const rawKey = `sk_${'a'.repeat(64)}`;
  const longPrefix = rawKey.substring(0, API_KEY_PREFIX_LENGTH);
  const legacyPrefix = rawKey.substring(0, 11);
  let loggerWarnSpy: jest.SpyInstance;

  function createGuard(keyRecords: any[]) {
    const prisma = {
      apiKey: {
        findMany: jest.fn().mockResolvedValue(keyRecords),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      securityEvent: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const securityEvents = {
      record: jest.fn().mockResolvedValue({ id: 'security-event-1' }),
    };
    const guard = new ApiKeyAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
      securityEvents as any,
    );

    return { guard, prisma, securityEvents };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('rejects requests without X-API-Key even when a bearer token is present', async () => {
    const { guard, prisma } = createGuard([]);

    await expect(
      guard.canActivate(contextWithHeaders({ authorization: 'Bearer token' })),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid, revoked, or expired keys when no active prefix candidate is found', async () => {
    const { guard, prisma } = createGuard([]);

    await expect(guard.canActivate(contextWithHeaders({ 'x-api-key': rawKey }))).rejects.toThrow(
      UnauthorizedException,
    );

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          keyPrefix: { in: [longPrefix, legacyPrefix] },
          revoked: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it('rejects API keys that fail hash verification', async () => {
    const { guard } = createGuard([
      { id: 'key-1', apiKeyHash: 'hash-1', allowedIps: [], user: { id: 'user-1' } },
    ]);
    jest.mocked(argon2.verify).mockResolvedValue(false as never);

    await expect(guard.canActivate(contextWithHeaders({ 'x-api-key': rawKey }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects API keys used outside their IP allowlist', async () => {
    const { guard } = createGuard([
      {
        id: 'key-1',
        keyPrefix: longPrefix,
        apiKeyHash: 'hash-1',
        allowedIps: ['203.0.113.10'],
        user: { id: 'user-1' },
      },
    ]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(contextWithHeaders({ 'x-api-key': rawKey }, '203.0.113.11')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('authenticates a valid API key and attaches user context', async () => {
    const keyRecord = {
      id: 'key-1',
      apiKeyHash: 'hash-1',
      allowedIps: [],
      lastUsedAt: new Date('2026-05-27T00:00:00.000Z'),
      user: { id: 'user-1' },
    };
    const { guard, prisma } = createGuard([keyRecord]);
    const request: any = {
      headers: { 'x-api-key': rawKey, 'user-agent': 'sofa-agent/1.0' },
      ip: '203.0.113.10',
    };
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any),
    ).resolves.toBe(true);

    expect(request.user).toEqual({ id: 'user-1' });
    expect(request.apiKeyRecord).toBe(keyRecord);
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: {
        lastUsedAt: expect.any(Date),
        lastUsedIp: '203.0.113.10',
        lastUsedUserAgent: 'sofa-agent/1.0',
      },
    });
  });

  it('records first use when a valid API key has never been used', async () => {
    const keyRecord = {
      id: 'key-1',
      apiKeyHash: 'hash-1',
      allowedIps: [],
      lastUsedAt: null,
      user: { id: 'user-1' },
    };
    const { guard, securityEvents } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(
        contextWithHeaders(
          { 'x-api-key': rawKey, 'user-agent': 'sofa-agent/1.0' },
          '203.0.113.10',
        ),
      ),
    ).resolves.toBe(true);

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        eventType: 'api_key.first_used',
        apiKeyId: 'key-1',
        userId: 'user-1',
        riskLevel: 'low',
        ip: '203.0.113.10',
        userAgent: 'sofa-agent/1.0',
        result: 'allowed',
        reason: 'first_use',
      }),
    );
  });

  it('rejects frozen API keys and records the rejection', async () => {
    const frozenAt = new Date('2026-05-28T00:00:00.000Z');
    const { guard, securityEvents, prisma } = createGuard([
      {
        id: 'key-1',
        keyPrefix: longPrefix,
        apiKeyHash: 'hash-1',
        allowedIps: [],
        frozenAt,
        frozenReason: 'repeated_context_changed',
        user: { id: 'user-1' },
      },
    ]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(guard.canActivate(contextWithHeaders({ 'x-api-key': rawKey }))).rejects.toThrow(
      ForbiddenException,
    );

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        eventType: 'api_key_frozen_rejected',
        apiKeyId: 'key-1',
        userId: 'user-1',
        riskLevel: 'high',
        result: 'denied',
        reason: 'repeated_context_changed',
      }),
    );
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('rejects API keys for frozen users and records the rejection', async () => {
    const { guard, securityEvents, prisma } = createGuard([
      {
        id: 'key-1',
        keyPrefix: longPrefix,
        apiKeyHash: 'hash-1',
        allowedIps: [],
        lastUsedAt: new Date('2026-05-27T00:00:00.000Z'),
        user: {
          id: 'user-1',
          frozenAt: new Date('2026-05-28T00:00:00.000Z'),
          frozenReason: 'account_takeover_response',
        },
      },
    ]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(guard.canActivate(contextWithHeaders({ 'x-api-key': rawKey }))).rejects.toThrow(
      ForbiddenException,
    );

    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_key',
        eventType: 'api_key_user_frozen_rejected',
        apiKeyId: 'key-1',
        userId: 'user-1',
        riskLevel: 'high',
        result: 'denied',
        reason: 'account_takeover_response',
      }),
    );
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('records first low-risk context change without freezing the key', async () => {
    const keyRecord = {
      id: 'key-1',
      keyPrefix: longPrefix,
      apiKeyHash: 'hash-1',
      allowedIps: [],
      lastUsedIp: '203.0.113.10',
      lastUsedUserAgent: 'sofa-agent/1.0',
      canSign: false,
      canSendTransaction: false,
      canUseEoaExecution: false,
      user: { id: 'user-1' },
    };
    const { guard, prisma, securityEvents } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(
        contextWithHeaders(
          { 'x-api-key': rawKey, 'user-agent': 'sofa-agent/2.0' },
          '203.0.113.11',
        ),
      ),
    ).resolves.toBe(true);

    expect(prisma.securityEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          apiKeyId: 'key-1',
          eventType: 'api_key_suspicious_use',
        }),
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'api_key_suspicious_use',
        riskLevel: 'medium',
        result: 'allowed',
        reason: 'repeated_context_changed',
      }),
    );
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('freezes low-risk keys after repeated suspicious context changes', async () => {
    const { guard, prisma, securityEvents } = createGuard([
      {
        id: 'key-1',
        keyPrefix: longPrefix,
        apiKeyHash: 'hash-1',
        allowedIps: [],
        lastUsedIp: '203.0.113.10',
        canSign: false,
        canSendTransaction: false,
        canUseEoaExecution: false,
        user: { id: 'user-1' },
      },
    ]);
    prisma.securityEvent.count.mockResolvedValue(1);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(contextWithHeaders({ 'x-api-key': rawKey }, '203.0.113.11')),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: 'key-1', frozenAt: null },
      data: { frozenAt: expect.any(Date), frozenReason: 'repeated_context_changed' },
    });
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'api_key_frozen', riskLevel: 'critical' }),
    );
  });

  it('freezes high-risk keys immediately on suspicious context change', async () => {
    const { guard, prisma, securityEvents } = createGuard([
      {
        id: 'key-1',
        keyPrefix: longPrefix,
        apiKeyHash: 'hash-1',
        allowedIps: [],
        lastUsedUserAgent: 'sofa-agent/1.0',
        canSign: true,
        canSendTransaction: false,
        canUseEoaExecution: false,
        user: { id: 'user-1' },
      },
    ]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(
        contextWithHeaders({ 'x-api-key': rawKey, 'user-agent': 'sofa-agent/2.0' }),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.securityEvent.count).not.toHaveBeenCalled();
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: 'key-1', frozenAt: null },
      data: { frozenAt: expect.any(Date), frozenReason: 'high_risk_context_changed' },
    });
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'api_key_suspicious_use',
        riskLevel: 'high',
        result: 'denied',
        reason: 'high_risk_context_changed',
      }),
    );
  });
});

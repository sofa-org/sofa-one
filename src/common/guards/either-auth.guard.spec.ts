import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as argon2 from 'argon2';
import { EitherAuthGuard } from './either-auth.guard';
import { API_KEY_PREFIX_LENGTH } from '../api-key/api-key-prefix';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

jest.mock('argon2', () => ({
  verify: jest.fn(),
}));

function contextWithApiKey(
  apiKey: string,
  options: { ip?: string; userAgent?: string | string[] } = {},
) {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'x-api-key': apiKey, 'user-agent': options.userAgent },
        ip: options.ip ?? '127.0.0.1',
      }),
    }),
  } as any;
}

describe('EitherAuthGuard API key authentication', () => {
  const rawKey = `sk_${'a'.repeat(64)}`;
  const longPrefix = rawKey.substring(0, API_KEY_PREFIX_LENGTH);
  const legacyPrefix = rawKey.substring(0, 11);
  let loggerWarnSpy: jest.SpyInstance;

  function createGuard(keyRecords: any[]) {
    const prisma = {
      apiKey: {
        findMany: jest.fn().mockResolvedValue(keyRecords),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const ipAllowlist = {
      assertIpAllowed: jest.fn().mockImplementation(async (_clientIp: string, allowedIps: string[]) => {
        if (allowedIps.length > 0) {
          throw new ForbiddenException('IP address not allowed for this API key');
        }
      }),
    };

    const guard = new EitherAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
      { verifyIamSession: jest.fn() } as any,
      ipAllowlist as any,
    );

    return { guard, prisma, ipAllowlist };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('uses the extended prefix and verifies the matching hash', async () => {
    const keyRecord = {
      id: 'key-1',
      apiKeyHash: 'hash-1',
      allowedIps: [],
      user: { id: 'user-1' },
    };
    const { guard, prisma } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(guard.canActivate(contextWithApiKey(rawKey))).resolves.toBe(true);

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          keyPrefix: { in: [longPrefix, legacyPrefix] },
        }),
      }),
    );
    expect(argon2.verify).toHaveBeenCalledWith('hash-1', rawKey);
  });

  it('succeeds with a valid bearer session and does not invoke API-key fallback', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', socialId: 'openfort-user-1' }),
      },
      apiKey: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };
    const openfort = {
      verifyIamSession: jest.fn().mockResolvedValue({
        openfortUserId: 'openfort-user-1',
        session: { id: 'session-1' },
        email: 'user@example.com',
      }),
    };
    const ipAllowlist = {
      assertIpAllowed: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new EitherAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
      openfort as any,
      ipAllowlist as any,
    );
    const request: any = {
      headers: { authorization: 'Bearer bearer-token' },
      ip: '127.0.0.1',
    };

    await expect(
      guard.canActivate({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any),
    ).resolves.toBe(true);

    expect(openfort.verifyIamSession).toHaveBeenCalledWith('bearer-token');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { socialId: 'openfort-user-1' },
    });
    expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
    expect(request.user).toEqual({ id: 'user-1', socialId: 'openfort-user-1' });
    expect(request.openfortSession).toEqual({ id: 'session-1' });
    expect(request.openfortEmail).toBe('user@example.com');
  });

  it('prefers bearer auth when both bearer and x-api-key are present', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-2', socialId: 'openfort-user-2' }),
      },
      apiKey: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };
    const openfort = {
      verifyIamSession: jest.fn().mockResolvedValue({
        openfortUserId: 'openfort-user-2',
        session: { id: 'session-2' },
        email: 'user2@example.com',
      }),
    };
    const ipAllowlist = {
      assertIpAllowed: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new EitherAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
      openfort as any,
      ipAllowlist as any,
    );
    const request: any = {
      headers: { authorization: 'Bearer bearer-token', 'x-api-key': 'sk_test_123' },
      ip: '127.0.0.1',
    };

    await expect(
      guard.canActivate({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any),
    ).resolves.toBe(true);

    expect(openfort.verifyIamSession).toHaveBeenCalledWith('bearer-token');
    expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
    expect(request.user).toEqual({ id: 'user-2', socialId: 'openfort-user-2' });
  });

  it('uses api-key fallback only when bearer auth is absent', async () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      apiKey: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };
    const openfort = {
      verifyIamSession: jest.fn(),
    };
    const ipAllowlist = {
      assertIpAllowed: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new EitherAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
      openfort as any,
      ipAllowlist as any,
    );
    const request: any = {
      headers: { 'x-api-key': 'sk_test_456' },
      ip: '127.0.0.1',
    };

    await expect(
      guard.canActivate({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any),
    ).rejects.toThrow(UnauthorizedException);

    expect(openfort.verifyIamSession).not.toHaveBeenCalled();
    expect(prisma.apiKey.findMany).toHaveBeenCalled();
  });

  it('records last used IP and user agent metadata for verified API keys', async () => {
    const keyRecord = {
      id: 'key-1',
      apiKeyHash: 'hash-1',
      allowedIps: [],
      user: { id: 'user-1' },
    };
    const { guard, prisma } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(
        contextWithApiKey(rawKey, {
          ip: '203.0.113.10',
          userAgent: 'sofa-agent/1.0',
        }),
      ),
    ).resolves.toBe(true);

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: {
        lastUsedAt: expect.any(Date),
        lastUsedIp: '203.0.113.10',
        lastUsedUserAgent: 'sofa-agent/1.0',
      },
    });
  });

  it('truncates long user agents before storing usage metadata', async () => {
    const keyRecord = {
      id: 'key-1',
      apiKeyHash: 'hash-1',
      allowedIps: [],
      user: { id: 'user-1' },
    };
    const { guard, prisma } = createGuard([keyRecord]);
    const longUserAgent = 'a'.repeat(300);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(contextWithApiKey(rawKey, { userAgent: longUserAgent })),
    ).resolves.toBe(true);

    expect(prisma.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastUsedUserAgent: 'a'.repeat(255),
        }),
      }),
    );
  });

  it('logs a security warning when API key usage IP or user agent changes', async () => {
    const keyRecord = {
      id: 'key-1',
      keyPrefix: longPrefix,
      apiKeyHash: 'hash-1',
      allowedIps: [],
      lastUsedIp: '198.51.100.5',
      lastUsedUserAgent: 'old-agent/1.0',
      user: { id: 'user-1' },
    };
    const { guard } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(
        contextWithApiKey(rawKey, {
          ip: '203.0.113.10',
          userAgent: 'new-agent/2.0',
        }),
      ),
    ).resolves.toBe(true);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'API key usage context changed',
        apiKeyId: 'key-1',
        apiKeyPrefix: longPrefix,
        userId: 'user-1',
        ipChanged: true,
        userAgentChanged: true,
        previousIp: '198.51.100.5',
        currentIp: '203.0.113.10',
        previousUserAgent: 'old-agent/1.0',
        currentUserAgent: 'new-agent/2.0',
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(rawKey);
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain('hash-1');
  });

  it('does not log a security warning on first API key use', async () => {
    const keyRecord = {
      id: 'key-1',
      keyPrefix: longPrefix,
      apiKeyHash: 'hash-1',
      allowedIps: [],
      lastUsedIp: null,
      lastUsedUserAgent: null,
      user: { id: 'user-1' },
    };
    const { guard } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(contextWithApiKey(rawKey, { ip: '203.0.113.10', userAgent: 'agent/1.0' })),
    ).resolves.toBe(true);

    expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'security' }));
  });

  it('checks all records with the same prefix to avoid collision false negatives', async () => {
    const collidingRecords = [
      {
        id: 'wrong-key',
        apiKeyHash: 'wrong-hash',
        allowedIps: [],
        user: { id: 'wrong-user' },
      },
      {
        id: 'right-key',
        apiKeyHash: 'right-hash',
        allowedIps: [],
        user: { id: 'right-user' },
      },
    ];
    const { guard, prisma } = createGuard(collidingRecords);
    jest
      .mocked(argon2.verify)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);

    await expect(guard.canActivate(contextWithApiKey(rawKey))).resolves.toBe(true);

    expect(argon2.verify).toHaveBeenNthCalledWith(1, 'wrong-hash', rawKey);
    expect(argon2.verify).toHaveBeenNthCalledWith(2, 'right-hash', rawKey);
    expect(prisma.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'right-key' } }),
    );
  });

  it('rejects when no colliding prefix candidate verifies', async () => {
    const { guard } = createGuard([
      {
        id: 'wrong-key',
        apiKeyHash: 'wrong-hash',
        allowedIps: [],
        user: { id: 'wrong-user' },
      },
    ]);
    jest.mocked(argon2.verify).mockResolvedValue(false as never);

    await expect(guard.canActivate(contextWithApiKey(rawKey))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'API key authentication rejected',
        reason: 'hash_verification_failed',
        clientIp: '127.0.0.1',
        candidateCount: 1,
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(rawKey);
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain('wrong-hash');
  });

  it('logs a security warning when no active prefix candidates are found', async () => {
    const { guard } = createGuard([]);

    await expect(
      guard.canActivate(
        contextWithApiKey(rawKey, {
          ip: '203.0.113.50',
          userAgent: 'unknown-client/1.0',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security',
        message: 'API key authentication rejected',
        reason: 'no_active_prefix_candidate',
        clientIp: '203.0.113.50',
        userAgent: 'unknown-client/1.0',
        lookupPrefixCount: 2,
      }),
    );
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(rawKey);
  });

  it('rejects a verified API key outside its IP allowlist with ForbiddenException', async () => {
    const keyRecord = {
      id: 'key-1',
      keyPrefix: longPrefix,
      apiKeyHash: 'hash-1',
      allowedIps: ['198.51.100.0/24'],
      user: { id: 'user-1' },
    };
    const { guard, prisma, ipAllowlist } = createGuard([keyRecord]);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    await expect(
      guard.canActivate(
        contextWithApiKey(rawKey, {
          ip: '203.0.113.10',
          userAgent: 'blocked-client/1.0',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(ipAllowlist.assertIpAllowed).toHaveBeenCalledWith(
      '203.0.113.10',
      ['198.51.100.0/24'],
      expect.objectContaining({
        actorType: 'api_key',
        apiKeyId: 'key-1',
        apiKeyPrefix: longPrefix,
        userId: 'user-1',
        clientIp: '203.0.113.10',
        userAgent: 'blocked-client/1.0',
        allowedIpCount: 1,
      }),
    );
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });
});

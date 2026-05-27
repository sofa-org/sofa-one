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
      },
    };
    const guard = new ApiKeyAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
    );

    return { guard, prisma };
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
});

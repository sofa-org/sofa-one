import { Logger, UnauthorizedException } from '@nestjs/common';
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

    const guard = new EitherAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      prisma as any,
      { verifyIamSession: jest.fn() } as any,
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
  });
});

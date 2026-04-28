import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ApiKeyService } from './api-key.service';
import { API_KEY_PREFIX_LENGTH } from '../../common/api-key/api-key-prefix';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
}));

describe('ApiKeyService', () => {
  const prisma: any = {
    $transaction: jest.fn((callback: (tx: any) => unknown) => callback(prisma)),
    apiKey: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    apiKeyEvent: {
      create: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.apiKey.count.mockResolvedValue(0);
    prisma.apiKey.findFirst.mockResolvedValue(null);
    prisma.apiKey.findMany.mockResolvedValue([]);
    prisma.apiKey.create.mockImplementation(async ({ data }: any) => ({
      id: 'key-1',
      ...data,
      createdAt: new Date('2026-04-27T00:00:00.000Z'),
    }));
    prisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
    prisma.apiKeyEvent.create.mockResolvedValue({ id: 'event-1' });
    jest.mocked(argon2.hash).mockResolvedValue('argon2-hash' as never);
  });

  it('stores a 27-character prefix and audit event for newly generated API keys', async () => {
    const service = new ApiKeyService(prisma as any);

    const result = await service.createApiKey('user-1', { name: 'Production key' });

    expect(result.rawKey).toMatch(/^sk_[a-f0-9]{64}$/);
    expect(result.keyPrefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(result.keyPrefix).toBe(result.rawKey.substring(0, API_KEY_PREFIX_LENGTH));
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          keyPrefix: result.keyPrefix,
          apiKeyHash: 'argon2-hash',
          name: 'Production key',
          allowedChains: [84532],
        }),
      }),
    );
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          apiKeyId: 'key-1',
          action: 'api_key.created',
          keyName: 'Production key',
        }),
      }),
    );
  });

  it('rejects blank API key names', async () => {
    const service = new ApiKeyService(prisma as any);

    await expect(service.createApiKey('user-1', { name: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate active API key names case-insensitively', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'existing-key' });
    const service = new ApiKeyService(prisma as any);

    await expect(service.createApiKey('user-1', { name: 'Production key' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          revoked: false,
          name: { equals: 'Production key', mode: 'insensitive' },
        }),
      }),
    );
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('rejects API key creation above the active-key limit', async () => {
    prisma.apiKey.count.mockResolvedValue(10);
    const service = new ApiKeyService(prisma as any);

    await expect(service.createApiKey('user-1', { name: 'Overflow key' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('rejects past and overly distant expiration dates', async () => {
    const service = new ApiKeyService(prisma as any);

    await expect(
      service.createApiKey('user-1', { name: 'Past key', expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createApiKey('user-1', {
        name: 'Too long key',
        expiresAt: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unsupported allowed chains', async () => {
    const service = new ApiKeyService(prisma as any);

    await expect(
      service.createApiKey('user-1', { name: 'Bad chain', allowedChains: [999999] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('audits single-key revocation and rejects unknown keys', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      keyPrefix: 'sk_1234567890abcdef12345678',
      name: 'Production key',
      revoked: false,
    });
    const service = new ApiKeyService(prisma as any);

    await expect(service.revokeApiKey('key-1', 'user-1')).resolves.toEqual({ count: 1 });
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.revoked',
          apiKeyId: 'key-1',
          keyName: 'Production key',
        }),
      }),
    );

    prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(service.revokeApiKey('missing', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rotates keys atomically by revoking active keys and creating one replacement', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 'old-key-1', keyPrefix: 'sk_old11111111111111111111', name: 'Old key' },
    ]);
    const service = new ApiKeyService(prisma as any);

    const result = await service.rotateApiKey('user-1', 'Refreshed');

    expect(result.rawKey).toMatch(/^sk_[a-f0-9]{64}$/);
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Refreshed' }) }),
    );
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'api_key.rotated' }) }),
    );
  });

  it('lists metadata only and never selects API key hashes', async () => {
    prisma.apiKey.findMany.mockResolvedValue([]);
    const service = new ApiKeyService(prisma as any);

    await service.listApiKeys('user-1');

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        select: expect.not.objectContaining({ apiKeyHash: true }),
      }),
    );
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { ApiKeyService } from './api-key.service';
import { API_KEY_PREFIX_LENGTH } from '../../common/api-key/api-key-prefix';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
}));

describe('ApiKeyService', () => {
  const defaultPermissions = {
    canSign: false,
    canSendTransaction: false,
    canReadTransactionStatus: true,
    canUseEoaExecution: false,
  };

  const prisma: any = {
    $transaction: jest.fn((callback: (tx: any) => unknown) => callback(prisma)),
    $queryRaw: jest.fn(),
    apiKey: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    apiKeyEvent: {
      create: jest.fn(),
    },
  };
  const securityEvents = {
    record: jest.fn(),
    exportCommitted: jest.fn(),
  };
  const grants = { normalizeIds: (ids: string[] = []) => [...ids].sort(), assertGrantableInTx: jest.fn() };
  const policy = { recordDenied: jest.fn() };
  let transactionOpen = false;
  const createService = () => new ApiKeyService(prisma as any, securityEvents as any, grants as any, policy as any);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    transactionOpen = false;
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) => {
      transactionOpen = true;
      try { return await callback(prisma); } finally { transactionOpen = false; }
    });
    securityEvents.record.mockImplementation(async () => {
      expect(transactionOpen).toBe(true);
      expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
      return { id: 'security-event-1', eventType: 'api_key.event' };
    });
    securityEvents.exportCommitted.mockImplementation(async () => {
      expect(transactionOpen).toBe(false);
    });
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
    securityEvents.record.mockResolvedValue({ id: 'security-event-1' });
    // Default FOR UPDATE lock rows empty unless a test sets them.
    prisma.$queryRaw.mockResolvedValue([]);
    jest.mocked(argon2.hash).mockResolvedValue('argon2-hash' as never);
  });

  it('replaces grants only for an owned active key and exports audit after transaction success', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: false, frozen_at: null, expires_at: null, allowed_capability_ids: [], capability_mode: 'custom' }]);
    prisma.apiKey.update.mockResolvedValue({ id: 'key-1', capabilityMode: 'custom', allowedCapabilityIds: ['cap:a:v1'] });
    const service = createService();
    await expect(service.replaceCapabilities('key-1', 'user-1', ['cap:a:v1'])).resolves.toEqual({ id: 'key-1', capabilityMode: 'custom', allowedCapabilityIds: ['cap:a:v1'] });
    expect(securityEvents.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'defi.grants_updated' }), prisma, { deferExport: true });
    expect(securityEvents.exportCommitted).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  });

  it('does not audit or export a no-op replacement and rejects non-owned keys', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: false, frozen_at: null, expires_at: null, allowed_capability_ids: ['cap:a:v1'], capability_mode: 'custom' }]);
    const service = createService();
    await service.replaceCapabilities('key-1', 'user-1', ['cap:a:v1']);
    expect(securityEvents.record).not.toHaveBeenCalled();
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.replaceCapabilities('not-owned', 'user-1', [])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects inactive keys and never exports events for a failed grant update', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: false, frozen_at: new Date(), expires_at: null, allowed_capability_ids: [], capability_mode: 'custom' }]);
    const service = createService();
    await expect(service.replaceCapabilities('key-1', 'user-1', ['cap:a:v1'])).rejects.toThrow(/not active/i);
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: false, frozen_at: null, expires_at: null, allowed_capability_ids: [], capability_mode: 'custom' }]);
    prisma.apiKey.update.mockRejectedValue(new Error('write failed'));
    await expect(service.replaceCapabilities('key-1', 'user-1', ['cap:a:v1'])).rejects.toThrow('write failed');
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
  });

  it('stores a 27-character prefix and audit event for newly generated API keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
    const service = createService();

    const result = await service.createApiKey('user-1', { name: 'Production key' });

    expect(result.rawKey).toMatch(/^sk_[a-f0-9]{64}$/);
    expect(result).toEqual({
      rawKey: expect.any(String),
      id: 'key-1',
      displayPrefix: 'sk_'.concat(result.rawKey.slice(3, 11), '...'),
      name: 'Production key',
      expiresAt: new Date('2026-07-26T00:00:00.000Z'),
      createdAt: new Date('2026-04-27T00:00:00.000Z'),
      permissions: defaultPermissions,
      allowedCapabilityIds: [],
      capabilityMode: 'all',
    });
    expect(prisma.apiKey.create.mock.calls[0][0].data.keyPrefix).toBe(
      result.rawKey.slice(0, API_KEY_PREFIX_LENGTH),
    );
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          keyPrefix: expect.stringMatching(/^sk_[a-f0-9]{24}$/),
          apiKeyHash: 'argon2-hash',
          name: 'Production key',
          expiresAt: new Date('2026-07-26T00:00:00.000Z'),
          ...defaultPermissions,
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
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        userId: 'user-1',
        apiKeyId: 'key-1',
        eventType: 'api_key.created',
        riskLevel: 'low',
        result: 'allowed',
        metadata: expect.objectContaining({
          keyName: 'Production key',
          keyPrefix: expect.stringMatching(/^sk_[a-f0-9]{24}$/),
          details: expect.objectContaining({
            expiresAt: '2026-07-26T00:00:00.000Z',
            permissions: defaultPermissions,
            allowedCapabilityIds: [],
            capabilityMode: 'all',
          }),
        }),
      }),
      prisma,
      { deferExport: true },
    );
  });

  it('accepts ClobAuth only through explicit create/replace grants and leaves rotation empty', async () => {
    const capability = 'polymarket:137:clob-auth:v1';
    const service = createService();
    await service.createApiKey('user-1', { name: 'Clob', allowedCapabilityIds: [capability] } as any);
    expect(grants.assertGrantableInTx).toHaveBeenCalledWith(prisma, [capability]);
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: false, frozen_at: null, expires_at: null, allowed_capability_ids: [] }]);
    prisma.apiKey.update.mockResolvedValue({ id: 'key-1', allowedCapabilityIds: [capability] });
    await service.replaceCapabilities('key-1', 'user-1', [capability]);
    expect(grants.assertGrantableInTx).toHaveBeenLastCalledWith(prisma, [capability]);
    prisma.apiKey.findMany.mockResolvedValue([]);
    await service.rotateApiKey('user-1', 'Rotated');
    expect(grants.assertGrantableInTx).toHaveBeenLastCalledWith(prisma, []);
  });

  it('normalizes dynamic all/custom capability semantics and rejects invalid combinations', async () => {
    const service = createService();
    await service.createApiKey('user-1', { name: 'Default all' });
    expect(prisma.apiKey.create.mock.calls.at(-1)[0].data).toEqual(expect.objectContaining({ capabilityMode: 'all', allowedCapabilityIds: [] }));
    await service.createApiKey('user-1', { name: 'Explicit all', capabilityMode: 'all', allowedCapabilityIds: [] });
    await service.createApiKey('user-1', { name: 'Empty custom', allowedCapabilityIds: [] });
    expect(prisma.apiKey.create.mock.calls.at(-1)[0].data).toEqual(expect.objectContaining({ capabilityMode: 'custom', allowedCapabilityIds: [] }));
    for (const options of [
      { name: 'Bad null mode', capabilityMode: null },
      { name: 'Bad null IDs', allowedCapabilityIds: null },
      { name: 'Bad unknown', capabilityMode: 'future' },
      { name: 'Bad custom omitted', capabilityMode: 'custom' },
      { name: 'Bad all IDs', capabilityMode: 'all', allowedCapabilityIds: ['cap:a:v1'] },
    ]) await expect(service.createApiKey('user-1', options as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PATCH replaces both fields, supports mode-only reset, rejects empty body, and compares mode in no-op checks', async () => {
    const service = createService();
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: false, frozen_at: null, expires_at: null, allowed_capability_ids: ['cap:a:v1'], capability_mode: 'custom' }]);
    prisma.apiKey.update.mockResolvedValue({ id: 'key-1', capabilityMode: 'all', allowedCapabilityIds: [] });
    await expect(service.replaceCapabilities('key-1', 'user-1', { capabilityMode: 'all' })).resolves.toEqual({ id: 'key-1', capabilityMode: 'all', allowedCapabilityIds: [] });
    expect(prisma.apiKey.update).toHaveBeenLastCalledWith({ where: { id: 'key-1' }, data: { capabilityMode: 'all', allowedCapabilityIds: [] } });
    expect(securityEvents.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ previousCapabilityMode: 'custom', capabilityMode: 'all' }) }), prisma, { deferExport: true });
    await expect(service.replaceCapabilities('key-1', 'user-1', {})).rejects.toBeInstanceOf(BadRequestException);
    for (const invalid of [{ capabilityMode: null }, { allowedCapabilityIds: null }, { capabilityMode: 'custom' }, { capabilityMode: 'all', allowedCapabilityIds: ['x'] }]) {
      await expect(service.replaceCapabilities('key-1', 'user-1', invalid as any)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects blank API key names', async () => {
    const service = createService();

    await expect(service.createApiKey('user-1', { name: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate active API key names case-insensitively', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'existing-key' });
    const service = createService();

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

  it('trims names before duplicate checks and persistence', async () => {
    const service = createService();

    await service.createApiKey('user-1', { name: '  Production key  ' });

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          revoked: false,
          name: { equals: 'Production key', mode: 'insensitive' },
        }),
      }),
    );
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Production key' }),
      }),
    );
  });

  it('rejects API key creation above the active-key limit', async () => {
    prisma.apiKey.count.mockResolvedValue(10);
    const service = createService();

    await expect(service.createApiKey('user-1', { name: 'Overflow key' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('excludes revoked keys from name uniqueness and active-key limit checks', async () => {
    prisma.apiKey.count.mockResolvedValue(9);
    const service = createService();

    await service.createApiKey('user-1', { name: 'Fresh key' });

    expect(prisma.apiKey.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
    });
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          revoked: false,
          name: { equals: 'Fresh key', mode: 'insensitive' },
        }),
      }),
    );
    expect(prisma.apiKey.create).toHaveBeenCalled();
  });

  it('rejects past and overly distant expiration dates', async () => {
    const service = createService();

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

  it('accepts explicit expiration dates within 365 days', async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const service = createService();

    await service.createApiKey('user-1', { name: 'Short lived key', expiresAt });

    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt }),
      }),
    );
  });

  it('stores explicit API key permissions with IP allowlist for high-risk permissions', async () => {
    const service = createService();

    await service.createApiKey('user-1', {
      name: 'Signer key',
      permissions: { canSign: true, canUseEoaExecution: true },
      allowedIps: ['203.0.113.0/24'],
    });

    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          canSign: true,
          canSendTransaction: false,
          canReadTransactionStatus: true,
          canUseEoaExecution: true,
          allowedIps: ['203.0.113.0/24'],
        }),
      }),
    );
  });

  it('audits single-key revocation and rejects unknown keys', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'key-1',
        key_prefix: 'sk_1234567890abcdef12345678',
        name: 'Production key',
        revoked: false,
      },
    ]);
    const service = createService();

    await expect(service.revokeApiKey('key-1', 'user-1')).resolves.toEqual({ count: 1 });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.revoked',
          apiKeyId: 'key-1',
          keyName: 'Production key',
        }),
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        userId: 'user-1',
        apiKeyId: 'key-1',
        eventType: 'api_key.revoked',
        result: 'allowed',
        metadata: expect.objectContaining({
          keyName: 'Production key',
          keyPrefix: 'sk_1234567890abcdef12345678',
        }),
      }),
      prisma,
      { deferExport: true },
    );
    expect(securityEvents.exportCommitted).toHaveBeenCalledTimes(1);

    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.revokeApiKey('missing', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not audit or export when the key was already revoked', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'key-1', key_prefix: 'sk_abc', name: 'Key', revoked: true }]);
    const service = createService();
    await expect(service.revokeApiKey('key-1', 'user-1')).resolves.toEqual({ count: 0 });
    expect(prisma.apiKeyEvent.create).not.toHaveBeenCalled();
    expect(securityEvents.record).not.toHaveBeenCalled();
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
  });

  it('bulk revokes active keys and audits each revoked key', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 'key-1', keyPrefix: 'sk_111111111111111111111111', name: 'Primary' },
      { id: 'key-2', keyPrefix: 'sk_222222222222222222222222', name: 'Backup' },
    ]);
    prisma.apiKey.updateMany.mockResolvedValue({ count: 2 });
    const service = createService();

    await expect(service.revokeAllKeys('user-1')).resolves.toEqual({ count: 2 });

    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.revoked',
          apiKeyId: 'key-1',
          keyName: 'Primary',
          metadata: { reason: 'bulk_revoke' },
        }),
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'api_key.revoked',
        apiKeyId: 'key-1',
        metadata: expect.objectContaining({
          keyName: 'Primary',
          keyPrefix: 'sk_111111111111111111111111',
          details: { reason: 'bulk_revoke' },
        }),
      }),
      prisma,
      { deferExport: true },
    );
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.revoked',
          apiKeyId: 'key-2',
          keyName: 'Backup',
          metadata: { reason: 'bulk_revoke' },
        }),
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'api_key.revoked',
        apiKeyId: 'key-2',
        metadata: expect.objectContaining({
          keyName: 'Backup',
          keyPrefix: 'sk_222222222222222222222222',
          details: { reason: 'bulk_revoke' },
        }),
      }),
      prisma,
      { deferExport: true },
    );
    expect(securityEvents.exportCommitted).toHaveBeenCalledTimes(2);
  });

  it('does not export when revoke-all has no active keys', async () => {
    prisma.apiKey.findMany.mockResolvedValue([]);
    prisma.apiKey.updateMany.mockResolvedValue({ count: 0 });
    const service = createService();
    await expect(service.revokeAllKeys('user-1')).resolves.toEqual({ count: 0 });
    expect(securityEvents.record).not.toHaveBeenCalled();
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
  });

  it('rejects revoke-all when auditing fails so the transaction can roll back', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 'key-1', keyPrefix: 'sk_111111111111111111111111', name: 'Primary' },
      { id: 'key-2', keyPrefix: 'sk_222222222222222222222222', name: 'Backup' },
    ]);
    prisma.apiKeyEvent.create.mockImplementationOnce(async () => ({ id: 'event-1' }));
    prisma.apiKeyEvent.create.mockImplementationOnce(async () => {
      throw new Error('audit failed');
    });
    const service = createService();

    await expect(service.revokeAllKeys('user-1')).rejects.toThrow('audit failed');
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledTimes(2);
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
  });

  it('rejects revoke-all when security event recording fails so the transaction can roll back', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 'key-1', keyPrefix: 'sk_111111111111111111111111', name: 'Primary' },
    ]);
    securityEvents.record.mockRejectedValueOnce(new Error('security event failed'));
    const service = createService();

    await expect(service.revokeAllKeys('user-1')).rejects.toThrow('security event failed');
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'api_key.revoked',
        apiKeyId: 'key-1',
      }),
      prisma,
      { deferExport: true },
    );
    expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
  });

  it('rotates keys atomically by revoking active keys and creating one replacement', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 'old-key-1', keyPrefix: 'sk_old11111111111111111111', name: 'Old key' },
      { id: 'old-key-2', keyPrefix: 'sk_old22222222222222222222', name: 'Backup key' },
    ]);
    const service = createService();

    const result = await service.rotateApiKey('user-1', 'Refreshed');

    expect(result.rawKey).toMatch(/^sk_[a-f0-9]{64}$/);
    expect(result).toEqual({
      rawKey: expect.any(String),
      id: 'key-1',
      displayPrefix: 'sk_'.concat(result.rawKey.slice(3, 11), '...'),
      name: 'Refreshed',
      expiresAt: new Date('2026-07-26T00:00:00.000Z'),
      createdAt: new Date('2026-04-27T00:00:00.000Z'),
      permissions: defaultPermissions,
      allowedCapabilityIds: [],
      capabilityMode: 'all',
    });
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Refreshed',
          expiresAt: new Date('2026-07-26T00:00:00.000Z'),
          ...defaultPermissions,
        }),
      }),
    );
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.revoked',
          apiKeyId: 'old-key-1',
          metadata: { reason: 'rotation' },
        }),
      }),
    );
    expect(securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'api_key.rotated',
        apiKeyId: 'key-1',
        metadata: expect.objectContaining({
          keyName: 'Refreshed',
          details: {
            revokedKeyCount: 2,
            expiresAt: '2026-07-26T00:00:00.000Z',
            permissions: defaultPermissions,
            allowedCapabilityIds: [],
            capabilityMode: 'all',
          },
        }),
      }),
      prisma,
      { deferExport: true },
    );
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.revoked',
          apiKeyId: 'old-key-2',
          metadata: { reason: 'rotation' },
        }),
      }),
    );
    expect(prisma.apiKeyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'api_key.rotated',
          metadata: {
            revokedKeyCount: 2,
            expiresAt: '2026-07-26T00:00:00.000Z',
            permissions: defaultPermissions,
            allowedCapabilityIds: [],
            capabilityMode: 'all',
          },
        }),
      }),
    );
  });

  it('does not create a replacement key if rotation auditing fails', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      { id: 'old-key-1', keyPrefix: 'sk_old11111111111111111111', name: 'Old key' },
    ]);
    prisma.apiKeyEvent.create.mockImplementationOnce(async () => {
      throw new Error('rotation audit failed');
    });
    const service = createService();

    await expect(service.rotateApiKey('user-1', 'Refreshed')).rejects.toThrow(
      'rotation audit failed',
    );
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('lists masked metadata only and never selects API key hashes or allowlists', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'key-1',
        keyPrefix: 'sk_1234567890abcdef12345678',
        name: 'Production key',
        revoked: false,
        frozenAt: new Date('2026-04-28T00:00:00.000Z'),
        frozenReason: 'repeated_context_changed',
        expiresAt: null,
        createdAt: new Date('2026-04-27T00:00:00.000Z'),
        lastUsedAt: null,
        lastUsedIp: '203.0.113.10',
        lastUsedUserAgent: 'sofa-agent/1.0',
        canSign: true,
        canSendTransaction: false,
        canReadTransactionStatus: true,
        canUseEoaExecution: false,
        allowedIps: [],
        allowedCapabilityIds: [],
        capabilityMode: 'all',
        dailySpendLimit: null,
        monthlySpendLimit: null,
        directEgressPolicyAcceptedAt: null,
      },
    ]);
    const service = createService();

    await expect(service.listApiKeys('user-1')).resolves.toEqual([
      {
        id: 'key-1',
        displayPrefix: 'sk_12345678...',
        name: 'Production key',
        revoked: false,
        frozenAt: new Date('2026-04-28T00:00:00.000Z'),
        frozenReason: 'repeated_context_changed',
        expiresAt: null,
        createdAt: new Date('2026-04-27T00:00:00.000Z'),
        lastUsedAt: null,
        lastUsedIp: '203.0.113.10',
        lastUsedUserAgent: 'sofa-agent/1.0',
        permissions: {
          canSign: true,
          canSendTransaction: false,
          canReadTransactionStatus: true,
          canUseEoaExecution: false,
        },
        allowedIps: [],
        allowedCapabilityIds: [],
        capabilityMode: 'all',
        dailySpendLimit: null,
        monthlySpendLimit: null,
        directEgressPolicyAcceptedAt: null,
      },
    ]);

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        select: expect.objectContaining({
          directEgressPolicyAcceptedAt: true,
          capabilityMode: true,
        }),
      }),
    );
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ apiKeyHash: true }),
      }),
    );
  });

  describe('authorizeDirectEgress', () => {
    function lockRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'key-1',
        key_prefix: 'sk_abc',
        name: 'Send key',
        revoked: false,
        frozen_at: null,
        expires_at: null,
        can_send_transaction: true,
        direct_egress_policy_accepted_at: null,
        ...overrides,
      };
    }

    it('CAS-sets directEgressPolicyAcceptedAt for an eligible send key', async () => {
      prisma.$queryRaw.mockResolvedValue([lockRow()]);
      prisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
      const service = createService();

      const result = await service.authorizeDirectEgress('key-1', 'user-1');
      expect(result.outcome).toBe('authorized');
      expect(result.directEgressPolicyAcceptedAt).toBeInstanceOf(Date);
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.apiKey.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'key-1',
            directEgressPolicyAcceptedAt: null,
            canSendTransaction: true,
          }),
          data: expect.objectContaining({
            directEgressPolicyAcceptedAt: expect.any(Date),
          }),
        }),
      );
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'api_key.direct_egress_authorized',
        }),
        expect.anything(),
        { deferExport: true },
      );
      expect(securityEvents.exportCommitted).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when already authorized', async () => {
      const acceptedAt = new Date('2026-06-01T00:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([
        lockRow({ direct_egress_policy_accepted_at: acceptedAt }),
      ]);
      const service = createService();

      await expect(service.authorizeDirectEgress('key-1', 'user-1')).resolves.toEqual({
        id: 'key-1',
        directEgressPolicyAcceptedAt: acceptedAt,
        outcome: 'unchanged',
      });
      expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
      expect(securityEvents.record).not.toHaveBeenCalled();
      expect(securityEvents.exportCommitted).not.toHaveBeenCalled();
    });

    it('rejects revoked, frozen, expired, and non-send keys', async () => {
      const service = createService();
      prisma.$queryRaw.mockResolvedValue([lockRow({ revoked: true })]);
      await expect(service.authorizeDirectEgress('key-1', 'user-1')).rejects.toThrow(/revoked/i);

      prisma.$queryRaw.mockResolvedValue([lockRow({ frozen_at: new Date() })]);
      await expect(service.authorizeDirectEgress('key-1', 'user-1')).rejects.toThrow(/frozen/i);

      prisma.$queryRaw.mockResolvedValue([
        lockRow({ expires_at: new Date('2020-01-01T00:00:00.000Z') }),
      ]);
      await expect(service.authorizeDirectEgress('key-1', 'user-1')).rejects.toThrow(/expired/i);

      prisma.$queryRaw.mockResolvedValue([lockRow({ can_send_transaction: false })]);
      await expect(service.authorizeDirectEgress('key-1', 'user-1')).rejects.toThrow(
        /not allowed to send/i,
      );
    });
  });

  // ── SEC-APIKEY-002: High-risk permissions require IP allowlist ──

  describe('IP allowlist requirement for high-risk permissions', () => {
    it('rejects canSign without IP allowlist', async () => {
      const service = createService();

      await expect(
        service.createApiKey('user-1', {
          name: 'Signer key',
          permissions: { canSign: true },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('rejects canSendTransaction without IP allowlist', async () => {
      const service = createService();

      await expect(
        service.createApiKey('user-1', {
          name: 'Tx key',
          permissions: { canSendTransaction: true },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('rejects canUseEoaExecution without IP allowlist', async () => {
      const service = createService();

      await expect(
        service.createApiKey('user-1', {
          name: 'EOA key',
          permissions: { canUseEoaExecution: true },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('allows read-only keys without IP allowlist', async () => {
      const service = createService();

      await service.createApiKey('user-1', {
        name: 'Read-only key',
        permissions: { canReadTransactionStatus: true },
      });

      expect(prisma.apiKey.create).toHaveBeenCalled();
    });

    it('allows default-permission keys without IP allowlist', async () => {
      const service = createService();

      await service.createApiKey('user-1', { name: 'Default key' });

      expect(prisma.apiKey.create).toHaveBeenCalled();
    });

    it('allows high-risk permissions when IP allowlist is provided', async () => {
      const service = createService();

      await service.createApiKey('user-1', {
        name: 'Signer key',
        permissions: { canSign: true },
        allowedIps: ['203.0.113.10'],
      });

      expect(prisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            canSign: true,
            allowedIps: ['203.0.113.10'],
          }),
        }),
      );
    });

    it('allows high-risk permissions with CIDR IP allowlist', async () => {
      const service = createService();

      await service.createApiKey('user-1', {
        name: 'Tx key',
        permissions: { canSendTransaction: true },
        allowedIps: ['10.0.0.0/8', '2001:db8::/32'],
      });

      expect(prisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            canSendTransaction: true,
            allowedIps: ['10.0.0.0/8', '2001:db8::/32'],
          }),
        }),
      );
    });
  });

  // ── SEC-APIKEY-003: Permission-based TTL limits ──

  describe('permission-based TTL limits', () => {
    it('rejects canUseEoaExecution key with TTL exceeding 30 days', async () => {
      const service = createService();

      await expect(
        service.createApiKey('user-1', {
          name: 'EOA key',
          permissions: { canUseEoaExecution: true },
          allowedIps: ['203.0.113.10'],
          expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('accepts canUseEoaExecution key with TTL within 30 days', async () => {
      const service = createService();

      await service.createApiKey('user-1', {
        name: 'EOA key',
        permissions: { canUseEoaExecution: true },
        allowedIps: ['203.0.113.10'],
        expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
      });

      expect(prisma.apiKey.create).toHaveBeenCalled();
    });

    it('rejects canSign key with TTL exceeding 90 days', async () => {
      const service = createService();

      await expect(
        service.createApiKey('user-1', {
          name: 'Signer key',
          permissions: { canSign: true },
          allowedIps: ['203.0.113.10'],
          expiresAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000),
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('accepts canSign key with TTL within 90 days', async () => {
      const service = createService();

      await service.createApiKey('user-1', {
        name: 'Signer key',
        permissions: { canSign: true },
        allowedIps: ['203.0.113.10'],
        expiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      });

      expect(prisma.apiKey.create).toHaveBeenCalled();
    });

    it('rejects canSendTransaction key with TTL exceeding 90 days', async () => {
      const service = createService();

      await expect(
        service.createApiKey('user-1', {
          name: 'Tx key',
          permissions: { canSendTransaction: true },
          allowedIps: ['203.0.113.10'],
          expiresAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000),
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('accepts read-only key with TTL up to 365 days', async () => {
      const service = createService();

      await service.createApiKey('user-1', {
        name: 'Read-only key',
        permissions: { canReadTransactionStatus: true },
        expiresAt: new Date(Date.now() + 364 * 24 * 60 * 60 * 1000),
      });

      expect(prisma.apiKey.create).toHaveBeenCalled();
    });

    it('uses most restrictive TTL when multiple high-risk permissions are combined', async () => {
      const service = createService();

      // canSign + canUseEoaExecution → max TTL is 30 days (most restrictive)
      await expect(
        service.createApiKey('user-1', {
          name: 'Combined key',
          permissions: { canSign: true, canUseEoaExecution: true },
          allowedIps: ['203.0.113.10'],
          expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });

    it('caps default TTL to permission-based max for EOA keys', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
      const service = createService();

      // Default TTL is 90 days, but EOA max is 30 days → should get 30-day expiry
      const result = await service.createApiKey('user-1', {
        name: 'EOA key',
        permissions: { canUseEoaExecution: true },
        allowedIps: ['203.0.113.10'],
      });

      // Default TTL for EOA should be min(90 days, 30 days) = 30 days
      expect(result.expiresAt).toEqual(new Date('2026-05-27T00:00:00.000Z'));
    });

    it('uses 90-day default TTL for read-only keys', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
      const service = createService();

      const result = await service.createApiKey('user-1', { name: 'Read-only key' });

      // Default TTL for read-only is min(90 days, 365 days) = 90 days
      expect(result.expiresAt).toEqual(new Date('2026-07-26T00:00:00.000Z'));
    });
  });
});

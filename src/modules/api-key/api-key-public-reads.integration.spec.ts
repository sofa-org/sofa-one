import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import * as argon2 from 'argon2';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { IpAllowlistService } from '../../common/guards/ip-allowlist.service';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from '../billing/billing.service';
import { BillingDebtService } from '../billing/billing-debt.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiCatalogService } from '../defi/defi-catalog.service';
import { DefiCapabilityQueryController } from '../defi/defi-capability-query.controller';
import { ApiKeyPermissionsController } from './api-key-permissions.controller';
import { ApiKeyWalletController } from '../wallet/wallet.controller';
import { WalletService } from '../wallet/wallet.service';

jest.mock('argon2', () => ({ verify: jest.fn() }));
jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));
jest.mock('../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));

const key = 'sk_' + 'a'.repeat(64);
const user = { id: 'owner-id', frozenAt: null };
const record = {
  id: 'key-id',
  userId: user.id,
  apiKeyHash: 'hash',
  keyPrefix: key.slice(0, 27),
  user,
  revoked: false,
  expiresAt: null,
  frozenAt: null,
  frozenReason: null,
  canSign: false,
  canSendTransaction: false,
  canReadTransactionStatus: false,
  canUseEoaExecution: false,
  capabilityMode: 'custom',
  allowedCapabilityIds: [],
  allowedIps: [],
  dailySpendLimit: null,
  monthlySpendLimit: null,
  lastUsedAt: new Date(),
  lastUsedIp: null,
  lastUsedUserAgent: null,
  apiKeyHashSecret: 'must-not-leak',
};

@Module({
  controllers: [ApiKeyPermissionsController, DefiCapabilityQueryController, ApiKeyWalletController],
  providers: [
    ApiKeyAuthGuard,
    {
      provide: PrismaService,
      useValue: {
        apiKey: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
        userWallet: { findMany: jest.fn().mockResolvedValue([]) },
      },
    },
    { provide: SecurityEventService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
    {
      provide: IpAllowlistService,
      useValue: { assertIpAllowed: jest.fn().mockResolvedValue(undefined) },
    },
    {
      provide: BillingService,
      useValue: { assertAndRecordApiCall: jest.fn().mockResolvedValue(undefined) },
    },
    {
      provide: BillingDebtService,
      useValue: { hasEnforceableApiDebt: jest.fn().mockResolvedValue(false) },
    },
    {
      provide: DefiCatalogService,
      useValue: {
        listMetadataByIds: jest
          .fn()
          .mockResolvedValue({ capabilities: [], unknownIds: ['some-id'] }),
      },
    },
    {
      provide: WalletService,
      useValue: { listApiKeyWallets: jest.fn().mockResolvedValue({ wallets: [] }) },
    },
  ],
})
class HttpTestModule {}

describe('API-key read endpoints (HTTP with real ApiKeyAuthGuard)', () => {
  let app: INestApplication;
  let prisma: any;
  let walletService: any;

  beforeAll(async () => {
    (argon2.verify as jest.Mock).mockResolvedValue(true);
    const module = await Test.createTestingModule({ imports: [HttpTestModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = module.get(PrismaService);
    walletService = module.get(WalletService);
    expect(module.get(ApiKeyAuthGuard)).toBeInstanceOf(ApiKeyAuthGuard);
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    prisma.apiKey.findMany.mockResolvedValue([{ ...record }]);
  });

  const endpoints = ['/v1/permissions', '/v1/capabilities?ids=some-id', '/v1/me/wallets'];
  it.each(endpoints)('rejects missing key and bearer-only access: %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer iam-token')
      .expect(401);
  });

  it.each(endpoints)(
    'allows a valid key without permission grants or Origin and sends no-store: %s',
    async (path) => {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('X-API-Key', key)
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
      expect(JSON.stringify(response.body)).not.toContain('apiKeyHash');
    },
  );

  it('passes authenticated owner, not caller query, to wallet service', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/me/wallets?userId=attacker')
      .set('X-API-Key', key)
      .expect(200);
    expect(walletService.listApiKeyWallets).toHaveBeenCalledWith(user.id);
    expect(JSON.stringify(response.body)).not.toMatch(/openfortAccountId|apiKeyHash/);
  });

  it('returns configured non-default permission values through authenticated request', async () => {
    prisma.apiKey.findMany.mockResolvedValueOnce([
      {
        ...record,
        canSign: true,
        canReadTransactionStatus: true,
        allowedIps: ['192.0.2.4'],
        dailySpendLimit: '100',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);
    const response = await request(app.getHttpServer())
      .get('/v1/permissions')
      .set('X-API-Key', key)
      .expect(200);
    expect(response.body.permissions).toMatchObject({
      canSign: true,
      canSendTransaction: false,
      canReadTransactionStatus: true,
      canUseEoaExecution: false,
    });
    expect(response.body.constraints).toMatchObject({
      allowedIps: ['192.0.2.4'],
      spendLimits: { daily: '100', monthly: null },
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
});

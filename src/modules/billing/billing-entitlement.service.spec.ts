import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingEntitlementService } from './billing-entitlement.service';

const ACCOUNT = { id: 'acc-1', userId: 'user-1', currency: 'USD' };

const STARTER_VERSION = {
  id: 'plan-starter-1',
  code: 'starter',
  version: 1,
  name: 'Starter',
  monthlyFeeMicros: 49_000_000n,
  includedOutboundMicros: 250_000_000_000n,
  includedApiCalls: 100_000n,
  includedWallets: 100,
  apiOverageRateMicros: 0n,
  walletOverageRateMicros: 0n,
};

const ENTERPRISE_VERSION = {
  id: 'plan-enterprise-1',
  code: 'enterprise',
  version: 1,
  name: 'Enterprise',
  monthlyFeeMicros: null,
  includedOutboundMicros: null,
  includedApiCalls: null,
  includedWallets: null,
  apiOverageRateMicros: 0n,
  walletOverageRateMicros: 0n,
};

describe('BillingEntitlementService', () => {
  let service: BillingEntitlementService;

  const accountFindUnique = jest.fn();
  const assignmentFindMany = jest.fn();
  const walletFindFirst = jest.fn();
  const walletCount = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEntitlementService,
        {
          provide: PrismaService,
          useValue: {
            billingAccount: { findUnique: accountFindUnique },
            billingPlanAssignment: { findMany: assignmentFindMany },
            userWallet: { findFirst: walletFindFirst, count: walletCount },
          },
        },
      ],
    }).compile();

    service = module.get<BillingEntitlementService>(BillingEntitlementService);
  });

  it('returns Free fallback entitlements when the user has no account', async () => {
    accountFindUnique.mockResolvedValue(null);

    const result = await service.getEntitlements('user-1', '2026-09');

    expect(result).toEqual({
      planCode: 'free',
      planName: 'Free',
      effectivePeriod: '2026-09',
      includedApiCalls: 10_000,
      includedWallets: 10,
    });
  });

  it('returns the plan in effect for the requested period', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: STARTER_VERSION,
      },
    ]);

    const result = await service.getEntitlements('user-1', '2026-09');

    expect(result).toEqual({
      planCode: 'starter',
      planName: 'Starter',
      effectivePeriod: '2026-09',
      includedApiCalls: 100_000,
      includedWallets: 100,
    });
    expect(assignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billingAccountId: ACCOUNT.id,
          periodStart: { lte: new Date('2026-09-01T00:00:00.000Z') },
        }),
        orderBy: { periodStart: 'desc' },
      }),
    );
  });

  it('returns null limits for Enterprise/custom null terms', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: ENTERPRISE_VERSION.id,
        expiresAt: null,
        source: 'default',
        planVersion: ENTERPRISE_VERSION,
      },
    ]);

    const result = await service.getEntitlements('user-1', '2026-09');

    expect(result.planCode).toBe('enterprise');
    expect(result.includedApiCalls).toBeNull();
    expect(result.includedWallets).toBeNull();
  });

  it('fails closed when the persisted plan has an unknown code', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-unknown-1',
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: {
          ...STARTER_VERSION,
          id: 'plan-unknown-1',
          code: 'not-a-real-plan',
        },
      },
    ]);

    await expect(service.getEntitlements('user-1', '2026-09')).rejects.toThrow(ConflictException);
  });

  it('fails closed when the persisted Enterprise row has finite terms', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-enterprise-1',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: {
          ...STARTER_VERSION,
          id: 'plan-enterprise-1',
          code: 'enterprise',
        },
      },
    ]);

    await expect(service.getEntitlements('user-1', '2026-09')).rejects.toThrow(ConflictException);
  });

  it('returns Free fallback when no assignment exists', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([]);

    const result = await service.getEntitlements('user-1', '2026-09');

    expect(result.planCode).toBe('free');
    expect(result.includedApiCalls).toBe(10_000);
  });

  it('ignores expired paid assignments (unpaid renewal → Free at boundary)', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    // Query filter excludes expired rows; empty list → Free.
    assignmentFindMany.mockResolvedValue([]);

    const result = await service.getEntitlements('user-1', '2026-09');

    expect(result.planCode).toBe('free');
    expect(assignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date('2026-09-01T00:00:00.000Z') } }],
        }),
      }),
    );
  });

  it('rejects legacy paid assignment with null expiresAt (no indefinite paid access)', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-legacy',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        expiresAt: null,
        source: null,
        planVersion: STARTER_VERSION,
      },
    ]);

    const result = await service.getEntitlements('user-1', '2026-09');
    expect(result.planCode).toBe('free');
  });

  it('does not resurrect an older paid assignment after an expired latest row', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    // Newest expired is filtered out by the query; older paid with bound still
    // present would be wrong if we walked without expires check — ensure only
    // Free when the only remaining candidate is expired (empty list).
    assignmentFindMany.mockResolvedValue([]);
    const result = await service.getEntitlements('user-1', '2026-09');
    expect(result.planCode).toBe('free');
  });

  it('uses a non-expired paid upgrade assignment immediately', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-upgrade',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      },
    ]);

    const result = await service.getEntitlements('user-1', '2026-09');

    expect(result.planCode).toBe('starter');
    expect(result.includedWallets).toBe(100);
  });

  it('getPlanForPeriod returns the plan code/name/period', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    assignmentFindMany.mockResolvedValue([
      {
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: STARTER_VERSION,
      },
    ]);

    const result = await service.getPlanForPeriod('user-1', '2026-09');

    expect(result).toEqual({
      planCode: 'starter',
      planName: 'Starter',
      effectivePeriod: '2026-09',
    });
  });
});

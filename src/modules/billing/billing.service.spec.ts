import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from './billing.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const FREE_VERSION = {
  id: 'plan-free-1',
  code: 'free',
  version: 1,
  name: 'Free',
  description: 'Free plan',
  monthlyFeeMicros: 0n,
  includedOutboundMicros: 50_000_000_000n, // $50K
  includedApiCalls: 10_000n,
  includedWallets: 10,
  includedTeamMembers: null,
  apiOverageRateMicros: 0n,
  walletOverageRateMicros: 0n,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const STARTER_VERSION = {
  ...FREE_VERSION,
  id: 'plan-starter-1',
  code: 'starter',
  name: 'Starter',
  monthlyFeeMicros: 49_000_000n,
  includedOutboundMicros: 250_000_000_000n,
  includedApiCalls: 100_000n,
  includedWallets: 100,
};

const ACCOUNT = { id: 'acc-1', userId: 'user-1', currency: 'USD' };

describe('BillingService', () => {
  let service: BillingService;

  const accountFindUnique = jest.fn();
  const accountCreate = jest.fn();
  const planVersionFindFirst = jest.fn();
  const planVersionFindUnique = jest.fn();
  const planVersionFindMany = jest.fn();
  const planVersionCreate = jest.fn();
  const assignmentFindFirst = jest.fn();
  const assignmentCreate = jest.fn();
  const usageEventCreate = jest.fn();
  const usageEventFindMany = jest.fn();
  const walletCount = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const invoiceFindMany = jest.fn();
  const invoiceCount = jest.fn();
  const invoiceCreate = jest.fn();
  const lineCreateMany = jest.fn();
  const transaction = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        {
          provide: PrismaService,
          useValue: {
            billingAccount: { findUnique: accountFindUnique, create: accountCreate },
            billingPlanVersion: {
              findFirst: planVersionFindFirst,
              findUnique: planVersionFindUnique,
              findMany: planVersionFindMany,
              create: planVersionCreate,
            },
            billingPlanAssignment: { findFirst: assignmentFindFirst, create: assignmentCreate },
            billingUsageEvent: { create: usageEventCreate, findMany: usageEventFindMany },
            userWallet: { count: walletCount },
            billingInvoice: {
              findUnique: invoiceFindUnique,
              findFirst: invoiceFindFirst,
              findMany: invoiceFindMany,
              count: invoiceCount,
              create: invoiceCreate,
            },
            billingInvoiceLine: { createMany: lineCreateMany },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
  });

  describe('getPlans', () => {
    it('creates the account, plan catalog, and default Free assignment on first access', async () => {
      accountFindUnique.mockResolvedValue(null);
      accountCreate.mockResolvedValue(ACCOUNT);
      // ensurePlanVersions: every plan is missing -> create (6 plans)
      planVersionFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        // ensureDefaultAssignment: free plan lookup succeeds
        .mockResolvedValue(FREE_VERSION);
      planVersionCreate.mockResolvedValue(FREE_VERSION);
      // ensureDefaultAssignment: no assignment yet -> create; needs free plan
      assignmentFindFirst.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      expect(accountCreate).toHaveBeenCalledWith({ data: { userId: 'user-1' } });
      // 6 plans created
      expect(planVersionCreate).toHaveBeenCalledTimes(6);
      expect(assignmentCreate).toHaveBeenCalledTimes(1);
      expect(result.currentPlanId).toBe('free');
      expect(result.plans).toHaveLength(2);
      expect(result.plans[0]).toMatchObject({
        id: 'free',
        name: 'Free',
        basePrice: '0',
        currency: 'USD',
        billingPeriod: 'Monthly',
      });
    });

    it('reads an existing account and assignment without re-creating them', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // plans already exist
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);
      planVersionFindMany.mockResolvedValue([FREE_VERSION]);

      const result = await service.getPlans('user-1');

      expect(accountCreate).not.toHaveBeenCalled();
      expect(planVersionCreate).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(result.currentPlanId).toBe('free');
    });
  });

  describe('recordApiCall', () => {
    it('creates an api_call usage event with quantity 1', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.recordApiCall({
        userId: 'user-1',
        sourceKey: 'api:tx-1',
        endpoint: '/v1/transactions/send',
        statusCode: 200,
      });

      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            metric: 'api_call',
            sourceKey: 'api:tx-1',
            quantity: 1n,
            volumeUsdMicros: 0n,
            endpoint: '/v1/transactions/send',
            statusCode: 200,
          }),
        }),
      );
    });

    it('is idempotent on sourceKey (unique conflict is swallowed)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockRejectedValue(p2002());

      await expect(
        service.recordApiCall({ userId: 'user-1', sourceKey: 'api:dup' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('recordSuccessfulOutbound', () => {
    it('creates an outbound_volume event with the given amount', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.recordSuccessfulOutbound({
        userId: 'user-1',
        sourceKey: 'out:tx-1',
        amountUsdMicros: 600_000_000_000n,
      });

      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            metric: 'outbound_volume',
            sourceKey: 'out:tx-1',
            volumeUsdMicros: 600_000_000_000n,
          }),
        }),
      );
    });

    it('rejects negative amounts', async () => {
      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          sourceKey: 'out:neg',
          amountUsdMicros: -1n,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects non-bigint amounts', async () => {
      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          sourceKey: 'out:str',
          amountUsdMicros: '100' as unknown as bigint,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('is idempotent on sourceKey (unique conflict is swallowed)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockRejectedValue(p2002());

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          sourceKey: 'out:dup',
          amountUsdMicros: 100n,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getSummary', () => {
    it('aggregates usage and filters active wallets', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        { metric: 'outbound_volume', volumeUsdMicros: 600_000_000_000n, quantity: 1n },
        { metric: 'api_call', quantity: 5n },
      ]);
      walletCount.mockResolvedValue(3);

      const result = await service.getSummary('user-1', '2026-05');

      // active wallet filter
      expect(walletCount).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          status: 'active',
          walletAddress: { not: null },
          frozenAt: null,
        },
      });

      // $600K gross - $50K free = $550K billable:
      //   $500K @ 100 ppm = $50, $50K @ 75 ppm = $3.75 -> $53.75
      expect(result.period).toBe('2026-05');
      expect(result.planId).toBe('free');
      expect(result.outboundVolume).toBe('600000');
      expect(result.outboundFreeAllowance).toBe('50000');
      expect(result.outboundOverage).toBe('53.75');
      expect(result.apiCalls).toBe('5');
      expect(result.apiCallsFreeAllowance).toBe('10000');
      expect(result.activeWallets).toBe('3');
      expect(result.activeWalletsFreeAllowance).toBe('10');
      expect(result.estimatedBaseCost).toBe('0');
      expect(result.estimatedOverageCost).toBe('53.75');
      expect(result.estimatedTotal).toBe('53.75');
      expect(result.currency).toBe('USD');
      expect(result.overageRate).toBe('0.0100%');
      expect(result.overageUnit).toBe('outbound_volume');
      expect(result.tierBreakdown).toHaveLength(2);
      expect(result.tierBreakdown[0]).toMatchObject({
        tier: 'Tier 1',
        from: '0',
        to: '500000',
        quantity: '500000',
        rate: '0.0100%',
        cost: '50',
      });
      expect(result.tierBreakdown[1]).toMatchObject({
        tier: 'Tier 2',
        from: '500000',
        to: '2000000',
        quantity: '50000',
        rate: '0.0075%',
        cost: '3.75',
      });
    });

    it('returns zeros when there is no usage', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      expect(result.outboundVolume).toBe('0');
      expect(result.outboundOverage).toBe('0');
      expect(result.estimatedTotal).toBe('0');
      expect(result.tierBreakdown).toEqual([]);
    });

    it('rejects an invalid period', async () => {
      await expect(service.getSummary('user-1', '2026-13')).rejects.toThrow(BadRequestException);
      await expect(service.getSummary('user-1', 'not-a-period')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('initializes the plan catalog on first access before resolving the Free plan', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // Catalog is empty: every plan lookup misses, then free-plan lookups hit the created version
      for (let i = 0; i < 6; i++) planVersionFindFirst.mockResolvedValueOnce(null);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      planVersionCreate.mockResolvedValue(FREE_VERSION);
      // No assignment yet -> default Free assignment is created
      assignmentFindFirst.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      expect(planVersionCreate).toHaveBeenCalledTimes(6);
      expect(assignmentCreate).toHaveBeenCalledTimes(1);
      expect(result.planId).toBe('free');
      expect(result.period).toBe('2026-05');
      expect(result.estimatedTotal).toBe('0');
    });

    it('survives a concurrent catalog initialization race (P2002 on plan version create)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // First plan: initial lookup misses -> create hits a unique conflict -> re-fetch succeeds
      planVersionFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(FREE_VERSION) // re-fetch after P2002
        .mockResolvedValue(FREE_VERSION); // remaining plans + free-plan lookups
      planVersionCreate.mockRejectedValue(p2002());
      assignmentFindFirst.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      // Only the losing plan attempted a create; the rest were already present
      expect(planVersionCreate).toHaveBeenCalledTimes(1);
      expect(assignmentCreate).toHaveBeenCalledTimes(1);
      expect(result.planId).toBe('free');
    });
  });

  describe('listInvoices', () => {
    it('returns an empty list when the user has no account', async () => {
      accountFindUnique.mockResolvedValue(null);

      const result = await service.listInvoices('user-1', { page: 1, limit: 20 });

      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    });

    it('returns paginated invoices scoped to the user account', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindMany.mockResolvedValue([
        {
          id: 'inv-1',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          status: 'finalized',
          currency: 'USD',
          totalMicros: 84_000_000n,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ]);
      invoiceCount.mockResolvedValue(1);

      const result = await service.listInvoices('user-1', { page: 1, limit: 20 });

      expect(invoiceFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { billingAccountId: ACCOUNT.id },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.items[0]).toMatchObject({
        id: 'inv-1',
        period: '2026-05',
        status: 'finalized',
        amount: '84',
        currency: 'USD',
      });
    });

    it('caps limit at 100', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindMany.mockResolvedValue([]);
      invoiceCount.mockResolvedValue(0);

      await service.listInvoices('user-1', { page: 1, limit: 500 });

      expect(invoiceFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });
  });

  describe('getInvoice', () => {
    it('throws NotFound when the user has no account', async () => {
      accountFindUnique.mockResolvedValue(null);

      await expect(service.getInvoice('user-1', 'inv-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when the invoice is not owned by the user', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(null);

      await expect(service.getInvoice('user-1', 'inv-other')).rejects.toThrow(NotFoundException);
    });

    it('returns the invoice when owned by the user', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 84_000_000n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      const result = await service.getInvoice('user-1', 'inv-1');

      expect(invoiceFindFirst).toHaveBeenCalledWith({
        where: { id: 'inv-1', billingAccountId: ACCOUNT.id },
      });
      expect(result.amount).toBe('84');
    });
  });

  describe('finalizeInvoice', () => {
    it('creates an immutable finalized invoice with lines and a snapshot hash', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        { metric: 'outbound_volume', volumeUsdMicros: 600_000_000_000n, quantity: 1n },
      ]);
      walletCount.mockResolvedValue(0);

      const createdInvoice = {
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 53_750_000n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      };
      invoiceCreate.mockResolvedValue(createdInvoice);
      transaction.mockImplementation(async (cb) =>
        cb({
          billingInvoice: { create: invoiceCreate },
          billingInvoiceLine: { createMany: lineCreateMany },
        }),
      );

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            planVersionId: FREE_VERSION.id,
            status: 'finalized',
            totalMicros: 53_750_000n,
            snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      );
      // monthly fee line + 1 outbound tier line
      expect(lineCreateMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ lineType: 'monthly_fee' }),
          expect.objectContaining({ lineType: 'outbound_tier' }),
        ]),
      });
      expect(result.id).toBe('inv-1');
      expect(result.status).toBe('finalized');
    });

    it('returns the existing invoice without modifying it', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      invoiceFindUnique.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 55_000_000n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(result.id).toBe('inv-1');
    });

    it('returns the same invoice on a concurrent unique-conflict race', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      invoiceFindUnique
        .mockResolvedValueOnce(null) // first check: none
        .mockResolvedValueOnce({
          id: 'inv-1',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          status: 'finalized',
          currency: 'USD',
          totalMicros: 55_000_000n,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        }); // after conflict: found
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      transaction.mockRejectedValue(p2002());

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-1');
    });

    it('initializes the plan catalog on first access before finalizing an invoice', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // Catalog is empty: every plan lookup misses, then free-plan lookups hit the created version
      for (let i = 0; i < 6; i++) planVersionFindFirst.mockResolvedValueOnce(null);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      planVersionCreate.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      // No assignment yet -> default Free assignment is created
      assignmentFindFirst.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      transaction.mockImplementation(async (cb) =>
        cb({
          billingInvoice: { create: invoiceCreate },
          billingInvoiceLine: { createMany: lineCreateMany },
        }),
      );

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(planVersionCreate).toHaveBeenCalledTimes(6);
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ planVersionId: FREE_VERSION.id, status: 'finalized' }),
        }),
      );
      expect(result.id).toBe('inv-1');
    });
  });
});

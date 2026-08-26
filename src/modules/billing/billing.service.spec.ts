import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from './billing.service';
import { BillingQuotaExceededException } from './billing-quota.exception';

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

const TX = {
  id: 'tx-1',
  userId: 'user-1',
  txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  chainId: 8453n,
  walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const RECEIPT = {
  txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  receiptRef: '0x1111111111111111111111111111111111111111111111111111111111111111:log:0',
  receiptLogIndex: 0,
  receiptBlockNumber: 12345n,
  receiptBlockHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  // 2026-08-10T00:00:00Z -> periodStart 2026-08-01 (matches the test inputs)
  receiptBlockTimestamp: 1_786_320_000n,
  receiptStatus: 'success',
  receiptData: {
    transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    blockNumber: '12345',
    status: 'success',
  },
  reconciledAt: new Date('2026-08-10T00:00:00.000Z'),
};

/** Canonical posted row that exactly matches the evidence-aware test input. */
function existingPostedRow(overrides: Record<string, unknown> = {}) {
  return {
    billingAccountId: ACCOUNT.id,
    metric: 'outbound_volume',
    transactionId: 'tx-1',
    sourceKey: 'tx:tx-1:log:0',
    receiptRef: RECEIPT.receiptRef,
    receiptLogIndex: 0,
    txHash: RECEIPT.txHash,
    chainId: 8453n,
    walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    receiptBlockNumber: 12345n,
    receiptBlockHash: RECEIPT.receiptBlockHash,
    receiptBlockTimestamp: 1_786_320_000n,
    receiptStatus: 'success',
    status: 'posted',
    volumeUsdMicros: 1_000_000n,
    assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    assetDecimals: 6,
    baseUnitAmount: 1_000_000n,
    unitPriceMicros: 1_000_000n,
    priceSource: 'static_usd_peg',
    reconciliationRunId: null,
    ...overrides,
  };
}

/** Canonical legacy row that exactly matches the legacy idempotency test input. */
function existingLegacyRow(overrides: Record<string, unknown> = {}) {
  return {
    billingAccountId: ACCOUNT.id,
    metric: 'outbound_volume',
    transactionId: null,
    sourceKey: 'out:dup',
    receiptRef: null,
    receiptLogIndex: null,
    txHash: null,
    chainId: null,
    walletAddress: null,
    receiptBlockNumber: null,
    receiptBlockHash: null,
    receiptBlockTimestamp: null,
    receiptStatus: null,
    status: 'unverified',
    volumeUsdMicros: 100n,
    assetId: null,
    assetDecimals: null,
    baseUnitAmount: null,
    unitPriceMicros: null,
    priceSource: null,
    reconciliationRunId: null,
    ...overrides,
  };
}

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
  const assignmentFindUnique = jest.fn();
  const assignmentUpdate = jest.fn();
  const usageEventCreate = jest.fn();
  const usageEventFindMany = jest.fn();
  const usageEventFindUnique = jest.fn();
  const usageEventFindFirst = jest.fn();
  const usageEventAggregate = jest.fn();
  const reconciliationRunFindMany = jest.fn();
  const transactionFindUnique = jest.fn();
  const walletCount = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const invoiceFindMany = jest.fn();
  const invoiceCount = jest.fn();
  const invoiceCreate = jest.fn();
  const invoiceUpdate = jest.fn();
  const lineCreateMany = jest.fn();
  const lineDeleteMany = jest.fn();
  const transaction = jest.fn();
  const executeRaw = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();

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
            billingPlanAssignment: {
              findFirst: assignmentFindFirst,
              create: assignmentCreate,
              findUnique: assignmentFindUnique,
              update: assignmentUpdate,
            },
            billingUsageEvent: {
              create: usageEventCreate,
              findMany: usageEventFindMany,
              findUnique: usageEventFindUnique,
              findFirst: usageEventFindFirst,
              aggregate: usageEventAggregate,
            },
            billingReconciliationRun: { findMany: reconciliationRunFindMany },
            transaction: { findUnique: transactionFindUnique },
            userWallet: { count: walletCount },
            billingInvoice: {
              findUnique: invoiceFindUnique,
              findFirst: invoiceFindFirst,
              findMany: invoiceFindMany,
              count: invoiceCount,
              create: invoiceCreate,
              update: invoiceUpdate,
            },
            billingInvoiceLine: { createMany: lineCreateMany, deleteMany: lineDeleteMany },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);

    // Defaults for the Phase 1E fail-closed risk checks: no quarantined usage
    // and no risky reconciliation runs unless a test overrides them.
    usageEventFindFirst.mockResolvedValue(null);
    reconciliationRunFindMany.mockResolvedValue([]);

    // The interactive transaction client used by withBillingPeriodLock. All
    // model accessors share the same jest.fn() instances as this.prisma so the
    // production lock path is exercised (never silently skipped).
    const tx = {
      $executeRaw: executeRaw,
      billingAccount: { findUnique: accountFindUnique, create: accountCreate },
      billingPlanVersion: {
        findFirst: planVersionFindFirst,
        findUnique: planVersionFindUnique,
        findMany: planVersionFindMany,
        create: planVersionCreate,
      },
      billingPlanAssignment: {
        findFirst: assignmentFindFirst,
        create: assignmentCreate,
        findUnique: assignmentFindUnique,
        update: assignmentUpdate,
      },
      billingUsageEvent: {
        create: usageEventCreate,
        findMany: usageEventFindMany,
        findUnique: usageEventFindUnique,
        findFirst: usageEventFindFirst,
        aggregate: usageEventAggregate,
      },
      billingReconciliationRun: { findMany: reconciliationRunFindMany },
      transaction: { findUnique: transactionFindUnique },
      userWallet: { count: walletCount },
      billingInvoice: {
        findUnique: invoiceFindUnique,
        findFirst: invoiceFindFirst,
        findMany: invoiceFindMany,
        count: invoiceCount,
        create: invoiceCreate,
        update: invoiceUpdate,
      },
      billingInvoiceLine: { createMany: lineCreateMany, deleteMany: lineDeleteMany },
    };
    transaction.mockImplementation(async (cb) => cb(tx));
    executeRaw.mockResolvedValue(undefined);
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
        planVersion: FREE_VERSION,
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
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-1',
          billingAccountId: ACCOUNT.id,
          planVersionId: FREE_VERSION.id,
          planVersion: FREE_VERSION,
        })
        .mockResolvedValue(null); // no future scheduled assignment
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);
      planVersionFindMany.mockResolvedValue([FREE_VERSION]);

      const result = await service.getPlans('user-1');

      expect(accountCreate).not.toHaveBeenCalled();
      expect(planVersionCreate).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(result.currentPlanId).toBe('free');
      expect(result.scheduledPlan).toBeUndefined();
    });

    it('keeps the current plan when a future assignment is scheduled', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-current',
          billingAccountId: ACCOUNT.id,
          planVersionId: FREE_VERSION.id,
          planVersion: FREE_VERSION,
        })
        .mockResolvedValueOnce({
          id: 'assign-future',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          planVersionId: STARTER_VERSION.id,
          planVersion: STARTER_VERSION,
        });
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      // the future Starter assignment must not override the current Free plan
      expect(result.currentPlanId).toBe('free');
      expect(result.scheduledPlan).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      });
    });

    it('creates a current Free plan instead of reusing a future assignment', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst
        .mockResolvedValueOnce(null) // no current-or-past assignment
        .mockResolvedValueOnce({
          id: 'assign-future',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          planVersionId: STARTER_VERSION.id,
          planVersion: STARTER_VERSION,
        });
      assignmentCreate.mockResolvedValue({
        id: 'assign-current',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      expect(assignmentCreate).toHaveBeenCalledTimes(1);
      expect(result.currentPlanId).toBe('free');
      expect(result.scheduledPlan).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      });
    });

    it('fails closed when the current persisted plan has an unknown code', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-unknown-1',
        planVersion: {
          ...FREE_VERSION,
          id: 'plan-unknown-1',
          code: 'not-a-real-plan',
        },
      });

      await expect(service.getPlans('user-1')).rejects.toThrow(ConflictException);
    });

    it('fails closed when the current persisted plan uses an inherited key', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-1',
        planVersion: { ...FREE_VERSION, id: 'plan-1', code: 'toString' },
      });

      await expect(service.getPlans('user-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('assignPlan', () => {
    function mockPlanLookup() {
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) => {
        if (where.code === 'starter') return STARTER_VERSION;
        if (where.code === 'enterprise') {
          return {
            ...FREE_VERSION,
            id: 'plan-enterprise-1',
            code: 'enterprise',
            name: 'Enterprise',
            monthlyFeeMicros: null,
            includedOutboundMicros: null,
            includedWallets: null,
            includedApiCalls: null,
          };
        }
        return FREE_VERSION;
      });
    }

    it('assigns a plan effective next UTC month and creates an open invoice', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindUnique.mockResolvedValue(null);
      invoiceFindUnique.mockResolvedValue(null);
      invoiceCreate.mockResolvedValue({
        id: 'inv-open',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        status: 'open',
        currency: 'USD',
        totalMicros: 49_000_000n,
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
      });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result).toMatchObject({
        planCode: 'starter',
        planName: 'Starter',
        outcome: 'changed',
      });
      // env date is 2026-08-25 -> next UTC month is 2026-09
      expect(result.effectivePeriod).toBe('2026-09');
      expect(assignmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            planVersionId: STARTER_VERSION.id,
            periodStart: new Date('2026-09-01T00:00:00.000Z'),
          }),
        }),
      );
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'open',
            planVersionId: STARTER_VERSION.id,
            totalMicros: 49_000_000n,
          }),
        }),
      );
    });

    it('treats the same target plan as an idempotent no-op', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindUnique.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
      });
      invoiceFindUnique.mockResolvedValue({ id: 'inv-open', status: 'open' });
      invoiceUpdate.mockResolvedValue({ id: 'inv-open', status: 'open' });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('unchanged');
      expect(assignmentUpdate).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
      // the open invoice is kept consistent with the same plan
      expect(invoiceUpdate).toHaveBeenCalled();
    });

    it('replaces the future assignment and updates the open invoice when the plan changes', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindUnique.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
      invoiceFindUnique.mockResolvedValue({ id: 'inv-open', status: 'open' });
      invoiceUpdate.mockResolvedValue({ id: 'inv-open', status: 'open' });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('changed');
      expect(assignmentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ planVersionId: STARTER_VERSION.id }),
        }),
      );
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(invoiceUpdate).toHaveBeenCalled();
    });

    it('rejects Enterprise/custom null terms via self-service', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();

      await expect(service.assignPlan('user-1', 'enterprise')).rejects.toThrow(ConflictException);
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('rejects an unknown plan code', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'nonexistent' ? null : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'nonexistent')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a persisted plan code that is not in the static whitelist', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // the DB has a row for a code that is not in PLANS
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'ghost-plan'
          ? { ...FREE_VERSION, id: 'plan-ghost-1', code: 'ghost-plan' }
          : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'ghost-plan')).rejects.toThrow(BadRequestException);
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it.each(['toString', 'constructor', '__proto__', '', 123 as unknown as string])(
      'rejects inherited/empty/non-string plan code %p with zero DB calls',
      async (badCode) => {
        await expect(service.assignPlan('user-1', badCode)).rejects.toThrow(BadRequestException);
        // static validation happens before any DB read/write
        expect(accountFindUnique).not.toHaveBeenCalled();
        expect(planVersionFindFirst).not.toHaveBeenCalled();
        expect(assignmentCreate).not.toHaveBeenCalled();
        expect(invoiceCreate).not.toHaveBeenCalled();
      },
    );

    it('rejects a finite plan with a wrong-type monetary field', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter'
          ? { ...STARTER_VERSION, monthlyFeeMicros: 49 as unknown as bigint }
          : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'starter')).rejects.toThrow(ConflictException);
      expect(assignmentCreate).not.toHaveBeenCalled();
    });

    it('rejects a finite plan with a negative quota field', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter' ? { ...STARTER_VERSION, includedApiCalls: -1n } : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'starter')).rejects.toThrow(ConflictException);
      expect(assignmentCreate).not.toHaveBeenCalled();
    });

    it('rejects a finite plan with an unsafe wallet count', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter' ? { ...STARTER_VERSION, includedWallets: 2 ** 53 } : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'starter')).rejects.toThrow(ConflictException);
      expect(assignmentCreate).not.toHaveBeenCalled();
    });

    it('keeps a known historical finite plan valid', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter'
          ? { ...STARTER_VERSION, monthlyFeeMicros: 99_000_000n } // historical price snapshot
          : FREE_VERSION,
      );
      assignmentFindUnique.mockResolvedValue(null);
      invoiceFindUnique.mockResolvedValue(null);
      invoiceCreate.mockResolvedValue({
        id: 'inv-open',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        status: 'open',
        currency: 'USD',
        totalMicros: 99_000_000n,
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
      });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('changed');
      expect(assignmentCreate).toHaveBeenCalled();
    });

    it('rejects a malformed Enterprise persisted row with finite terms', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'enterprise'
          ? { ...FREE_VERSION, id: 'plan-enterprise-1', code: 'enterprise' }
          : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'enterprise')).rejects.toThrow(ConflictException);
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('rejects a plan change when the future invoice is immutable', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      invoiceFindUnique.mockResolvedValue({ id: 'inv-final', status: 'finalized' });

      await expect(service.assignPlan('user-1', 'starter')).rejects.toThrow(ConflictException);
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('retries a serialization conflict during plan assignment', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindUnique.mockResolvedValue(null);
      invoiceFindUnique.mockResolvedValue(null);
      invoiceCreate
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('serialization failure', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce({
          id: 'inv-open',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          status: 'open',
          currency: 'USD',
          totalMicros: 49_000_000n,
          createdAt: new Date('2026-08-25T00:00:00.000Z'),
        });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('changed');
      expect(invoiceCreate).toHaveBeenCalledTimes(2);
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

  describe('assertAndRecordApiCall', () => {
    function mockQuotaSetup(used: number) {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog initialized
      usageEventFindMany.mockResolvedValue([{ quantity: BigInt(used) }]);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });
    }

    it('writes a posted api_call event when the count is below the limit', async () => {
      mockQuotaSetup(9_999); // limit-1 (Free includedApiCalls = 10_000)

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-1',
        requestId: 'api:req-1',
        endpoint: '/v1/wallets/sign',
        metadata: { method: 'POST', route: '/v1/wallets/sign', apiKeyId: 'key-1' },
      });

      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            metric: 'api_call',
            entryType: 'usage',
            sourceType: 'api_request',
            status: 'posted',
            sourceKey: 'api:req-1',
            quantity: 1n,
            volumeUsdMicros: 0n,
          }),
        }),
      );
      // the quota count only reads usage-type api_call events
      expect(usageEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            metric: 'api_call',
            entryType: 'usage',
          }),
          select: { quantity: true },
        }),
      );
    });

    it('throws BillingQuotaExceededException and writes nothing at the limit', async () => {
      mockQuotaSetup(10_000); // at limit

      await expect(
        service.assertAndRecordApiCall({
          userId: 'user-1',
          sourceKey: 'api:req-2',
          endpoint: '/v1/wallets/sign',
        }),
      ).rejects.toThrow(BillingQuotaExceededException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('compares huge used counts exactly in bigint without Number conversion', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // safe limit 10_000
      // used = 2^60 (far above the limit) -> exact bigint comparison -> 429
      usageEventFindMany.mockResolvedValue([{ quantity: 2n ** 60n }]);

      await expect(
        service.assertAndRecordApiCall({
          userId: 'user-1',
          sourceKey: 'api:req-huge',
          endpoint: '/v1/wallets/sign',
        }),
      ).rejects.toThrow(BillingQuotaExceededException);
      expect(usageEventCreate).not.toHaveBeenCalled();

      // used = 9_999 (below the limit) -> write succeeds
      usageEventFindMany.mockResolvedValue([{ quantity: 9_999n }]);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });
      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-ok',
        endpoint: '/v1/wallets/sign',
      });
      expect(usageEventCreate).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the persisted includedApiCalls exceeds Number.MAX_SAFE_INTEGER', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue({
        ...FREE_VERSION,
        id: 'plan-huge-1',
        code: 'starter',
        includedApiCalls: 2n ** 60n,
      });

      await expect(
        service.assertAndRecordApiCall({
          userId: 'user-1',
          sourceKey: 'api:req-unsafe',
          endpoint: '/v1/wallets/sign',
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('fails closed when a usage quantity is negative', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      usageEventFindMany.mockResolvedValue([{ quantity: -1n }]);

      await expect(
        service.assertAndRecordApiCall({
          userId: 'user-1',
          sourceKey: 'api:req-neg',
          endpoint: '/v1/wallets/sign',
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('runs the check-and-record inside the billing-period lock', async () => {
      mockQuotaSetup(0);

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-3',
        endpoint: '/v1/wallets/sign',
      });

      expect(executeRaw).toHaveBeenCalled();
      const lockCall = executeRaw.mock.calls[0];
      expect(lockCall[0].join('')).toContain('pg_advisory_xact_lock');
    });

    it('fails closed for Enterprise/custom null terms', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue({
        ...FREE_VERSION,
        id: 'plan-enterprise-1',
        code: 'enterprise',
        monthlyFeeMicros: null,
        includedOutboundMicros: null,
        includedWallets: null,
        includedApiCalls: null,
      });

      await expect(
        service.assertAndRecordApiCall({
          userId: 'user-1',
          sourceKey: 'api:req-4',
          endpoint: '/v1/wallets/sign',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('fails closed for a malformed Enterprise row with finite terms', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue({
        ...FREE_VERSION,
        id: 'plan-enterprise-1',
        code: 'enterprise',
        includedApiCalls: null, // finite other fields -> malformed Enterprise
      });

      await expect(
        service.assertAndRecordApiCall({
          userId: 'user-1',
          sourceKey: 'api:req-4b',
          endpoint: '/v1/wallets/sign',
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('retries a serialization conflict with a fresh count', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      usageEventFindMany
        .mockResolvedValueOnce([{ quantity: 9_999n }])
        .mockResolvedValueOnce([{ quantity: 9_999n }]);
      usageEventCreate
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('serialization failure', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce({ id: 'evt-1' });

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-5',
        endpoint: '/v1/wallets/sign',
      });

      expect(usageEventCreate).toHaveBeenCalledTimes(2);
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

    it('replays an exact legacy duplicate on sourceKey conflict', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(existingLegacyRow());

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        sourceKey: 'out:dup',
        amountUsdMicros: 100n,
      });

      expect(result).toEqual({ outcome: 'replayed' });
    });

    it('throws ConflictException when a legacy sourceKey conflict differs', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(existingLegacyRow({ volumeUsdMicros: 999n }));

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          sourceKey: 'out:dup',
          amountUsdMicros: 100n,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('marks legacy caller-supplied rows as unverified + legacy_import', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.recordSuccessfulOutbound({
        userId: 'user-1',
        sourceKey: 'out:legacy',
        amountUsdMicros: 100n,
      });

      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'unverified',
            sourceType: 'legacy_import',
          }),
        }),
      );
    });
  });

  describe('recordSuccessfulOutbound (evidence-aware)', () => {
    const receipt = {
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      receiptRef: '0x1111111111111111111111111111111111111111111111111111111111111111:log:0',
      receiptLogIndex: 0,
      receiptBlockNumber: 12345n,
      receiptBlockHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      // 2026-08-10T00:00:00Z -> periodStart 2026-08-01 (matches the test inputs)
      receiptBlockTimestamp: 1_786_320_000n,
      receiptStatus: 'success',
      receiptData: {
        transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        blockNumber: '12345',
        status: 'success',
      },
      reconciledAt: new Date('2026-08-10T00:00:00.000Z'),
    };

    it('appends a posted outbound event with full receipt evidence', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt,
        metadata: { policyVersion: 1 },
      });

      expect(result).toEqual({ outcome: 'inserted' });
      expect(transactionFindUnique).toHaveBeenCalledWith({ where: { id: 'tx-1' } });
      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            metric: 'outbound_volume',
            entryType: 'usage',
            sourceType: 'openfort_receipt',
            status: 'posted',
            sourceKey: 'tx:tx-1:log:0',
            volumeUsdMicros: 1_000_000n,
            transactionId: 'tx-1',
            receiptRef: receipt.receiptRef,
            receiptLogIndex: 0,
            receiptBlockNumber: 12345n,
            receiptBlockHash: receipt.receiptBlockHash,
            receiptBlockTimestamp: 1_786_320_000n,
            receiptStatus: 'success',
            reconciledAt: receipt.reconciledAt,
            baseUnitAmount: 1_000_000n,
            assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            assetDecimals: 6,
            unitPriceMicros: 1_000_000n,
            priceSource: 'static_usd_peg',
            chainId: 8453n,
            walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            txHash: receipt.txHash,
          }),
        }),
      );
    });

    it('appends a quarantined outbound event with volume 0 and reason metadata', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:native',
        status: 'quarantined',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 0n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        receipt,
        metadata: { reason: 'native_asset', amount: '1000000' },
      });

      expect(result).toEqual({ outcome: 'inserted' });
      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'quarantined',
            sourceType: 'openfort_receipt',
            volumeUsdMicros: 0n,
            transactionId: 'tx-1',
            metadata: { reason: 'native_asset', amount: '1000000' },
          }),
        }),
      );
    });

    it('rejects negative amounts', async () => {
      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: -1n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects receipt-backed outbound without a transactionId', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects receipt-backed outbound with a non-posted/quarantined status', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'unverified' as any,
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('replays an exact receipt-backed duplicate on P2002', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(existingPostedRow());

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt,
      });

      expect(result).toEqual({ outcome: 'replayed' });
    });

    it('throws ConflictException when a P2002 row differs in volume', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(existingPostedRow({ volumeUsdMicros: 999n }));

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when a P2002 row differs in receipt block evidence', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(existingPostedRow({ receiptBlockNumber: 99999n }));

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when a P2002 row differs in status', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(existingPostedRow({ status: 'quarantined' }));

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws BadRequest when the transaction does not exist', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(null);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-missing',
          sourceKey: 'tx:tx-missing:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects binding a receipt-backed event to another user transaction', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue({ ...TX, userId: 'user-other' });

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a txHash mismatch between the transaction and the receipt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue({
        ...TX,
        txHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      });

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a chainId mismatch between the transaction and the receipt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue({ ...TX, chainId: 1n });

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a walletAddress mismatch between the transaction and the receipt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue({
        ...TX,
        walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a posted event backed by a reverted receipt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt: { ...receipt, receiptStatus: 'reverted' },
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a quarantined event with nonzero volume', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'quarantined',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('persists reconciliationRunId on the ledger row', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt,
        reconciliationRunId: 'run-1',
      });

      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reconciliationRunId: 'run-1' }),
        }),
      );
    });

    it('rejects receipt-backed outbound without an explicit status', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['assetId', { assetId: undefined }],
      ['assetDecimals', { assetDecimals: undefined }],
      ['baseUnitAmount', { baseUnitAmount: undefined }],
      ['unitPriceMicros', { unitPriceMicros: undefined }],
      ['priceSource', { priceSource: undefined }],
    ] as const)('rejects posted outbound missing %s', async (_field, overrides) => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
          ...overrides,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a posted amount that does not match the deterministic pricing formula', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 999_999n, // formula gives 1_000_000
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('validates the amount formula exactly for huge BigInt amounts', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });
      const huge = 2n ** 100n;
      // roundHalfUp(huge * 3n, 10^6) = (huge*3*2 + 10^6) / (2*10^6)
      const expected = (huge * 3n * 2n + 1_000_000n) / 2_000_000n;

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: expected,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: huge,
        unitPriceMicros: 3n,
        priceSource: 'static_usd_peg',
        receipt,
      });

      expect(result).toEqual({ outcome: 'inserted' });
    });

    it('rejects a posted periodStart that does not match the receipt block month', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-09-01T00:00:00.000Z'), // wrong month
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a posted event with a missing block timestamp', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt: { ...receipt, receiptBlockTimestamp: undefined as any },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('accepts a quarantined event with zero volume and no pricing fields', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:native',
        status: 'quarantined',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 0n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        receipt,
        metadata: { reason: 'native_asset' },
      });

      expect(result).toEqual({ outcome: 'inserted' });
    });

    it('replays the same evidence across runs regardless of reconciliationRunId', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockRejectedValue(p2002());
      // run-1 wrote the row with runId 'run-1'; run-2 replays with 'run-2'
      usageEventFindUnique.mockResolvedValue(existingPostedRow({ reconciliationRunId: 'run-1' }));

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt,
        reconciliationRunId: 'run-2',
      });

      expect(result).toEqual({ outcome: 'replayed' });
    });

    it('throws ConflictException when a P2002 row differs in a real accounting field', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockRejectedValue(p2002());
      usageEventFindUnique.mockResolvedValue(
        existingPostedRow({ assetId: '0x2222222222222222222222222222222222222222' }),
      );

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('keeps the legacy hook compatible without receipt evidence or status', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        sourceKey: 'out:legacy',
        amountUsdMicros: 100n,
      });

      expect(result).toEqual({ outcome: 'inserted' });
      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'unverified', sourceType: 'legacy_import' }),
        }),
      );
    });

    it('shares the billing-period lock seam with finalize for the same period', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt,
      });

      // receipt-backed appends acquire the same advisory lock as finalize
      expect(executeRaw).toHaveBeenCalled();
      const lockCall = executeRaw.mock.calls[0];
      expect(lockCall[0].join('')).toContain('pg_advisory_xact_lock');
      // the lock key is bound as a parameter (never interpolated SQL)
      expect(lockCall[1]).toContain(ACCOUNT.id);
      expect(lockCall[1]).toContain('2026-08-01');
    });

    it('rejects a posted receipt append when the period is already finalized', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      invoiceFindUnique.mockResolvedValue({ id: 'inv-1', status: 'finalized' });

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a quarantined receipt append when the period is already finalized', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      invoiceFindUnique.mockResolvedValue({ id: 'inv-1', status: 'finalized' });

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:native',
          status: 'quarantined',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 0n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
          metadata: { reason: 'native_asset' },
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('replays exact existing evidence even when the period is finalized', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      invoiceFindUnique.mockResolvedValue({ id: 'inv-1', status: 'finalized' });
      usageEventFindUnique.mockResolvedValue(existingPostedRow());

      const result = await service.recordSuccessfulOutbound({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt,
      });

      expect(result).toEqual({ outcome: 'replayed' });
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects divergent existing evidence even when the period is finalized', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      invoiceFindUnique.mockResolvedValue({ id: 'inv-1', status: 'finalized' });
      usageEventFindUnique.mockResolvedValue(existingPostedRow({ volumeUsdMicros: 999n }));

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects a sourceKey collision from another billing account', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventFindUnique.mockResolvedValue(existingPostedRow({ billingAccountId: 'acc-other' }));

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          assetDecimals: 6,
          baseUnitAmount: 1_000_000n,
          unitPriceMicros: 1_000_000n,
          priceSource: 'static_usd_peg',
          receipt,
        }),
      ).rejects.toThrow(ConflictException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects receiptData that leaks a BigInt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt: { ...receipt, receiptData: { blockNumber: 12345n } },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects metadata that leaks a BigInt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);

      await expect(
        service.recordSuccessfulOutbound({
          userId: 'user-1',
          transactionId: 'tx-1',
          sourceKey: 'tx:tx-1:log:0',
          status: 'posted',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
          amountUsdMicros: 1_000_000n,
          chainId: 8453n,
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          receipt,
          metadata: { amount: 100n },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
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
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 600_000_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
        { metric: 'api_call', quantity: 5n, entryType: 'usage' },
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

    it('excludes legacy unverified positive-volume outbound from gross', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 600_000_000_000n,
          quantity: 1n,
          status: 'unverified',
          entryType: 'usage',
        },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      expect(result.outboundVolume).toBe('0');
      expect(result.outboundOverage).toBe('0');
      expect(result.estimatedTotal).toBe('0');
    });

    it('excludes quarantined and reversed outbound from gross', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 100_000_000n,
          quantity: 1n,
          status: 'quarantined',
          entryType: 'usage',
        },
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 200_000_000n,
          quantity: 1n,
          status: 'reversed',
          entryType: 'usage',
        },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      expect(result.outboundVolume).toBe('0');
      expect(result.outboundOverage).toBe('0');
    });

    it('counts only posted usage-type outbound and keeps api_call counting intact', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 100_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 50_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'reversal',
        },
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 999_000_000n,
          quantity: 1n,
          status: 'unverified',
          entryType: 'usage',
        },
        { metric: 'api_call', quantity: 3n, status: 'unverified', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      // only the posted usage row counts; reversal and unverified are excluded
      expect(result.outboundVolume).toBe('100');
      // api_call counting is unaffected by status/entryType
      expect(result.apiCalls).toBe('3');
    });

    it('fails closed when the plan is Enterprise/custom null terms', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-enterprise-1',
        planVersion: {
          ...FREE_VERSION,
          id: 'plan-enterprise-1',
          code: 'enterprise',
          monthlyFeeMicros: null,
          includedOutboundMicros: null,
          includedWallets: null,
          includedApiCalls: null,
        },
      });

      await expect(service.getSummary('user-1', '2026-05')).rejects.toThrow(ConflictException);
    });

    it('fails closed when the api_call count exceeds the safe integer range', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        { metric: 'api_call', quantity: 2n ** 60n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      await expect(service.getSummary('user-1', '2026-05')).rejects.toThrow(ConflictException);
    });

    it('rejects an invalid period', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
      });
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

    it('maps the real paidAt timestamp and keeps pdfUrl null', async () => {
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
          paidAt: new Date('2026-06-02T10:30:00.000Z'),
        },
      ]);
      invoiceCount.mockResolvedValue(1);

      const result = await service.listInvoices('user-1', { page: 1, limit: 20 });

      expect(result.items[0].paidAt).toBe('2026-06-02T10:30:00.000Z');
      expect(result.items[0].pdfUrl).toBeNull();
    });

    it('keeps paidAt null for unpaid invoices', async () => {
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
          paidAt: null,
        },
      ]);
      invoiceCount.mockResolvedValue(1);

      const result = await service.listInvoices('user-1', { page: 1, limit: 20 });

      expect(result.items[0].paidAt).toBeNull();
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
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 600_000_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
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
        .mockResolvedValueOnce(null) // cheap pre-check: none
        .mockResolvedValueOnce(null) // re-check inside the lock: none
        .mockResolvedValueOnce({
          id: 'inv-1',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          status: 'finalized',
          currency: 'USD',
          totalMicros: 55_000_000n,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        }); // after unique conflict: found
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockRejectedValue(p2002());

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

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(planVersionCreate).toHaveBeenCalledTimes(6);
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ planVersionId: FREE_VERSION.id, status: 'finalized' }),
        }),
      );
      expect(result.id).toBe('inv-1');
    });

    it('blocks finalize when quarantined outbound usage exists', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue({ id: 'quarantined-1' });

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a reconciliation run is failed', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([{ id: 'run-1', status: 'failed' }]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a reconciliation run is still running', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([{ id: 'run-1', status: 'running' }]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a reconciliation summary has conflicts', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        { id: 'run-1', status: 'completed', summary: { conflicts: 1 } },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('allows finalize when reconciliation runs are clean (errors=0, conflicts=0)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany
        .mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }])
        .mockResolvedValueOnce([]);
      // a usage-linked clean exhaustive run (replayed/casNoops are not errors)
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-05-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-05-01T00:00:00.000Z'],
          },
        },
      ]);
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

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-1');
      // candidate runs are fetched newest-first via a broad discovery query (linked
      // run ids + operational runs with periodStart >= target month); risk is
      // evaluated in JS, never SQL-filtered by metadata
      expect(reconciliationRunFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { periodStart: { gte: new Date('2026-05-01T00:00:00.000Z') } },
            ]),
          }),
          orderBy: { startedAt: 'desc' },
          select: { id: true, status: true, completedAt: true, summary: true },
        }),
      );
    });

    it('does not block finalize on legacy/unverified/reversed outbound', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null); // no quarantined
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 100n,
          quantity: 1n,
          status: 'unverified',
          entryType: 'usage',
        },
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 200n,
          quantity: 1n,
          status: 'reversed',
          entryType: 'usage',
        },
      ]);
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

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-1');
    });

    it('blocks finalize for a future/current period', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);

      await expect(service.finalizeInvoice('user-1', '2026-12')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize within the 24h grace window', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
      try {
        accountFindUnique.mockResolvedValue(ACCOUNT);
        planVersionFindFirst.mockResolvedValue(FREE_VERSION);
        invoiceFindUnique.mockResolvedValue(null);

        await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(
          ConflictException,
        );
        expect(invoiceCreate).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('blocks finalize when the plan has Enterprise null terms', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: { ...FREE_VERSION, monthlyFeeMicros: null },
      });

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('fails closed when the persisted plan has an unknown code during finalize', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-unknown-1',
        planVersion: { ...FREE_VERSION, id: 'plan-unknown-1', code: 'not-a-real-plan' },
      });

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('returns an existing finalized invoice unchanged even with later risk', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
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

      expect(result.id).toBe('inv-1');
      expect(invoiceCreate).not.toHaveBeenCalled();
      // no risk checks run for an already-finalized invoice
      expect(usageEventFindFirst).not.toHaveBeenCalled();
      expect(reconciliationRunFindMany).not.toHaveBeenCalled();
    });

    it('finalizes a pre-existing open invoice with usage and replaced lines', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      // cheap pre-check + in-lock re-check both see the open invoice
      invoiceFindUnique
        .mockResolvedValueOnce({ id: 'inv-open', status: 'open' })
        .mockResolvedValueOnce({ id: 'inv-open', status: 'open' });
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 600_000_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
      ]);
      reconciliationRunFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceUpdate.mockResolvedValue({
        id: 'inv-open',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 53_750_000n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      lineDeleteMany.mockResolvedValue({ count: 1 });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-open' },
          data: expect.objectContaining({ status: 'finalized' }),
        }),
      );
      expect(lineDeleteMany).toHaveBeenCalledWith({ where: { invoiceId: 'inv-open' } });
      expect(lineCreateMany).toHaveBeenCalled();
      expect(result.status).toBe('finalized');
    });

    it('runs risk checks, aggregation, and invoice creation inside one locked transaction', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([]);
      reconciliationRunFindMany.mockResolvedValue([]);
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

      await service.finalizeInvoice('user-1', '2026-05');

      // the advisory lock is acquired inside the interactive transaction
      expect(executeRaw).toHaveBeenCalled();
      const lockCall = executeRaw.mock.calls[0];
      expect(lockCall[0].join('')).toContain('pg_advisory_xact_lock');
      // risk checks, aggregation, and invoice/lines all used the tx client
      expect(usageEventFindFirst).toHaveBeenCalled();
      expect(reconciliationRunFindMany).toHaveBeenCalled();
      expect(usageEventFindMany).toHaveBeenCalled();
      expect(invoiceCreate).toHaveBeenCalled();
      expect(lineCreateMany).toHaveBeenCalled();
    });

    it('retries a serialization conflict without duplicate invoice/lines', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([]);
      reconciliationRunFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('serialization failure', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce({
          id: 'inv-1',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          status: 'finalized',
          currency: 'USD',
          totalMicros: 0n,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-1');
      // two attempts, but only one invoice and one set of lines
      expect(invoiceCreate).toHaveBeenCalledTimes(2);
      expect(lineCreateMany).toHaveBeenCalledTimes(1);
    });

    it('blocks finalize when a completed run has notFound > 0', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        { id: 'run-1', status: 'completed', summary: { notFound: 3 } },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a completed run has transientError > 0', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        { id: 'run-1', status: 'completed', summary: { transientError: 1 } },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('allows finalize when a later clean exhaustive run supersedes earlier failures', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany
        .mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }])
        .mockResolvedValueOnce([]);
      // newest first: run-2 is a clean exhaustive completion marker for this
      // user (completed after the period end, valid highWaterMark) and
      // supersedes the older run-1 retryable failure
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-2',
          status: 'completed',
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-05-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-05-01T00:00:00.000Z'],
          },
        },
        { id: 'run-1', status: 'completed', summary: { userId: 'user-1', notFound: 3 } },
      ]);
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

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-1');
    });

    it('blocks finalize when the latest run is incomplete (no complete marker)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          summary: { userId: 'user-1', errors: 0, conflicts: 0 },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a complete run completed before the period end', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-05-15T00:00:00.000Z'), // before periodEnd 2026-06-01
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-05-10T00:00:00.000Z', id: 'tx-1' },
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a complete run has a malformed highWaterMark', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: 'not-an-object',
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a non-empty complete run lacks a highWaterMark', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('allows finalize when a valid exhaustive marker is after the cutoff with no risk', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany
        .mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }])
        .mockResolvedValueOnce([]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-06-02T00:00:00.000Z'), // after periodEnd 2026-06-01
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-05-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-05-01T00:00:00.000Z'],
          },
        },
      ]);
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

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-1');
    });

    it('blocks finalize when a legacy summary lacks userId/highWaterMark', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: { errors: 0, conflicts: 0 }, // no complete marker / userId
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('skips a clean run whose valid coverage does not include the target month', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      // no July usage events are associated with the June run
      usageEventFindMany.mockResolvedValue([]);
      // a clean exhaustive run whose valid accountingPeriods covers June, not
      // the July target — the relevance branch skips it and finalize proceeds
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-06-30T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-06-01T00:00:00.000Z'],
          },
        },
      ]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-07');

      expect(result.id).toBe('inv-1');
      // operational runs are discovered broadly by periodStart >= target month
      // (never SQL-filtered by accountingPeriods metadata)
      expect(reconciliationRunFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { periodStart: { gte: new Date('2026-07-01T00:00:00.000Z') } },
            ]),
          }),
        }),
      );
    });

    it('still blocks finalize when a current-period run has retryable risk', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 2,
            transientError: 0,
            highWaterMark: { createdAt: '2026-07-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-07-01T00:00:00.000Z'],
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when an unlinked valid run covers the target month with retryable risk', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([]); // not usage-linked
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 2,
            transientError: 0,
            highWaterMark: { createdAt: '2026-07-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-07-01T00:00:00.000Z'], // covers target July
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when an unlinked running run has missing coverage metadata', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([]); // not linked to July usage
      // discovered via the broad periodStart >= target query; no accountingPeriods
      reconciliationRunFindMany.mockResolvedValue([
        { id: 'run-1', status: 'running', completedAt: null, summary: {} },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when an unlinked run has malformed coverage and retryable risk', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([]);
      // malformed accountingPeriods must be discovered (broad query) and
      // evaluated as risky — never SQL-filtered into fail-open
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 1,
            transientError: 0,
            highWaterMark: { createdAt: '2026-07-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: 'not-an-array',
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('rejects non-canonical accountingPeriods values', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValueOnce([{ reconciliationRunId: 'run-1' }]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-07-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-07-01T00:00:00Z'], // non-canonical (no ms)
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('blocks finalize when a cross-month run has receipt uncertainty for the target', async () => {
      // transaction created in June (createdAt month A), receipt could be mined
      // in July (month B); the run scanned in July with notFound. createdAt
      // coverage must NOT clear the target risk.
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany.mockResolvedValue([]);
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: false,
            scanned: 1,
            notFound: 1,
            accountingPeriods: ['2026-06-01T00:00:00.000Z'], // createdAt month, not proof
          },
        },
      ]);

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('lets a later clean exhaustive run clear older risk for the target', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null);
      usageEventFindMany
        .mockResolvedValueOnce([{ reconciliationRunId: 'run-2' }])
        .mockResolvedValueOnce([]);
      // newest first: run-2 is a clean exhaustive marker after the cutoff with
      // valid coverage/high-water and supersedes the older run-1 retryable risk
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-2',
          status: 'completed',
          completedAt: new Date('2026-08-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            highWaterMark: { createdAt: '2026-07-31T23:59:59.000Z', id: 'tx-1' },
            accountingPeriods: ['2026-07-01T00:00:00.000Z'],
          },
        },
        { id: 'run-1', status: 'completed', summary: { userId: 'user-1', notFound: 3 } },
      ]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-07');

      expect(result.id).toBe('inv-1');
    });
  });
});

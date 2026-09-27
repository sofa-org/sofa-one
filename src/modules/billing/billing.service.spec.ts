import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService, buildInvoiceLineSpecs } from './billing.service';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { BillingPlanChangeService } from './billing-plan-change.service';
import { calculateInvoiceTotals, PLANS } from './billing-calculator';
import { StripeSubscriptionSyncService } from './stripe/stripe-subscription-sync.service';
import { BillingWalletLifecycleService } from './billing-wallet-lifecycle.service';

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
  const autoIntentFindMany = jest.fn();
  const syncIntentFindMany = jest.fn();
  const planVersionFindFirst = jest.fn();
  const planVersionFindUnique = jest.fn();
  const planVersionFindMany = jest.fn();
  const planVersionCreate = jest.fn();
  const assignmentFindFirst = jest.fn();
  const assignmentFindMany = jest.fn();
  const assignmentCreate = jest.fn();
  const assignmentFindUnique = jest.fn();
  const assignmentUpdate = jest.fn();
  const planChangeFindFirst = jest.fn();
  const usageEventCreate = jest.fn();
  const usageEventFindMany = jest.fn();
  const usageEventFindUnique = jest.fn();
  const usageEventFindFirst = jest.fn();
  const usageEventAggregate = jest.fn();
  const reconciliationRunFindMany = jest.fn();
  const transactionFindUnique = jest.fn();
  const transactionCount = jest.fn();
  const transactionUpdateMany = jest.fn();
  const walletCount = jest.fn();
  const walletUsageFindUnique = jest.fn();
  const prepareWalletUsage = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const invoiceFindMany = jest.fn();
  const invoiceCount = jest.fn();
  const invoiceCreate = jest.fn();
  const invoiceUpdate = jest.fn();
  const attemptFindMany = jest.fn();
  const lineCreateMany = jest.fn();
  const lineDeleteMany = jest.fn();
  const transaction = jest.fn();
  const executeRaw = jest.fn();
  const queryRaw = jest.fn();
  const settleInvoice = jest.fn();
  const requestPlanChange = jest.fn();
  const cancelScheduledPlanChange = jest.fn();
  const cancelPendingUpgrade = jest.fn();
  const processAccountBestEffort = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();
    // Pin the clock to the fixture date the period-based expectations are
    // written against (2026-08-25), so "next UTC month" assertions never
    // depend on the wall-clock month the suite happens to run in.
    jest.useFakeTimers({ now: new Date('2026-08-25T00:00:00.000Z') });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        {
          provide: PrismaService,
          useValue: {
            billingAccount: { findUnique: accountFindUnique, create: accountCreate },
            billingAutoSubscriptionIntent: { findFirst: jest.fn().mockResolvedValue(null), findMany: autoIntentFindMany },
            billingSubscriptionSyncIntent: { findMany: syncIntentFindMany },
            billingPlanVersion: {
              findFirst: planVersionFindFirst,
              findUnique: planVersionFindUnique,
              findMany: planVersionFindMany,
              create: planVersionCreate,
            },
            billingPlanAssignment: {
              findFirst: assignmentFindFirst,
              findMany: assignmentFindMany,
              create: assignmentCreate,
              findUnique: assignmentFindUnique,
              update: assignmentUpdate,
            },
            billingPlanChange: {
              findFirst: planChangeFindFirst,
            },
            billingUsageEvent: {
              create: usageEventCreate,
              findMany: usageEventFindMany,
              findUnique: usageEventFindUnique,
              findFirst: usageEventFindFirst,
              aggregate: usageEventAggregate,
            },
            billingReconciliationRun: { findMany: reconciliationRunFindMany },
            transaction: {
              findUnique: transactionFindUnique,
              count: transactionCount,
              updateMany: transactionUpdateMany,
            },
            userWallet: { count: walletCount },
            billingWalletUsagePeriod: { findUnique: walletUsageFindUnique },
            billingInvoice: {
              findUnique: invoiceFindUnique,
              findUniqueOrThrow: jest.fn(async (args: unknown) => {
                const row = await invoiceFindUnique(args);
                if (!row) {
                  const err = new Error('not found') as Error & { code?: string };
                  err.code = 'P2025';
                  throw err;
                }
                return row;
              }),
              findFirst: invoiceFindFirst,
              findMany: invoiceFindMany,
              count: invoiceCount,
              create: invoiceCreate,
              update: invoiceUpdate,
            },
            billingPaymentAttempt: { findMany: attemptFindMany },
            billingInvoiceLine: { createMany: lineCreateMany, deleteMany: lineDeleteMany },
            $transaction: transaction,
          },
        },
        { provide: InvoiceSettlementService, useValue: { settleInvoice } },
        { provide: BillingWalletLifecycleService, useValue: { prepareWalletUsageThroughCurrentMonth: prepareWalletUsage } },
        {
          provide: BillingPlanChangeService,
          useValue: { requestPlanChange, cancelScheduledPlanChange, cancelPendingUpgrade },
        },
        {
          provide: StripeSubscriptionSyncService,
          useValue: { processAccountBestEffort },
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);

    // Defaults for the Phase 1E fail-closed risk checks: no quarantined usage
    // and no risky reconciliation runs unless a test overrides them.
    usageEventFindFirst.mockResolvedValue(null);
    autoIntentFindMany.mockResolvedValue([]);
    syncIntentFindMany.mockResolvedValue([]);
    reconciliationRunFindMany.mockResolvedValue([]);
    // No unresolved outbound transaction work (the no-run barrier passes).
    transactionCount.mockResolvedValue(0);
    prepareWalletUsage.mockResolvedValue(undefined);
    walletUsageFindUnique.mockResolvedValue({ peakWalletCount: 0 });
    transactionUpdateMany.mockResolvedValue({ count: 1 });
    // usage_period invoice lookups now use findFirst (purpose filter) instead of
    // the removed compound unique. Default findFirst to the same mock chain as
    // findUnique so existing finalize/period tests keep working; tests that
    // need id-scoped findFirst override this implementation explicitly.
    invoiceFindFirst.mockImplementation((args) => invoiceFindUnique(args));
    // Entitlement/usage resolvers walk assignments via findMany; default to the
    // prior findFirst mock so existing tests keep working. Paid plans without
    // expiresAt are given a far-future bound so legacy fixtures remain valid
    // under Gate 1 entitlement rules (only Free may be open-ended).
    assignmentFindMany.mockImplementation(async (args) => {
      const row = await assignmentFindFirst(args);
      if (row == null) return [];
      const list = Array.isArray(row) ? row : [row];
      return list.map((r: any) => {
        const fee = r.planVersion?.monthlyFeeMicros ?? r.monthlyFeeMicros ?? 0n;
        if (r.expiresAt == null && fee > 0n) {
          return {
            ...r,
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            source: r.source ?? 'renewal',
          };
        }
        return r;
      });
    });
    planChangeFindFirst.mockResolvedValue(null);
    // finalize pins usage invoice planVersionId via findUnique.
    planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where?.id === STARTER_VERSION.id) return STARTER_VERSION;
      if (where?.id === FREE_VERSION.id) return FREE_VERSION;
      return FREE_VERSION;
    });

    // The interactive transaction client used by withBillingPeriodLock. All
    // model accessors share the same jest.fn() instances as this.prisma so the
    // production lock path is exercised (never silently skipped).
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
      billingAccount: { findUnique: accountFindUnique, create: accountCreate },
      billingPlanVersion: {
        findFirst: planVersionFindFirst,
        findUnique: planVersionFindUnique,
        findMany: planVersionFindMany,
        create: planVersionCreate,
      },
      billingPlanAssignment: {
        findFirst: assignmentFindFirst,
        findMany: assignmentFindMany,
        create: assignmentCreate,
        findUnique: assignmentFindUnique,
        update: assignmentUpdate,
      },
      billingPlanChange: {
        findFirst: planChangeFindFirst,
      },
      billingUsageEvent: {
        create: usageEventCreate,
        findMany: usageEventFindMany,
        findUnique: usageEventFindUnique,
        findFirst: usageEventFindFirst,
        aggregate: usageEventAggregate,
      },
      billingReconciliationRun: { findMany: reconciliationRunFindMany },
      transaction: {
        findUnique: transactionFindUnique,
        count: transactionCount,
        updateMany: transactionUpdateMany,
      },
      userWallet: { count: walletCount },
      billingWalletUsagePeriod: { findUnique: walletUsageFindUnique },
      billingInvoice: {
        findUnique: invoiceFindUnique,
        findUniqueOrThrow: jest.fn(async (args: unknown) => {
          const row = await invoiceFindUnique(args);
          if (!row) {
            const err = new Error('not found') as Error & { code?: string };
            err.code = 'P2025';
            throw err;
          }
          return row;
        }),
        findFirst: invoiceFindFirst,
        findMany: invoiceFindMany,
        count: invoiceCount,
        create: invoiceCreate,
        update: invoiceUpdate,
      },
      billingPaymentAttempt: { findMany: attemptFindMany },
      billingInvoiceLine: { createMany: lineCreateMany, deleteMany: lineDeleteMany },
    };
    transaction.mockImplementation(async (cb) => cb(tx));
    executeRaw.mockResolvedValue(undefined);
    queryRaw.mockResolvedValue([{ id: 'run-1' }]);
    attemptFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getPlans', () => {
    it('fails closed for an active mirror without a complete subscription binding', async () => {
      accountFindUnique.mockResolvedValue({
        stripeSubscriptionStatus: 'active', stripeSubscriptionId: null, stripeCustomerId: 'cus-private',
        stripeSubscriptionPeriodEnd: new Date('2026-09-01T00:00:00.000Z'), currency: 'USD',
      });
      const dto = await service['getRenewalDto'](ACCOUNT.id);
      expect(dto).toEqual({ status: 'needs_attention', subscriptionStatus: 'unknown', paymentMethod: 'unknown', nextChargeAt: null, amount: null, currency: null });
      expect(Object.keys(dto).sort()).toEqual(['amount', 'currency', 'nextChargeAt', 'paymentMethod', 'status', 'subscriptionStatus'].sort());
    });

    it.each([null, new Date('2026-08-01T00:00:00.000Z')])(
      'fails closed for an active bound mirror with missing or past period end (%s)',
      async (periodEnd) => {
        accountFindUnique.mockResolvedValue({
          stripeSubscriptionId: 'sub-private',
          stripeCustomerId: 'cus-private',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPeriodEnd: periodEnd,
          activeSubscriptionPlanVersionId: 'plan-private',
          currency: 'USD',
        });

        const dto = await service['getRenewalDto'](ACCOUNT.id);

        expect(dto).toEqual({
          status: 'needs_attention',
          subscriptionStatus: 'unknown',
          paymentMethod: 'unknown',
          nextChargeAt: null,
          amount: null,
          currency: null,
        });
        expect(syncIntentFindMany).not.toHaveBeenCalled();
        expect(planVersionFindUnique).not.toHaveBeenCalled();
      },
    );

    it('does not expose dates or amounts for an unresolved first-subscription review', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionStatus: null, stripeSubscriptionId: null, stripeCustomerId: 'cus-owner' });
      autoIntentFindMany.mockResolvedValue([{ status: 'needs_review', effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), unitAmountCents: 4900, currency: 'usd', stripeCustomerId: 'cus-owner', stripeSubscriptionId: null }]);
      const dto = await service['getRenewalDto'](ACCOUNT.id);
      expect(dto).toEqual({ status: 'needs_attention', subscriptionStatus: 'unknown', paymentMethod: 'card', nextChargeAt: null, amount: null, currency: null });
    });

    it('projects a valid future pending first-subscription intent as safe card USD', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionStatus: null, stripeSubscriptionId: null, stripeCustomerId: 'cus-owner' });
      autoIntentFindMany.mockResolvedValue([{ status: 'pending', effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), unitAmountCents: 4900, currency: 'usd', stripeCustomerId: 'cus-owner', stripeSubscriptionId: null }]);
      const dto = await service['getRenewalDto'](ACCOUNT.id);
      expect(dto).toEqual({ status: 'pending', subscriptionStatus: 'pending', paymentMethod: 'card', nextChargeAt: '2026-09-01T00:00:00.000Z', amount: '49.00', currency: 'USD' });
    });

    it('treats a completed first intent without account mirror binding as needs_attention', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionStatus: null, stripeSubscriptionId: null, stripeCustomerId: 'cus-owner' });
      autoIntentFindMany.mockResolvedValue([{ status: 'completed', effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), unitAmountCents: 4900, currency: 'usd', stripeCustomerId: 'cus-owner', stripeSubscriptionId: 'sub-completed' }]);
      expect(await service['getRenewalDto'](ACCOUNT.id)).toMatchObject({ status: 'needs_attention', subscriptionStatus: 'unknown', nextChargeAt: null, amount: null });
    });

    it('does not treat synced history with a missing effective start as enabled via fallback', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub-1', stripeCustomerId: 'cus-1', stripeSubscriptionStatus: 'active', stripeSubscriptionPeriodEnd: new Date('2026-09-20T00:00:00Z'), activeSubscriptionPlanVersionId: 'plan-1', currency: 'USD' });
      syncIntentFindMany.mockResolvedValueOnce([{ revision: 1, effectivePeriodStart: null, kind: 'update_item' }]);
      expect(await service['getRenewalDto'](ACCOUNT.id)).toMatchObject({ status: 'needs_attention', subscriptionStatus: 'unknown', nextChargeAt: null, amount: null });
    });

    it.each(['in_flight', 'needs_review'])('prioritizes %s over a newer pending revision', async (unresolvedStatus) => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub-1', stripeCustomerId: 'cus-1', stripeSubscriptionStatus: 'active', stripeSubscriptionPeriodEnd: new Date('2026-09-20T00:00:00Z'), activeSubscriptionPlanVersionId: 'plan-1', currency: 'USD' });
      syncIntentFindMany
        .mockResolvedValueOnce([{ revision: 3, effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), kind: 'update_item' }])
        .mockResolvedValueOnce([{ revision: 5, status: 'pending' }, { revision: 4, status: unresolvedStatus }]);
      const dto = await service['getRenewalDto'](ACCOUNT.id);
      expect(dto).toMatchObject({ status: 'needs_attention', subscriptionStatus: 'active', nextChargeAt: null, amount: null });
      expect(JSON.stringify(dto)).not.toMatch(/sub-1|cus-1/);
    });

    it('allows a higher-revision valid synced fact to supersede null-effective history', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub-1', stripeCustomerId: 'cus-1', stripeSubscriptionStatus: 'active', stripeSubscriptionPeriodEnd: new Date('2026-09-20T00:00:00Z'), activeSubscriptionPlanVersionId: 'plan-1', currency: 'USD' });
      syncIntentFindMany.mockResolvedValueOnce([
        { revision: 3, effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), kind: 'cancel_at_period_end' },
        { revision: 2, effectivePeriodStart: null, kind: 'update_item' },
      ]).mockResolvedValueOnce([]);
      expect(await service['getRenewalDto'](ACCOUNT.id)).toMatchObject({ status: 'disabled', subscriptionStatus: 'active', nextChargeAt: null, amount: null });
    });

    it('fails closed when an auto-subscription intent customer cannot be matched to the account', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionStatus: null, stripeSubscriptionId: null, stripeCustomerId: 'cus-account' });
      autoIntentFindMany.mockResolvedValue([{ status: 'pending', effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), unitAmountCents: 4900, currency: 'usd', stripeCustomerId: 'cus-other', stripeSubscriptionId: null }]);
      expect(await service['getRenewalDto'](ACCOUNT.id)).toMatchObject({ status: 'needs_attention', subscriptionStatus: 'unknown', nextChargeAt: null, amount: null });
    });

    it('fails closed when the auto-subscription intent or account lacks customer ownership evidence', async () => {
      accountFindUnique.mockResolvedValue({ stripeSubscriptionStatus: null, stripeSubscriptionId: null, stripeCustomerId: null });
      autoIntentFindMany.mockResolvedValue([{ status: 'pending', effectivePeriodStart: new Date('2026-09-01T00:00:00Z'), unitAmountCents: 4900, currency: 'usd', stripeCustomerId: null, stripeSubscriptionId: null }]);
      const dto = await service['getRenewalDto'](ACCOUNT.id);
      expect(dto).toMatchObject({ status: 'needs_attention', subscriptionStatus: 'unknown', nextChargeAt: null, amount: null, currency: null });
      expect(JSON.stringify(dto)).not.toMatch(/stripe|cus-|sub-/i);
    });

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
      // New plan versions pin the plan-specific API overage rate.
      expect(planVersionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            apiOverageRateMicros: 2000n,
            walletOverageRateMicros: 10_000n,
          }),
        }),
      );
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
      // No explicit BillingPlanChange — assignment projection is the fallback.
      planChangeFindFirst.mockResolvedValue(null);
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      // the future Starter assignment must not override the current Free plan
      expect(result.currentPlanId).toBe('free');
      expect(result.scheduledPlan).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      });
      expect(planChangeFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            status: 'scheduled',
          }),
        }),
      );
    });

    it('exposes a paid scheduled downgrade from BillingPlanChange when no future assignment exists', async () => {
      // Growth → Starter is a paid downgrade/lateral: schedule intent only, no
      // unpaid paid assignment projection for next month.
      const GROWTH_VERSION = {
        ...STARTER_VERSION,
        id: 'plan-growth-1',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 199_000_000n,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(GROWTH_VERSION);
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-current',
          billingAccountId: ACCOUNT.id,
          planVersionId: GROWTH_VERSION.id,
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: new Date('2026-09-01T00:00:00.000Z'),
          source: 'renewal',
          planVersion: GROWTH_VERSION,
        })
        .mockResolvedValueOnce(null); // no future assignment projection
      planChangeFindFirst.mockResolvedValue({
        id: 'chg-paid-sched',
        status: 'scheduled',
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        toPlanVersion: STARTER_VERSION,
      });
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION, GROWTH_VERSION]);

      const result = await service.getPlans('user-1');

      expect(result.currentPlanId).toBe('growth');
      expect(result.scheduledPlan).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      });
      expect(planChangeFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            status: 'scheduled',
            periodStart: { gt: new Date('2026-08-01T00:00:00.000Z') },
          }),
        }),
      );
    });

    it('prefers an explicit scheduled paid change over a coexisting future renewal assignment', async () => {
      // requestDowngradeOrLateral leaves renewal/upgrade_payment projections
      // untouched while writing a scheduled BillingPlanChange for a paid
      // target. Dashboard must surface the schedule (cancel-discoverable), not
      // the residual renewal assignment plan.
      const GROWTH_VERSION = {
        ...STARTER_VERSION,
        id: 'plan-growth-1',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 199_000_000n,
      };
      const nextStart = new Date('2026-09-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(GROWTH_VERSION);
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-current',
          billingAccountId: ACCOUNT.id,
          planVersionId: GROWTH_VERSION.id,
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: nextStart,
          source: 'renewal',
          planVersion: GROWTH_VERSION,
        })
        .mockResolvedValueOnce({
          id: 'assign-future-renewal',
          billingAccountId: ACCOUNT.id,
          periodStart: nextStart,
          planVersionId: GROWTH_VERSION.id,
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          source: 'renewal',
          planVersion: GROWTH_VERSION,
        });
      planChangeFindFirst.mockResolvedValue({
        id: 'chg-paid-sched',
        status: 'scheduled',
        periodStart: nextStart,
        toPlanVersion: STARTER_VERSION,
      });
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION, GROWTH_VERSION]);

      const result = await service.getPlans('user-1');

      expect(result.currentPlanId).toBe('growth');
      expect(result.scheduledPlan).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-09',
      });
    });

    it('does not expose canceled plan changes as scheduledPlan', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(STARTER_VERSION);
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-current',
          billingAccountId: ACCOUNT.id,
          planVersionId: STARTER_VERSION.id,
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: new Date('2026-09-01T00:00:00.000Z'),
          source: 'renewal',
          planVersion: STARTER_VERSION,
        })
        .mockResolvedValueOnce(null);
      // Query filters status=scheduled; mock returns none (canceled rows excluded).
      planChangeFindFirst.mockResolvedValue(null);
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      expect(result.currentPlanId).toBe('starter');
      expect(result.scheduledPlan).toBeUndefined();
    });

    it('reclassifies current-month legacy paid assignment (null expiresAt) to Free without P2002', async () => {
      // Fake clock is 2026-08-25 → current month start 2026-08-01.
      const monthStart = new Date('2026-08-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      const legacy = {
        id: 'asg-legacy',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: monthStart,
        expiresAt: null,
        source: null,
        planVersion: STARTER_VERSION,
      };
      // Do not auto-repair expiresAt — this is the invalid legacy shape.
      assignmentFindMany.mockResolvedValue([legacy]);
      assignmentFindUnique.mockResolvedValue(legacy);
      assignmentUpdate.mockResolvedValue({
        ...legacy,
        planVersionId: FREE_VERSION.id,
        source: 'default',
        expiresAt: null,
        planVersion: FREE_VERSION,
      });
      assignmentFindFirst.mockResolvedValue(null);
      planVersionFindMany.mockResolvedValue([FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'asg-legacy' },
          data: expect.objectContaining({
            planVersionId: FREE_VERSION.id,
            source: 'default',
            expiresAt: null,
          }),
        }),
      );
      expect(result.currentPlanId).toBe('free');
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

    it('filters stray non-canonical rows out of the catalog listing', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already seeded
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-1',
          billingAccountId: ACCOUNT.id,
          planVersionId: FREE_VERSION.id,
          planVersion: FREE_VERSION,
        })
        .mockResolvedValue(null); // no future scheduled assignment
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);

      // Leftover claim-plan-<uuid> row from an interrupted concurrency run
      const strayRow = { ...FREE_VERSION, id: 'plan-claim-1', code: 'claim-plan-abc123' };
      // Simulate Prisma's `code in [...]` constraint on the catalog query
      planVersionFindMany.mockImplementation(
        async ({ where }: { where: { code: { in: readonly string[] } } }) => {
          const rows = [FREE_VERSION, STARTER_VERSION, strayRow];
          return rows.filter((row) => where.code.in.includes(row.code));
        },
      );

      const result = await service.getPlans('user-1');

      // the catalog query is constrained to canonical PLANS codes
      expect(planVersionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { code: { in: expect.arrayContaining(Object.keys(PLANS)) } },
        }),
      );
      // the stray row is excluded; canonical plans are still listed
      expect(result.plans.map((p) => p.id)).toEqual(['free', 'starter']);
      expect(result.plans.map((p) => p.id)).not.toContain('claim-plan-abc123');
    });

    it('returns one latest-version DTO per plan code when v1/v2 coexist', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already seeded
      assignmentFindFirst
        .mockResolvedValueOnce({
          id: 'assign-1',
          billingAccountId: ACCOUNT.id,
          planVersionId: FREE_VERSION.id,
          planVersion: FREE_VERSION,
        })
        .mockResolvedValue(null); // no future scheduled assignment
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);

      // Same 'free' code with v1 + v2; the catalog query sorts code asc,
      // version desc so v2 is returned before v1.
      const FREE_V2 = {
        ...FREE_VERSION,
        id: 'plan-free-2',
        version: 2,
        name: 'Free v2',
        monthlyFeeMicros: 10_000_000n, // $10
      };
      planVersionFindMany.mockResolvedValue([FREE_V2, FREE_VERSION, STARTER_VERSION]);

      const result = await service.getPlans('user-1');

      // the catalog listing query keeps version-desc ordering per code
      expect(planVersionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ code: 'asc' }, { version: 'desc' }],
        }),
      );
      // exactly one DTO per canonical plan code, no duplicate option ids
      const ids = result.plans.map((p) => p.id);
      expect(ids).toEqual(['free', 'starter']);
      expect(new Set(ids).size).toBe(ids.length);
      expect(result.plans).toHaveLength(2);

      // the surviving 'free' DTO is built from the latest (v2) version
      const freeDto = result.plans.find((p) => p.id === 'free');
      expect(freeDto).toMatchObject({
        id: 'free',
        name: 'Free v2',
        basePrice: '10',
        currency: 'USD',
        billingPeriod: 'Monthly',
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

    function mockCurrentFreeAssignment() {
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-current',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: null,
        planVersion: FREE_VERSION,
      });
    }

    it('upgrade returns payment_required and does not rewrite usage assignment/invoice itself', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      mockCurrentFreeAssignment();
      requestPlanChange.mockResolvedValue({
        outcome: 'payment_required',
        planCode: 'starter',
        planName: 'Starter',
        changeId: 'chg-1',
        invoiceId: 'inv-charge-1',
        amount: '25.000000',
        currency: 'USD',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        kind: 'upgrade',
      });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result).toMatchObject({
        outcome: 'payment_required',
        planCode: 'starter',
        changeId: 'chg-1',
        invoiceId: 'inv-charge-1',
        kind: 'upgrade',
      });
      expect(requestPlanChange).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAccountId: ACCOUNT.id,
          targetPlanVersion: STARTER_VERSION,
          currentPlanVersion: FREE_VERSION,
        }),
      );
      // BillingService no longer writes assignment/open invoice for upgrades.
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('treats the same target plan as an idempotent no-op', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: null,
        planVersion: STARTER_VERSION,
      });
      requestPlanChange.mockResolvedValue({
        outcome: 'unchanged',
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('unchanged');
      expect(result).not.toHaveProperty('requiresPostCommitStripeSync');
      expect(processAccountBestEffort).not.toHaveBeenCalled();
    });

    it('triggers post-commit Stripe sync when unchanged canceled a schedule, without exposing the internal flag', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: null,
        planVersion: STARTER_VERSION,
      });
      requestPlanChange.mockResolvedValue({
        outcome: 'unchanged',
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        requiresPostCommitStripeSync: true,
      });
      processAccountBestEffort.mockResolvedValue(undefined);

      const result = await service.assignPlan('user-1', 'starter');

      expect(result).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        outcome: 'unchanged',
      });
      expect(result).not.toHaveProperty('requiresPostCommitStripeSync');
      expect(processAccountBestEffort).toHaveBeenCalledWith(ACCOUNT.id);
    });

    it('downgrade returns scheduled for next UTC month', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: null,
        planVersion: STARTER_VERSION,
      });
      // Target free is returned when code=free after starter lookup for free path —
      // assignPlan looks up body.planCode first.
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) => {
        if (where.code === 'free') return FREE_VERSION;
        if (where.code === 'starter') return STARTER_VERSION;
        return FREE_VERSION;
      });
      requestPlanChange.mockResolvedValue({
        outcome: 'scheduled',
        planCode: 'free',
        planName: 'Free',
        changeId: 'chg-down-1',
        effectivePeriod: '2026-09',
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        kind: 'downgrade',
      });

      const result = await service.assignPlan('user-1', 'free');

      expect(result).toMatchObject({
        outcome: 'scheduled',
        planCode: 'free',
        effectivePeriod: '2026-09',
        kind: 'downgrade',
      });
    });

    it('rejects Enterprise/custom null terms via self-service', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();

      await expect(service.assignPlan('user-1', 'enterprise')).rejects.toThrow(ConflictException);
      expect(requestPlanChange).not.toHaveBeenCalled();
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
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'ghost-plan'
          ? { ...FREE_VERSION, id: 'plan-ghost-1', code: 'ghost-plan' }
          : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'ghost-plan')).rejects.toThrow(BadRequestException);
      expect(requestPlanChange).not.toHaveBeenCalled();
    });

    it.each(['toString', 'constructor', '__proto__', '', 123 as unknown as string])(
      'rejects inherited/empty/non-string plan code %p with zero DB calls',
      async (badCode) => {
        await expect(service.assignPlan('user-1', badCode)).rejects.toThrow(BadRequestException);
        expect(accountFindUnique).not.toHaveBeenCalled();
        expect(planVersionFindFirst).not.toHaveBeenCalled();
        expect(requestPlanChange).not.toHaveBeenCalled();
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
      expect(requestPlanChange).not.toHaveBeenCalled();
    });

    it('rejects a finite plan with a negative quota field', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter' ? { ...STARTER_VERSION, includedApiCalls: -1n } : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'starter')).rejects.toThrow(ConflictException);
      expect(requestPlanChange).not.toHaveBeenCalled();
    });

    it('rejects a finite plan with an unsafe wallet count', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter' ? { ...STARTER_VERSION, includedWallets: 2 ** 53 } : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'starter')).rejects.toThrow(ConflictException);
      expect(requestPlanChange).not.toHaveBeenCalled();
    });

    it('keeps a known historical finite plan valid for upgrade request', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      const historical = { ...STARTER_VERSION, monthlyFeeMicros: 99_000_000n };
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'starter' ? historical : FREE_VERSION,
      );
      mockCurrentFreeAssignment();
      requestPlanChange.mockResolvedValue({
        outcome: 'payment_required',
        planCode: 'starter',
        planName: 'Starter',
        changeId: 'chg-1',
        invoiceId: 'inv-charge-1',
        amount: '50.000000',
        currency: 'USD',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        kind: 'upgrade',
      });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('payment_required');
      expect(requestPlanChange).toHaveBeenCalled();
    });

    it('rejects a malformed Enterprise persisted row with finite terms', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockImplementation(async ({ where }: { where: { code?: string } }) =>
        where.code === 'enterprise'
          ? { ...FREE_VERSION, id: 'plan-enterprise-1', code: 'enterprise' }
          : FREE_VERSION,
      );

      await expect(service.assignPlan('user-1', 'enterprise')).rejects.toThrow(ConflictException);
      expect(requestPlanChange).not.toHaveBeenCalled();
    });

    it('retries a serialization conflict during plan assignment', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      mockPlanLookup();
      mockCurrentFreeAssignment();
      requestPlanChange
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('serialization failure', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce({
          outcome: 'payment_required',
          planCode: 'starter',
          planName: 'Starter',
          changeId: 'chg-1',
          invoiceId: 'inv-charge-1',
          amount: '25.000000',
          currency: 'USD',
          effectivePeriod: '2026-08',
          effectiveFrom: '2026-08-01T00:00:00.000Z',
          kind: 'upgrade',
        });

      const result = await service.assignPlan('user-1', 'starter');

      expect(result.outcome).toBe('payment_required');
      expect(requestPlanChange).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancelPendingUpgrade', () => {
    it('locks the soft-read identity period and passes expected id/period without Stripe sync', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planChangeFindFirst.mockResolvedValue({
        id: 'chg-up-1',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
      });
      cancelPendingUpgrade.mockResolvedValue({
        outcome: 'canceled',
        planCode: 'free',
        planName: 'Free',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      });

      const result = await service.cancelPendingUpgrade('user-1');

      expect(cancelPendingUpgrade).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAccountId: ACCOUNT.id,
          expectedChangeId: 'chg-up-1',
          expectedPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
        }),
      );
      expect(processAccountBestEffort).not.toHaveBeenCalled();
      // No assignment writers on the upgrade-cancel path.
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({
        planCode: 'free',
        planName: 'Free',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        outcome: 'canceled',
      });
    });

    it('is an idempotent no-op when nothing is pending and never writes assignments', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planChangeFindFirst.mockResolvedValue(null);
      cancelPendingUpgrade.mockResolvedValue({
        outcome: 'unchanged',
        planCode: 'free',
        planName: 'Free',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      });

      const result = await service.cancelPendingUpgrade('user-1');

      expect(cancelPendingUpgrade).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedChangeId: null,
          expectedPeriodStart: null,
        }),
      );
      expect(result.outcome).toBe('unchanged');
      expect(processAccountBestEffort).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
      expect(assignmentFindFirst).not.toHaveBeenCalled();
      expect(assignmentFindMany).not.toHaveBeenCalled();
      expect(assignmentFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('cancelScheduledPlan', () => {
    it('cancels via plan-change service under the period lock and strips the internal sync flag', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: STARTER_VERSION,
      });
      cancelScheduledPlanChange.mockResolvedValue({
        outcome: 'canceled',
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        requiresPostCommitStripeSync: true,
      });
      processAccountBestEffort.mockResolvedValue(undefined);

      const result = await service.cancelScheduledPlan('user-1');

      expect(cancelScheduledPlanChange).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAccountId: ACCOUNT.id,
          currentPlanVersion: STARTER_VERSION,
        }),
      );
      expect(processAccountBestEffort).toHaveBeenCalledWith(ACCOUNT.id);
      expect(result).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        outcome: 'canceled',
      });
      expect(result).not.toHaveProperty('requiresPostCommitStripeSync');
    });

    it('is an idempotent no-op without post-commit sync when nothing is scheduled', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: STARTER_VERSION,
      });
      cancelScheduledPlanChange.mockResolvedValue({
        outcome: 'unchanged',
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      });

      const result = await service.cancelScheduledPlan('user-1');

      expect(result.outcome).toBe('unchanged');
      expect(processAccountBestEffort).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('requiresPostCommitStripeSync');
    });
  });

  describe('recordApiCall', () => {
    it('creates an explicitly unverified api_call usage event (legacy seam, never quota/billable)', async () => {
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
            // The legacy seam writes its status explicitly — never relying on
            // the Prisma default — and is never posted, so only
            // assertAndRecordApiCall rows can consume quota or appear on an
            // invoice.
            entryType: 'usage',
            sourceType: 'api_request',
            status: 'unverified',
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
      expect(usageEventFindMany).not.toHaveBeenCalled();
    });

    it('records calls without querying prior usage rows', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog initialized
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-posted-only',
        endpoint: '/v1/wallets/sign',
      });

      expect(usageEventFindMany).not.toHaveBeenCalled();
      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            metric: 'api_call',
            entryType: 'usage',
            sourceType: 'api_request',
            status: 'posted',
            sourceKey: 'api:req-posted-only',
          }),
        }),
      );
    });

    it('records successfully at the former quota boundary', async () => {
      mockQuotaSetup(10_000); // at limit

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-2',
        endpoint: '/v1/wallets/sign',
      });
      expect(usageEventCreate).toHaveBeenCalled();
    });

    it('records overage when the persisted plan carries a nonzero API rate', async () => {
      // Persisted plan versions retain their own immutable API overage rate.
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue({
        ...FREE_VERSION,
        apiOverageRateMicros: 1_000n, // legacy $0.001 per call
      });
      usageEventFindMany.mockResolvedValue([{ quantity: 10_000n }]); // at limit

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-legacy-rate',
        endpoint: '/v1/wallets/sign',
      });
      expect(usageEventCreate).toHaveBeenCalled();
    });

    it('compares huge used counts exactly in bigint without Number conversion', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // safe limit 10_000
      // used = 2^60 remains safe because the meter no longer reads quota rows.
      usageEventFindMany.mockResolvedValue([{ quantity: 2n ** 60n }]);

      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-huge',
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

    it('does not inspect prior usage quantities', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      await service.assertAndRecordApiCall({
        userId: 'user-1',
        sourceKey: 'api:req-neg',
        endpoint: '/v1/wallets/sign',
      });
      expect(usageEventFindMany).not.toHaveBeenCalled();
      expect(usageEventCreate).toHaveBeenCalled();
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

      await service.recordUnverifiedOutbound({
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
        service.recordUnverifiedOutbound({
          userId: 'user-1',
          sourceKey: 'out:neg',
          amountUsdMicros: -1n,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usageEventCreate).not.toHaveBeenCalled();
    });

    it('rejects non-bigint amounts', async () => {
      await expect(
        service.recordUnverifiedOutbound({
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

      const result = await service.recordUnverifiedOutbound({
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
        service.recordUnverifiedOutbound({
          userId: 'user-1',
          sourceKey: 'out:dup',
          amountUsdMicros: 100n,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('marks legacy caller-supplied rows as unverified + legacy_import', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      await service.recordUnverifiedOutbound({
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
    const completeFence = {
      reconciliationRunId: 'run-1',
      reconciliationRunType: 'receipt_outbound',
      reconciliationOwnerId: 'worker-1',
      reconciliationAccountId: ACCOUNT.id,
      reconciliationPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
      reconciliationPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      reconciliationExpectedTransactionStatus: 'pending',
      transactionId: 'tx-1',
      reconciliationExpectedTxHash: TX.txHash,
      reconciliationExpectedChainId: TX.chainId,
      reconciliationExpectedWalletAddress: TX.walletAddress,
      reconciliationTransactionStatus: 'confirmed' as const,
    };
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
        ...completeFence,
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

    it('uses the explicit target period when receipt mining occurs in the following month', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-cross-month' });

      await service.recordSuccessfulOutbound({
        ...completeFence,
        userId: 'user-1',
        sourceKey: 'tx:tx-1:cross-month:0',
        status: 'posted',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        occurredAt: new Date('2026-09-02T00:00:00.000Z'),
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: TX.walletAddress,
        assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        receipt: { ...receipt, receiptBlockTimestamp: 1_788_307_200n },
        metadata: { policyVersion: 1 },
      });

      expect(usageEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: ACCOUNT.id,
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            occurredAt: new Date('2026-09-02T00:00:00.000Z'),
          }),
        }),
      );
    });

    it('appends a quarantined outbound event with volume 0 and reason metadata', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue(TX);
      usageEventCreate.mockResolvedValue({ id: 'evt-1' });

      const result = await service.recordSuccessfulOutbound({
        ...completeFence,
        userId: 'user-1',
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
          ...completeFence,
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
          ...completeFence,
          userId: 'user-1',
          sourceKey: 'tx:tx-1:log:0',
          transactionId: undefined,
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

    it('rejects receipt-backed outbound with a non-posted/quarantined status', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      await expect(
        service.recordSuccessfulOutbound({
          ...completeFence,
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
        ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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

    it('rejects a txHash mismatch between the transaction and the receipt', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      transactionFindUnique.mockResolvedValue({
        ...TX,
        txHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      });

      await expect(
        service.recordSuccessfulOutbound({
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
        ...completeFence,
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
        reconciliationRunType: 'receipt_outbound',
        reconciliationOwnerId: 'worker-1',
        reconciliationAccountId: ACCOUNT.id,
        reconciliationPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
        reconciliationPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
        reconciliationExpectedTransactionStatus: 'pending',
        reconciliationExpectedTxHash: TX.txHash,
        reconciliationExpectedChainId: TX.chainId,
        reconciliationExpectedWalletAddress: TX.walletAddress,
        reconciliationTransactionStatus: 'confirmed',
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
        ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
        ...completeFence,
        userId: 'user-1',
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
        ...completeFence,
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
        reconciliationRunType: 'receipt_outbound',
        reconciliationOwnerId: 'worker-1',
        reconciliationAccountId: ACCOUNT.id,
        reconciliationPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
        reconciliationPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
        reconciliationExpectedTransactionStatus: 'pending',
        reconciliationExpectedTxHash: TX.txHash,
        reconciliationExpectedChainId: TX.chainId,
        reconciliationExpectedWalletAddress: TX.walletAddress,
        reconciliationTransactionStatus: 'confirmed',
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
          ...completeFence,
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

      const result = await service.recordUnverifiedOutbound({
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
        ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
          userId: 'user-1',
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
        ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
          ...completeFence,
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
    it('projects legacy finalized summary from persisted charges and labels its count instantaneous', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({ planVersion: FREE_VERSION });
      invoiceFindUnique.mockResolvedValue({
        status: 'finalized', currency: 'USD', snapshotJson: {
          plan: { code: 'starter', name: 'Starter' }, usage: { activeWallets: 4 },
          tiers: [{ upperBoundMicros: '12', ratePpm: 37, volumeMicros: '7', feeMicros: '0.000259' }],
        },
        grossOutboundMicros: 12_000_000n, includedOutboundMicros: 5_000_000n, outboundOverageMicros: 2_000_000n,
        apiCalls: 17n, includedApiCalls: 10n, includedWallets: 2, activeWallets: 4,
        monthlyFeeMicros: 49_000_000n, apiOverageMicros: 3_000_000n, walletOverageMicros: 1_000_000n,
        totalMicros: 55_000_000n,
      });
      const result = await service.getSummary('user-1', '2026-05');
      expect(result).toMatchObject({
        planId: 'starter', planName: 'Starter', outboundVolume: '12', outboundFreeAllowance: '5',
        outboundOverage: '2', apiCalls: '17', activeWallets: '4',
        walletUsageMetric: 'legacy_instantaneous', estimatedBaseCost: '49',
        estimatedOverageCost: '6', estimatedTotal: '55',
        overageRate: '0.0037%', tierBreakdown: [{ tier: 'Tier 1', from: '0', to: '12', quantity: '7', rate: '0.0037%', cost: '0.000259' }],
      });
      expect(prepareWalletUsage).not.toHaveBeenCalled();
      expect(walletUsageFindUnique).not.toHaveBeenCalled();
    });

    it('conflicts on finalized historical invoices without wallet snapshot evidence', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue({ status: 'finalized', snapshotJson: { plan: { code: 'free', name: 'Free' }, usage: {}, tiers: [] } });
      await expect(service.getSummary('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(prepareWalletUsage).not.toHaveBeenCalled();
    });

    it('allows an explicitly empty historical tier array without substituting current tier rates', () => {
      const invoice = {
        snapshotJson: { plan: { code: 'free', name: 'Free' }, tiers: [] },
        includedOutboundMicros: 0n, includedApiCalls: 0n, includedWallets: 0, activeWallets: 0,
        grossOutboundMicros: 0n, outboundOverageMicros: 0n, apiCalls: 0n, monthlyFeeMicros: 0n,
        apiOverageMicros: 0n, walletOverageMicros: 0n, totalMicros: 0n, currency: 'USD',
      };
      const summary = service['projectFinalizedSummary'](invoice as never, '2026-05');
      expect(summary.overageRate).toBe('0');
      expect(summary.tierBreakdown).toEqual([]);
    });

    it('fails closed when a historical snapshot has no tier evidence', () => {
      const invoice = {
        snapshotJson: { plan: { code: 'free', name: 'Free' } },
        includedOutboundMicros: 0n, includedApiCalls: 0n, includedWallets: 0, activeWallets: 0,
        grossOutboundMicros: 0n, outboundOverageMicros: 0n, apiCalls: 0n, monthlyFeeMicros: 0n,
        apiOverageMicros: 0n, walletOverageMicros: 0n, totalMicros: 0n, currency: 'USD',
      };
      expect(() => service['projectFinalizedSummary'](invoice as never, '2026-05')).toThrow(ConflictException);
    });

    it('fails closed when the requested month has no wallet peak evidence', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      walletUsageFindUnique.mockResolvedValue(null);
      await expect(service.getSummary('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(walletCount).not.toHaveBeenCalled();
    });

    it('accepts an explicit zero peak baseline as known zero usage', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({ planVersion: FREE_VERSION });
      walletUsageFindUnique.mockResolvedValue({ peakWalletCount: 0 });
      usageEventFindMany.mockResolvedValue([]);
      const result = await service.getSummary('user-1', '2026-05');
      expect(result.activeWallets).toBe('0');
    });

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
        { metric: 'api_call', quantity: 5n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(3);
      walletUsageFindUnique.mockResolvedValue({ peakWalletCount: 3 });

      const result = await service.getSummary('user-1', '2026-05');

      expect(walletCount).not.toHaveBeenCalled();

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

    it('counts only posted usage-type outbound and keeps posted api_call counting intact', async () => {
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
        { metric: 'api_call', quantity: 3n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      // only the posted usage row counts; reversal and unverified are excluded
      expect(result.outboundVolume).toBe('100');
      // only the posted api_call row counts toward reported API usage
      expect(result.apiCalls).toBe('3');
    });

    it('excludes unverified/quarantined/reversed api_call rows from the summary', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([
        // Legacy recordApiCall seam rows are explicitly unverified and must
        // never be reported as API usage.
        { metric: 'api_call', quantity: 900_000n, status: 'unverified', entryType: 'usage' },
        { metric: 'api_call', quantity: 7n, status: 'quarantined', entryType: 'usage' },
        { metric: 'api_call', quantity: 2n, status: 'reversed', entryType: 'usage' },
        { metric: 'api_call', quantity: 4n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      // Only the explicitly posted usage-type api_call row counts.
      expect(result.apiCalls).toBe('4');
      expect(result.outboundVolume).toBe('0');
      expect(result.outboundOverage).toBe('0');
    });

    it('includes API overage in the estimate using the persisted plan rate', async () => {
      // planVersionFindFirst serves both the catalog probe and the Free-plan
      // fallback; the assigned legacy Starter version carries the old
      // $0.001/call rate.
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-starter-legacy',
        planVersion: {
          ...STARTER_VERSION,
          id: 'plan-starter-legacy',
          apiOverageRateMicros: 1_000n, // legacy $0.001 per call
        },
      });
      usageEventFindMany.mockResolvedValue([
        { metric: 'api_call', quantity: 900_000n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      // The over-limit API usage is still reported...
      expect(result.apiCalls).toBe('900000');
      expect(result.apiCallsFreeAllowance).toBe('100000');
      // 800,000 calls over the Starter allowance at $0.001/call.
      expect(result.estimatedBaseCost).toBe('49');
      expect(result.estimatedOverageCost).toBe('800');
      expect(result.estimatedTotal).toBe('849');
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

    it('current-month summary uses paid entitlement allowances while pricing stays Free-anchored', async () => {
      // Fake clock is 2026-08-25 → current UTC month 2026-08. After a mid-month
      // paid upgrade the usage_period invoice still anchors fixed fee identity to
      // Free, but allowances + overage rates follow live Starter entitlement
      // (BILL-009).
      const periodStart = new Date('2026-08-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });
      // Existing Free usage_period invoice for the current month (pricing anchor).
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-usage-aug',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: FREE_VERSION.id,
        status: 'open',
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === STARTER_VERSION.id) return STARTER_VERSION;
        if (where?.id === FREE_VERSION.id) return FREE_VERSION;
        return null;
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-08');

      // Fee identity + base cost remain Free-anchored (no full Starter fee).
      expect(result.period).toBe('2026-08');
      expect(result.planId).toBe('free');
      expect(result.planName).toBe('Free');
      expect(result.estimatedBaseCost).toBe('0');
      expect(result.estimatedOverageCost).toBe('0');
      expect(result.estimatedTotal).toBe('0');
      // Allowances follow the current valid paid entitlement.
      expect(result.outboundFreeAllowance).toBe('250000');
      expect(result.apiCallsFreeAllowance).toBe('100000');
      expect(result.activeWalletsFreeAllowance).toBe('100');
    });

    it('historical-period summary keeps allowances on the period pricing plan', async () => {
      // May 2026 is not the current UTC month (clock = 2026-08). Even with a
      // current paid entitlement starting in August, May's period entitlement is
      // still Free — hybrid must not bleed live Starter into historical months.
      const historicalStart = new Date('2026-05-01T00:00:00.000Z');
      const freeAssignment = {
        id: 'assign-free-may',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        periodStart: historicalStart,
        expiresAt: null,
        source: 'default',
        planVersion: FREE_VERSION,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      // Entitlement resolver walks findMany with periodStart lte query target.
      assignmentFindMany.mockImplementation(async (args: any) => {
        const lte = args?.where?.periodStart?.lte as Date | undefined;
        if (lte && lte.getTime() < new Date('2026-08-01T00:00:00.000Z').getTime()) {
          return [freeAssignment];
        }
        return [
          {
            id: 'assign-starter',
            billingAccountId: ACCOUNT.id,
            planVersionId: STARTER_VERSION.id,
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            source: 'upgrade_payment',
            planVersion: STARTER_VERSION,
          },
        ];
      });
      assignmentFindFirst.mockResolvedValue(freeAssignment);
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-usage-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart: historicalStart,
        planVersionId: FREE_VERSION.id,
        status: 'finalized',
        snapshotJson: { plan: { code: 'free', name: 'Free' }, usage: { activeWallets: 0 }, tiers: [] },
        currency: 'USD', grossOutboundMicros: 0n, includedOutboundMicros: FREE_VERSION.includedOutboundMicros,
        outboundOverageMicros: 0n, apiCalls: 0n, includedApiCalls: FREE_VERSION.includedApiCalls,
        includedWallets: FREE_VERSION.includedWallets, activeWallets: 0, monthlyFeeMicros: 0n,
        apiOverageMicros: 0n, walletOverageMicros: 0n, totalMicros: 0n,
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === FREE_VERSION.id) return FREE_VERSION;
        if (where?.id === STARTER_VERSION.id) return STARTER_VERSION;
        return null;
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-05');

      expect(result.period).toBe('2026-05');
      expect(result.planId).toBe('free');
      expect(result.planName).toBe('Free');
      expect(result.estimatedBaseCost).toBe('0');
      // Historical allowances stay on the Free period plan, not live Starter.
      expect(result.outboundFreeAllowance).toBe('50000');
      expect(result.apiCallsFreeAllowance).toBe('10000');
      expect(result.activeWalletsFreeAllowance).toBe('10');
    });

    // ── BILL-009 hybrid usage pricing (current-month mid-month upgrade) ─────

    it('BILL-009: current-month Free→Starter uses target allowances/rates; fixed fee stays Free', async () => {
      // Mid-month paid upgrade: Free fee anchor + Starter entitlement.
      // Usage exceeds Free allowance but stays under Starter → outbound overage 0
      // with Starter included; Free-only pricing would have charged overage.
      const periodStart = new Date('2026-08-01T00:00:00.000Z');
      const starterWithRates = {
        ...STARTER_VERSION,
        apiOverageRateMicros: 1_500n,
        walletOverageRateMicros: 10_000n,
      };
      const freeWithRates = {
        ...FREE_VERSION,
        apiOverageRateMicros: 2_000n,
        walletOverageRateMicros: 10_000n,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(freeWithRates);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: starterWithRates.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: starterWithRates,
      });
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-usage-aug',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: freeWithRates.id,
        status: 'open',
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === starterWithRates.id) return starterWithRates;
        if (where?.id === freeWithRates.id) return freeWithRates;
        return null;
      });
      // $100K outbound: under Starter $250K included, over Free $50K included.
      // 50_000 API calls: under Starter 100K, over Free 10K.
      // 50 wallets: under Starter 100, over Free 10.
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 100_000_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
        { metric: 'api_call', quantity: 50_000n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(50);

      const result = await service.getSummary('user-1', '2026-08');

      expect(result.planId).toBe('free');
      expect(result.planName).toBe('Free');
      expect(result.estimatedBaseCost).toBe('0'); // never full Starter $49
      expect(result.outboundFreeAllowance).toBe('250000');
      expect(result.apiCallsFreeAllowance).toBe('100000');
      expect(result.activeWalletsFreeAllowance).toBe('100');
      // Target allowances absorb all usage → no overage; Free would have charged.
      expect(result.outboundOverage).toBe('0');
      expect(result.estimatedOverageCost).toBe('0');
      expect(result.estimatedTotal).toBe('0');
    });

    it('BILL-009: current-month Free→Growth overage rates use Growth not Free', async () => {
      const periodStart = new Date('2026-08-01T00:00:00.000Z');
      const GROWTH_VERSION = {
        ...STARTER_VERSION,
        id: 'plan-growth-1',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 199_000_000n,
        includedOutboundMicros: 1_000_000_000_000n, // $1M
        includedApiCalls: 1_000_000n,
        includedWallets: 1_000,
        apiOverageRateMicros: 1_000n, // $0.001 / call
        walletOverageRateMicros: 10_000n,
      };
      const freeWithRates = {
        ...FREE_VERSION,
        apiOverageRateMicros: 2_000n,
        walletOverageRateMicros: 10_000n,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(freeWithRates);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-growth',
        billingAccountId: ACCOUNT.id,
        planVersionId: GROWTH_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: GROWTH_VERSION,
      });
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-usage-aug',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: freeWithRates.id,
        status: 'open',
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === GROWTH_VERSION.id) return GROWTH_VERSION;
        if (where?.id === freeWithRates.id) return freeWithRates;
        return null;
      });
      // 1_100_000 API calls vs Growth 1_000_000 included → 100_000 * $0.001 = $100
      // Free rate would be 1_090_000 * $0.002 (Free included 10K).
      usageEventFindMany.mockResolvedValue([
        { metric: 'api_call', quantity: 1_100_000n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      const result = await service.getSummary('user-1', '2026-08');

      expect(result.planId).toBe('free');
      expect(result.estimatedBaseCost).toBe('0');
      expect(result.apiCallsFreeAllowance).toBe('1000000');
      expect(result.estimatedOverageCost).toBe('100');
      expect(result.estimatedTotal).toBe('100');
    });

    it('BILL-009: same-plan period is unchanged (no hybrid split)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
        expiresAt: null,
        source: 'default',
      });
      invoiceFindFirst.mockResolvedValue(null);
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

      const result = await service.getSummary('user-1', '2026-05');

      expect(result.planId).toBe('free');
      expect(result.outboundFreeAllowance).toBe('50000');
      expect(result.outboundOverage).toBe('53.75');
      expect(result.estimatedBaseCost).toBe('0');
      expect(result.estimatedTotal).toBe('53.75');
    });

    it('BILL-009: incomplete upgrade_payment assignment fails closed on summary', async () => {
      const periodStart = new Date('2026-08-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      // No usage invoice → resolveUsagePlanVersion inspects period assignment.
      invoiceFindFirst.mockResolvedValue(null);
      assignmentFindUnique.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });
      // Applied upgrade row missing / no fromPlanVersion.
      planChangeFindFirst.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });

      await expect(service.getSummary('user-1', '2026-08')).rejects.toThrow(ConflictException);
    });

    it('BILL-009: missing fee-anchor plan version fails closed on summary', async () => {
      const periodStart = new Date('2026-08-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-usage-aug',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: 'missing-plan-version',
        status: 'open',
      });
      planVersionFindUnique.mockResolvedValue(null);

      await expect(service.getSummary('user-1', '2026-08')).rejects.toThrow(ConflictException);
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
          planVersionId: 'plan-version-1',
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
        planVersionId: 'plan-version-1',
      });
    });

    it('keeps planVersionId null for legacy rows without one', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindMany.mockResolvedValue([
        {
          id: 'inv-legacy',
          billingAccountId: ACCOUNT.id,
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          status: 'finalized',
          currency: 'USD',
          totalMicros: 0n,
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ]);
      invoiceCount.mockResolvedValue(1);

      const result = await service.listInvoices('user-1', { page: 1, limit: 20 });

      expect(result.items[0].planVersionId).toBeNull();
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

  describe('getInvoicePaymentStatus (BILL-018)', () => {
    const finalizedInvoice = {
      id: 'inv-1',
      billingAccountId: ACCOUNT.id,
      periodStart: new Date('2026-05-01T00:00:00.000Z'),
      status: 'finalized',
      currency: 'USD',
      totalMicros: 252_710_000n,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      paidAt: null,
      planVersionId: 'plan-scale-1',
    };

    function attemptRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'att-review-1',
        invoiceId: 'inv-1',
        method: 'usdc',
        status: 'needs_review',
        reviewReason: 'duplicate_unallocated',
        createdAt: new Date('2026-06-01T01:00:00.000Z'),
        walletPaymentReserved: false,
        chainId: 84532n,
        quoteExpiresAt: new Date('2026-06-02T01:00:00.000Z'),
        // Sensitive fields that must never leak into the DTO:
        txHash: '0x' + 'aa'.repeat(32),
        submittedTxHash: '0x' + 'bb'.repeat(32),
        blockHash: '0x' + 'cc'.repeat(32),
        providerIdentity: 'deadbeef',
        receiptEvidence: { logs: ['secret'] },
        stripeCheckoutSessionId: 'cs_secret',
        checkoutUrl: 'https://checkout.stripe.com/secret',
        ...overrides,
      };
    }

    it('throws NotFound when the user has no account (cross-user safe)', async () => {
      accountFindUnique.mockResolvedValue(null);

      await expect(service.getInvoicePaymentStatus('user-1', 'inv-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(attemptFindMany).not.toHaveBeenCalled();
    });

    it('throws NotFound when the invoice is not owned (cross-user reject)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(null);

      await expect(service.getInvoicePaymentStatus('user-1', 'inv-other')).rejects.toThrow(
        NotFoundException,
      );
      expect(attemptFindMany).not.toHaveBeenCalled();
    });

    it('surfaces manual needs_review after refresh (not only latest pending)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      const review = attemptRow({
        id: 'att-review-old',
        status: 'needs_review',
        reviewReason: 'duplicate_unallocated',
        createdAt: new Date('2026-06-01T01:00:00.000Z'),
      });
      const pending = attemptRow({
        id: 'att-pending-new',
        status: 'pending',
        reviewReason: null,
        createdAt: new Date('2026-06-01T03:00:00.000Z'),
        txHash: null,
        submittedTxHash: null,
      });
      attemptFindMany.mockResolvedValue([review, pending]);

      const result = await service.getInvoicePaymentStatus('user-1', 'inv-1');

      expect(result.invoiceId).toBe('inv-1');
      expect(result.paid).toBe(false);
      expect(result.hasUnresolvedReview).toBe(true);
      expect(result.blockingReasons).toEqual(['duplicate_unallocated']);
      expect(result.activeAttempt?.paymentAttemptId).toBe('att-pending-new');
      expect(result.activeAttempt?.status).toBe('pending');
      // Older needs_review must remain visible alongside the newer pending quote.
      expect(result.unresolvedReviewAttempts).toHaveLength(1);
      expect(result.unresolvedReviewAttempts[0]).toMatchObject({
        paymentAttemptId: 'att-review-old',
        status: 'needs_review',
        reviewReason: 'duplicate_unallocated',
        method: 'usdc',
      });
    });

    it('returns multiple unresolved reviews on the same invoice (oldest first)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      attemptFindMany.mockResolvedValue([
        attemptRow({
          id: 'att-r1',
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
          createdAt: new Date('2026-06-01T01:00:00.000Z'),
        }),
        attemptRow({
          id: 'att-r2',
          status: 'needs_review',
          reviewReason: 'amount_mismatch',
          createdAt: new Date('2026-06-01T02:00:00.000Z'),
        }),
        attemptRow({
          id: 'att-pending',
          status: 'pending',
          reviewReason: null,
          createdAt: new Date('2026-06-01T04:00:00.000Z'),
        }),
      ]);

      const result = await service.getInvoicePaymentStatus('user-1', 'inv-1');

      expect(result.unresolvedReviewAttempts.map((a) => a.paymentAttemptId)).toEqual([
        'att-r1',
        'att-r2',
      ]);
      expect(result.blockingReasons).toEqual(['duplicate_unallocated', 'amount_mismatch']);
      expect(result.activeAttempt?.paymentAttemptId).toBe('att-pending');
    });

    it('returns wallet reservation alongside needs_review', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      const reservedReview = attemptRow({
        id: 'att-wallet',
        status: 'needs_review',
        reviewReason: 'wallet_payment_awaiting_evidence',
        walletPaymentReserved: true,
      });
      attemptFindMany.mockResolvedValue([reservedReview]);

      const result = await service.getInvoicePaymentStatus('user-1', 'inv-1');

      expect(result.walletReservation).toMatchObject({
        paymentAttemptId: 'att-wallet',
        walletPaymentReserved: true,
        status: 'needs_review',
        reviewReason: 'wallet_payment_awaiting_evidence',
      });
      expect(result.hasUnresolvedReview).toBe(true);
      expect(result.activeAttempt).toBeNull();
    });

    it('surfaces review on a paid invoice (duplicate_unallocated after another rail won)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue({
        ...finalizedInvoice,
        paidAt: new Date('2026-06-01T05:00:00.000Z'),
        status: 'finalized',
      });
      attemptFindMany.mockResolvedValue([
        attemptRow({
          id: 'att-dup',
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
          method: 'usdc',
        }),
      ]);

      const result = await service.getInvoicePaymentStatus('user-1', 'inv-1');

      expect(result.paid).toBe(true);
      expect(result.paidAt).toBe('2026-06-01T05:00:00.000Z');
      expect(result.hasUnresolvedReview).toBe(true);
      expect(result.unresolvedReviewAttempts[0].reviewReason).toBe('duplicate_unallocated');
      expect(result.activeAttempt).toBeNull();
    });

    it('GET is read-only: never creates attempts or mutates rows', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      attemptFindMany.mockResolvedValue([]);

      await service.getInvoicePaymentStatus('user-1', 'inv-1');

      expect(attemptFindMany).toHaveBeenCalledTimes(1);
      expect(attemptFindMany).toHaveBeenCalledWith({
        where: {
          invoiceId: 'inv-1',
          OR: [
            { status: { in: ['pending', 'confirming', 'needs_review', 'reorged'] } },
            { walletPaymentReserved: true },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      // No write paths used by this handler.
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(prepareWalletUsage).not.toHaveBeenCalled();
    });

    it('omits sensitive hashes, receipts, provider and Stripe details from the DTO', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      attemptFindMany.mockResolvedValue([attemptRow()]);

      const result = await service.getInvoicePaymentStatus('user-1', 'inv-1');
      const payload = JSON.stringify(result);

      expect(payload).not.toMatch(/0x[a-f0-9]{64}/i);
      expect(payload).not.toMatch(/calldata|receiptEvidence|providerIdentity|openfort|cs_secret/i);
      expect(payload).not.toContain('checkout.stripe.com');
      expect(result.unresolvedReviewAttempts[0]).toEqual({
        paymentAttemptId: 'att-review-1',
        method: 'usdc',
        status: 'needs_review',
        reviewReason: 'duplicate_unallocated',
        createdAt: '2026-06-01T01:00:00.000Z',
        walletPaymentReserved: false,
        chainId: 84532,
        quoteExpiresAt: '2026-06-02T01:00:00.000Z',
      });
      expect(result.unresolvedReviewAttempts[0]).not.toHaveProperty('txHash');
      expect(result.unresolvedReviewAttempts[0]).not.toHaveProperty('submittedTxHash');
      expect(result.unresolvedReviewAttempts[0]).not.toHaveProperty('blockHash');
      expect(result.unresolvedReviewAttempts[0]).not.toHaveProperty('receiptEvidence');
      expect(result.unresolvedReviewAttempts[0]).not.toHaveProperty('checkoutUrl');
    });

    it('returns empty recovery state when no relevant attempts exist', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      attemptFindMany.mockResolvedValue([]);

      const result = await service.getInvoicePaymentStatus('user-1', 'inv-1');

      expect(result).toEqual({
        invoiceId: 'inv-1',
        invoiceStatus: 'finalized',
        paid: false,
        paidAt: null,
        activeAttempt: null,
        walletReservation: null,
        unresolvedReviewAttempts: [],
        hasUnresolvedReview: false,
        blockingReasons: [],
      });
    });
  });

  describe('ensureOpenInvoiceForPeriod', () => {
    it('creates the next due period through the locked upsert path and is idempotent', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      jest.spyOn(service as any, 'ensurePlanVersions').mockResolvedValue(undefined);
      assignmentFindFirst.mockResolvedValue({ planVersion: FREE_VERSION });

      const created = {
        id: 'inv-next',
        status: 'open',
        totalMicros: 0n,
        currency: 'USD',
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-01T00:00:00.000Z'),
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        paidAt: null,
      };
      // Per ensureOpenInvoiceForPeriod call path:
      // 1) existing check 2) resolveUsagePlanVersion 3) upsertOpen existing
      // 4) re-read after create. Second call only hits existing check.
      invoiceFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(created)
        .mockResolvedValue(created);
      invoiceCreate.mockResolvedValue(created);
      lineCreateMany.mockResolvedValue({ count: 1 });
      assignmentFindFirst.mockResolvedValue({
        planVersion: FREE_VERSION,
        expiresAt: null,
        source: 'default',
      });

      await expect(service.ensureOpenInvoiceForPeriod('user-1', '2026-05')).resolves.toMatchObject({
        id: 'inv-next',
        status: 'open',
      });
      await expect(service.ensureOpenInvoiceForPeriod('user-1', '2026-05')).resolves.toMatchObject({
        id: 'inv-next',
        status: 'open',
      });

      expect(executeRaw).toHaveBeenCalled();
      expect(invoiceCreate).toHaveBeenCalledTimes(1);
      expect(lineCreateMany).toHaveBeenCalledTimes(1);
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
      walletUsageFindUnique.mockResolvedValue({ peakWalletCount: 7 });

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
            snapshotJson: expect.objectContaining({
              planVersionId: FREE_VERSION.id,
              pricingMode: 'single_plan',
              feePlanVersionId: FREE_VERSION.id,
               usagePlanVersionId: FREE_VERSION.id,
               walletUsageMetric: 'monthly_peak',
               walletOveragePolicy: 'zero_hard_cap',
               usage: expect.objectContaining({ activeWallets: 7 }),
               plan: expect.objectContaining({
                code: FREE_VERSION.code,
                name: FREE_VERSION.name,
                version: FREE_VERSION.version,
              }),
            }),
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

    it('finalizes API overage using the persisted plan rate', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      invoiceFindUnique.mockResolvedValue(null);
      // Assigned legacy Starter version still carries the old $0.001/call rate.
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-starter-legacy',
        planVersion: {
          ...STARTER_VERSION,
          id: 'plan-starter-legacy',
          apiOverageRateMicros: 1_000n, // legacy $0.001 per call
        },
      });
      usageEventFindFirst.mockResolvedValue(null); // no quarantined usage
      usageEventFindMany
        .mockResolvedValueOnce([]) // no reconciliation-linked usage rows
        .mockResolvedValueOnce([
          // 1,000,000 API calls recorded against a 100,000-call allowance.
          { metric: 'api_call', quantity: 1_000_000n, status: 'posted', entryType: 'usage' },
        ]);
      reconciliationRunFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-api-0',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 949_000_000n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      // 900,000 over-limit calls * $0.001 = $900, plus the $49 monthly fee.
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            apiOverageMicros: 900_000_000n,
            totalMicros: 949_000_000n,
          }),
        }),
      );
      // The overage is represented as a dedicated invoice line.
      const lineData = lineCreateMany.mock.calls[0][0] as {
        data: Array<{ lineType: string }>;
      };
      expect(lineData.data.map((line) => line.lineType)).toContain('api_overage');
      expect(lineData.data.map((line) => line.lineType)).toContain('monthly_fee');
      expect(result.status).toBe('finalized');
    });

    it('excludes unverified/quarantined api_call rows from the finalized invoice', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindFirst.mockResolvedValue(null); // no quarantined usage
      usageEventFindMany
        .mockResolvedValueOnce([]) // no reconciliation-linked usage rows
        .mockResolvedValueOnce([
          // Only posted usage-type api_call rows may reach the invoice: the
          // legacy recordApiCall seam rows (unverified) and quarantined rows
          // are excluded entirely.
          { metric: 'api_call', quantity: 1_000_000n, status: 'unverified', entryType: 'usage' },
          { metric: 'api_call', quantity: 50n, status: 'quarantined', entryType: 'usage' },
          { metric: 'api_call', quantity: 12n, status: 'posted', entryType: 'usage' },
        ]);
      reconciliationRunFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-api-posted-only',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      // Only the 12 posted calls are frozen into the invoice; the 1,000,050
      // unverified/quarantined calls never surface as API usage.
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            apiCalls: 12n,
            apiOverageMicros: 0n,
            totalMicros: 0n,
          }),
        }),
      );
      expect(result.status).toBe('finalized');
    });

    it('allocates a succeeded fixed-fee renewal as partial coverage at finalization (never a fake paid)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 109_000_000n, // dynamic: fixed fee + overage
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      // A fixed-fee renewal attempt succeeded while the invoice was still
      // open; after finalization the shared boundary gets one catch-up.
      attemptFindMany.mockResolvedValue([
        {
          id: 'att-fixed',
          invoiceId: 'inv-1',
          method: 'stripe',
          status: 'succeeded',
          stripeChargeKind: 'fixed_fee',
          amountMicros: 49_000_000n,
          currency: 'USD',
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ]);
      settleInvoice.mockResolvedValue({
        allocated: true,
        paid: false,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: 49_000_000n,
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.status).toBe('finalized');
      // The post-commit catch-up allocates the fixed fee as partial coverage.
      expect(settleInvoice).toHaveBeenCalledWith(expect.anything(), {
        id: 'att-fixed',
        invoiceId: 'inv-1',
        method: 'stripe',
      });
      // The legitimate partial allocation is NOT demoted to
      // fixed_fee_partial_balance / needs_review: the overage worker collects
      // the remainder instead. (No updateMany exists on the tx mock, so a
      // marking attempt would throw and fail this test.)
    });

    it('recoverRenewalAllocation retries a failed post-commit fixed-fee allocation (bounded catch-up)', async () => {
      // A finalized invoice whose post-commit allocation never ran: the worker
      // re-invokes the catch-up and the shared boundary allocates the coverage.
      attemptFindMany.mockResolvedValue([
        {
          id: 'att-fixed',
          invoiceId: 'inv-1',
          method: 'stripe',
          status: 'succeeded',
          stripeChargeKind: 'fixed_fee',
          amountMicros: 49_000_000n,
          currency: 'USD',
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ]);
      settleInvoice.mockResolvedValue({
        allocated: true,
        paid: false,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: 49_000_000n,
      });

      await service.recoverRenewalAllocation('inv-1');

      expect(settleInvoice).toHaveBeenCalledWith(expect.anything(), {
        id: 'att-fixed',
        invoiceId: 'inv-1',
        method: 'stripe',
      });
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
        snapshotJson: { walletUsageMetric: 'legacy_instantaneous', usage: { activeWallets: 3 } },
        snapshotHash: 'immutable-existing-hash',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(prepareWalletUsage).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(result.id).toBe('inv-1');
    });

    it('returns the same invoice on a concurrent unique-conflict race', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION); // catalog already initialized
      const winner = {
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized' as const,
        currency: 'USD',
        totalMicros: 55_000_000n,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        purpose: 'usage_period',
        planVersionId: FREE_VERSION.id,
      };
      // cheap pre-check + lock re-check: none; after P2002 winner lookup: winner
      // (invoiceFindFirst is also used by resolveUsagePlanVersion → null)
      invoiceFindFirst
        .mockResolvedValueOnce(null) // finalize pre-check
        .mockResolvedValueOnce(null) // lock re-check
        .mockResolvedValueOnce(null) // resolveUsagePlanVersion
        .mockResolvedValueOnce(winner); // after P2002
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
        expiresAt: null,
        source: 'default',
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

    it('blocks finalize when unresolved outbound transactions exist without a proven exhaustive run (no-run barrier)', async () => {
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
      // A pending (or confirmed-but-unreconciled) outbound transaction exists.
      transactionCount
        .mockResolvedValueOnce(1) // pending count
        .mockResolvedValue(0); // confirmed count

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(transactionCount).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { billingPeriodStart: new Date('2026-05-01T00:00:00.000Z') },
              { billingPeriodStart: null },
            ],
          }),
        }),
      );
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('finalizes when the no-run barrier finds no unresolved transactions', async () => {
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
      transactionCount.mockResolvedValue(0);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue({
        id: 'inv-final',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.status).toBe('finalized');
    });

    it('blocks finalize when a confirmed transaction has a NULL txHash (never silently finalized)', async () => {
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
      // The confirmed-count query (which must NOT filter txHash) returns 1 for
      // a status=confirmed / txHash IS NULL row.
      transactionCount.mockResolvedValueOnce(0).mockResolvedValue(1);

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
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            billingAccountId: ACCOUNT.id,
            runId: 'run-1',
            runType: 'receipt_outbound',
            periodStart: '2026-05-01T00:00:00.000Z',
            periodEnd: '2026-06-01T00:00:00.000Z',
            complete: true,
            scanned: 1,
            reverted: 0,
            posted: 1,
            quarantined: 0,
            updated: 1,
            replayed: 0,
            casNoops: 0,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            noHash: 0,
            remainingUnresolved: 0,
            retryable: 0,
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
      // candidate runs are fetched newest-first and scoped to this account and
      // overlapping target period; unprovable legacy rows remain conservative.
      expect(reconciliationRunFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                billingAccountId: 'acc-1',
                periodStart: { lte: new Date('2026-06-01T00:00:00.000Z') },
                periodEnd: { gte: new Date('2026-05-01T00:00:00.000Z') },
              },
            ]),
          }),
          orderBy: { startedAt: 'desc' },
          select: expect.objectContaining({
            id: true,
            status: true,
            completedAt: true,
            summary: true,
          }),
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
      invoiceFindFirst.mockResolvedValue(null);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: 'plan-unknown-1',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'renewal',
        planVersion: {
          ...FREE_VERSION,
          id: 'plan-unknown-1',
          code: 'not-a-real-plan',
          monthlyFeeMicros: 1n,
        },
      });
      planVersionFindUnique.mockResolvedValue({
        ...FREE_VERSION,
        id: 'plan-unknown-1',
        code: 'not-a-real-plan',
        monthlyFeeMicros: 1n,
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

    it('blocks finalize for a matching-account run with a contradictory user scope', async () => {
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
      // The run belongs to the account but its accountUserId/summary point at
      // another user. Discovery must still surface it so the TypeScript
      // relevance/risk fence retains it (never SQL-filtered into fail-open).
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-other-user',
          status: 'completed',
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-other',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          summary: {
            userId: 'user-other',
            complete: true,
            notFound: 1,
            accountingPeriods: ['2026-05-01T00:00:00.000Z'],
          },
        },
      ]);
      // Discovery must include the account-scoped overlap branch WITHOUT an
      // accountUserId predicate so contradictory scopes reach the fence.

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(reconciliationRunFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                billingAccountId: 'acc-1',
                periodStart: { lte: new Date('2026-06-01T00:00:00.000Z') },
                periodEnd: { gte: new Date('2026-05-01T00:00:00.000Z') },
              },
            ]),
          }),
        }),
      );
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

    it('blocks finalize when an older relevant run still has unresolved risk', async () => {
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
      // newest first: run-2 is clean, but the older relevant run-1 still has
      // unresolved risk and must keep finalization fail-closed.
      reconciliationRunFindMany.mockResolvedValue([
        {
          id: 'run-2',
          status: 'completed',
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            billingAccountId: ACCOUNT.id,
            runId: 'run-1',
            runType: 'receipt_outbound',
            periodStart: '2026-05-01T00:00:00.000Z',
            periodEnd: '2026-06-01T00:00:00.000Z',
            complete: true,
            scanned: 1,
            reverted: 0,
            posted: 1,
            quarantined: 0,
            updated: 1,
            replayed: 0,
            casNoops: 0,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            noHash: 0,
            remainingUnresolved: 0,
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

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
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
            reverted: 0,
            posted: 1,
            quarantined: 0,
            updated: 1,
            replayed: 0,
            casNoops: 0,
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
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            billingAccountId: ACCOUNT.id,
            runId: 'run-1',
            runType: 'receipt_outbound',
            periodStart: '2026-05-01T00:00:00.000Z',
            periodEnd: '2026-06-01T00:00:00.000Z',
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
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          completedAt: new Date('2026-06-02T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            billingAccountId: ACCOUNT.id,
            runId: 'run-1',
            runType: 'receipt_outbound',
            periodStart: '2026-05-01T00:00:00.000Z',
            periodEnd: '2026-06-01T00:00:00.000Z',
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
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          completedAt: new Date('2026-06-02T00:00:00.000Z'), // after periodEnd 2026-06-01
          summary: {
            userId: 'user-1',
            billingAccountId: ACCOUNT.id,
            runId: 'run-1',
            runType: 'receipt_outbound',
            periodStart: '2026-05-01T00:00:00.000Z',
            periodEnd: '2026-06-01T00:00:00.000Z',
            complete: true,
            scanned: 1,
            reverted: 0,
            posted: 1,
            quarantined: 0,
            updated: 1,
            replayed: 0,
            casNoops: 0,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            noHash: 0,
            remainingUnresolved: 0,
            retryable: 0,
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

    it('rejects a run whose valid coverage does not include the target month', async () => {
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
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-07-01T00:00:00.000Z'),
          periodEnd: new Date('2026-08-01T00:00:00.000Z'),
          summary: {
            userId: 'user-1',
            complete: true,
            scanned: 1,
            errors: 0,
            conflicts: 0,
            notFound: 0,
            transientError: 0,
            noHash: 0,
            remainingUnresolved: 0,
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

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      // operational runs are scoped to the account and overlapping target period
      // (no accountUserId predicate — contradictory user scopes must still reach
      // the TypeScript relevance/risk fence).
      expect(reconciliationRunFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                billingAccountId: 'acc-1',
                periodStart: { lte: new Date('2026-08-01T00:00:00.000Z') },
                periodEnd: { gte: new Date('2026-07-01T00:00:00.000Z') },
              },
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

    it('does not let a later clean exhaustive run clear older risk for the target', async () => {
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
      // newest first: run-2 is clean, but the older relevant run-1 still has
      // retryable risk and must keep finalization fail-closed.
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
            noHash: 0,
            remainingUnresolved: 0,
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

      await expect(service.finalizeInvoice('user-1', '2026-07')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('keeps matching account runs relevant when summary identity is contradictory', () => {
      const relevant = (service as any).isRunRelevantToPeriod(
        {
          id: 'run-corrupt',
          billingAccountId: ACCOUNT.id,
          accountUserId: 'user-1',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          summary: { userId: 'user-other' },
        },
        new Date('2026-05-01T00:00:00.000Z'),
        new Date('2026-06-01T00:00:00.000Z'),
        'user-1',
        ACCOUNT.id,
        [],
      );
      expect(relevant).toBe(true);
    });

    it('keeps a usage-linked run relevant when stored account and user scope conflicts', () => {
      const relevant = (service as any).isRunRelevantToPeriod(
        {
          id: 'run-linked',
          billingAccountId: 'acc-other',
          accountUserId: 'user-other',
          runType: 'receipt_outbound',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          summary: { userId: 'user-other' },
        },
        new Date('2026-05-01T00:00:00.000Z'),
        new Date('2026-06-01T00:00:00.000Z'),
        'user-1',
        ACCOUNT.id,
        ['run-linked'],
      );

      // Relevance is retained from immutable usage provenance; the later risk
      // fence blocks the contradictory run instead of isolating it.
      expect(relevant).toBe(true);
    });

    it('keeps matching partial/global legacy scopes relevant but isolates another user', () => {
      const check = (billingAccountId: string | null, accountUserId: string | null) =>
        (service as any).isRunRelevantToPeriod(
          {
            id: 'run-legacy',
            billingAccountId,
            accountUserId,
            runType: 'receipt_outbound',
            summary: {},
          },
          new Date('2026-05-01T00:00:00.000Z'),
          new Date('2026-06-01T00:00:00.000Z'),
          'user-1',
          ACCOUNT.id,
          [],
        );
      expect(check(null, 'user-1')).toBe(true);
      expect(check(null, null)).toBe(true);
      expect(check(null, 'user-other')).toBe(false);
    });

    // ── BILL-009 hybrid finalize (mid-month paid upgrade) ──────────────────

    it('BILL-009: finalize Free→Starter uses target allowances/rates; fixed fee stays Free', async () => {
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      const starterWithRates = {
        ...STARTER_VERSION,
        apiOverageRateMicros: 1_500n,
        walletOverageRateMicros: 10_000n,
      };
      const freeWithRates = {
        ...FREE_VERSION,
        apiOverageRateMicros: 2_000n,
        walletOverageRateMicros: 10_000n,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(freeWithRates);
      // Open usage_period invoice still pinned to Free fee anchor.
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: freeWithRates.id,
        status: 'open',
      });
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: starterWithRates.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: starterWithRates,
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === starterWithRates.id) return starterWithRates;
        if (where?.id === freeWithRates.id) return freeWithRates;
        return null;
      });
      // $100K outbound under Starter $250K included; 50K API under 100K; 50 wallets under 100.
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 100_000_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
        { metric: 'api_call', quantity: 50_000n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(50);
      invoiceUpdate.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        periodStart,
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        planVersionId: freeWithRates.id,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-open-may' },
          data: expect.objectContaining({
            // Fee identity stays Free; never rewritten to Starter.
            planVersionId: freeWithRates.id,
            status: 'finalized',
            monthlyFeeMicros: 0n,
            includedOutboundMicros: starterWithRates.includedOutboundMicros,
            includedApiCalls: starterWithRates.includedApiCalls,
            includedWallets: starterWithRates.includedWallets,
            outboundOverageMicros: 0n,
            apiOverageMicros: 0n,
            walletOverageMicros: 0n,
            totalMicros: 0n,
            snapshotJson: expect.objectContaining({
              planVersionId: freeWithRates.id,
              pricingMode: 'hybrid_period',
              feePlanVersionId: freeWithRates.id,
              usagePlanVersionId: starterWithRates.id,
              plan: expect.objectContaining({
                code: 'free',
                name: 'Free',
                monthlyFeeMicros: '0',
                includedOutboundMicros: '250000',
                includedApiCalls: '100000',
                includedWallets: 100,
              }),
              amounts: expect.objectContaining({
                monthlyFeeMicros: '0',
                totalMicros: '0',
              }),
            }),
          }),
        }),
      );
      expect(result.status).toBe('finalized');
    });

    it('BILL-009: finalize Free→Growth applies Growth API overage rate without full monthly fee', async () => {
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      const GROWTH_VERSION = {
        ...STARTER_VERSION,
        id: 'plan-growth-1',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 199_000_000n,
        includedOutboundMicros: 1_000_000_000_000n,
        includedApiCalls: 1_000_000n,
        includedWallets: 1_000,
        apiOverageRateMicros: 1_000n,
        walletOverageRateMicros: 10_000n,
      };
      const freeWithRates = {
        ...FREE_VERSION,
        apiOverageRateMicros: 2_000n,
        walletOverageRateMicros: 10_000n,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(freeWithRates);
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: freeWithRates.id,
        status: 'open',
      });
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-growth',
        billingAccountId: ACCOUNT.id,
        planVersionId: GROWTH_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: GROWTH_VERSION,
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === GROWTH_VERSION.id) return GROWTH_VERSION;
        if (where?.id === freeWithRates.id) return freeWithRates;
        return null;
      });
      // 1_100_000 calls → 100_000 over Growth included @ $0.001 = $100; fee stays $0.
      usageEventFindMany.mockResolvedValue([
        { metric: 'api_call', quantity: 1_100_000n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);
      invoiceUpdate.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        periodStart,
        status: 'finalized',
        currency: 'USD',
        totalMicros: 100_000_000n,
        planVersionId: freeWithRates.id,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: freeWithRates.id,
            monthlyFeeMicros: 0n,
            apiOverageMicros: 100_000_000n,
            totalMicros: 100_000_000n,
            includedApiCalls: 1_000_000n,
            snapshotJson: expect.objectContaining({
              pricingMode: 'hybrid_period',
              feePlanVersionId: freeWithRates.id,
              usagePlanVersionId: GROWTH_VERSION.id,
              planVersionId: freeWithRates.id,
            }),
          }),
        }),
      );
      const lineData = lineCreateMany.mock.calls[0][0] as {
        data: Array<{ lineType: string; amountMicros: bigint; unitAmountMicros?: bigint }>;
      };
      expect(lineData.data.map((l) => l.lineType)).toEqual(
        expect.arrayContaining(['monthly_fee', 'api_overage']),
      );
      const feeLine = lineData.data.find((l) => l.lineType === 'monthly_fee');
      const apiLine = lineData.data.find((l) => l.lineType === 'api_overage');
      expect(feeLine?.amountMicros).toBe(0n);
      expect(apiLine?.amountMicros).toBe(100_000_000n);
      expect(apiLine?.unitAmountMicros).toBe(1_000n);
    });

    it('BILL-009: finalize without upgrade keeps single-plan pricing unchanged', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
        expiresAt: null,
        source: 'default',
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
      invoiceCreate.mockResolvedValue({
        id: 'inv-1',
        billingAccountId: ACCOUNT.id,
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        status: 'finalized',
        currency: 'USD',
        totalMicros: 53_750_000n,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: FREE_VERSION.id,
            monthlyFeeMicros: 0n,
            totalMicros: 53_750_000n,
            includedOutboundMicros: FREE_VERSION.includedOutboundMicros,
            snapshotJson: expect.objectContaining({
              pricingMode: 'single_plan',
              feePlanVersionId: FREE_VERSION.id,
              usagePlanVersionId: FREE_VERSION.id,
              planVersionId: FREE_VERSION.id,
            }),
          }),
        }),
      );
    });

    it('BILL-009: Starter→Growth keeps Starter fixed fee; target outbound overage and zero wallet charge', async () => {
      // Paid Starter→Growth mid-month: fee anchor = Starter $49 (not $0, not Growth $199).
      // Growth wallet rate $0.02 differs from Starter $0.01; outbound exceeds Growth included.
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      const starterFee = {
        ...STARTER_VERSION,
        id: 'plan-starter-fee',
        monthlyFeeMicros: 49_000_000n,
        includedOutboundMicros: 250_000_000_000n, // $250K
        includedApiCalls: 100_000n,
        includedWallets: 100,
        apiOverageRateMicros: 1_500n,
        walletOverageRateMicros: 10_000n, // $0.01 / wallet
      };
      const growthUsage = {
        ...STARTER_VERSION,
        id: 'plan-growth-usage',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 199_000_000n,
        includedOutboundMicros: 1_000_000_000_000n, // $1M
        includedApiCalls: 1_000_000n,
        includedWallets: 1_000,
        apiOverageRateMicros: 1_000n,
        walletOverageRateMicros: 20_000n, // $0.02 / wallet (≠ Starter)
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(starterFee);
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: starterFee.id,
        status: 'open',
      });
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-growth',
        billingAccountId: ACCOUNT.id,
        planVersionId: growthUsage.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: growthUsage,
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === starterFee.id) return starterFee;
        if (where?.id === growthUsage.id) return growthUsage;
        return null;
      });
      // $1.6M outbound → $600K billable after Growth $1M included:
      //   $500K @ 100ppm = $50; $100K @ 75ppm = $7.5 → $57.5 outbound overage
      // Wallet peak remains truthful, but hard-cap policy never bills overage.
      usageEventFindMany.mockResolvedValue([
        {
          metric: 'outbound_volume',
          volumeUsdMicros: 1_600_000_000_000n,
          quantity: 1n,
          status: 'posted',
          entryType: 'usage',
        },
      ]);
      walletCount.mockResolvedValue(1_050);
      walletUsageFindUnique.mockResolvedValue({ peakWalletCount: 1_050 });
      const expectedOutboundOverage = 57_500_000n;
      const expectedWalletOverage = 0n;
      const expectedTotal = 49_000_000n + expectedOutboundOverage + expectedWalletOverage;
      invoiceUpdate.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        periodStart,
        status: 'finalized',
        currency: 'USD',
        totalMicros: expectedTotal,
        planVersionId: starterFee.id,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      await service.finalizeInvoice('user-1', '2026-05');

      expect(invoiceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: starterFee.id,
            monthlyFeeMicros: 49_000_000n, // Starter fee — not 0, not Growth $199
            includedOutboundMicros: growthUsage.includedOutboundMicros,
            includedWallets: 1_000,
            outboundOverageMicros: expectedOutboundOverage,
            walletOverageMicros: expectedWalletOverage,
            totalMicros: expectedTotal,
            snapshotJson: expect.objectContaining({
              pricingMode: 'hybrid_period',
              feePlanVersionId: starterFee.id,
              usagePlanVersionId: growthUsage.id,
              planVersionId: starterFee.id,
              plan: expect.objectContaining({
                code: 'starter',
                name: 'Starter',
                monthlyFeeMicros: '49',
                includedOutboundMicros: '1000000',
                includedWallets: 1_000,
                walletOverageRateMicros: '0',
              }),
              amounts: expect.objectContaining({
                monthlyFeeMicros: '49',
                outboundOverageMicros: '57.5',
                walletOverageMicros: '0',
                totalMicros: '106.5',
              }),
              tiers: expect.arrayContaining([
                expect.objectContaining({
                  ratePpm: 100,
                  volumeMicros: '500000',
                  feeMicros: '50',
                }),
                expect.objectContaining({
                  ratePpm: 75,
                  volumeMicros: '100000',
                  feeMicros: '7.5',
                }),
              ]),
            }),
          }),
        }),
      );
      const lineData = lineCreateMany.mock.calls[0][0] as {
        data: Array<{
          lineType: string;
          amountMicros: bigint;
          unitAmountMicros?: bigint;
          unitRatePpm?: number;
        }>;
      };
      const feeLine = lineData.data.find((l) => l.lineType === 'monthly_fee');
      const walletLine = lineData.data.find((l) => l.lineType === 'wallet_overage');
      const outboundLines = lineData.data.filter((l) => l.lineType === 'outbound_tier');
      expect(feeLine?.amountMicros).toBe(49_000_000n);
      expect(walletLine).toBeUndefined();
      expect(outboundLines.map((l) => l.amountMicros).reduce((a, b) => a + b, 0n)).toBe(
        expectedOutboundOverage,
      );
    });

    it('BILL-009: historical upgraded month uses that month target even if assignment later expired', async () => {
      // Clock = 2026-08. May had mid-month Free→Starter upgrade (Starter expired end of May).
      // Current entitlement is Free again. Requested historical May must still use May's Starter.
      const mayStart = new Date('2026-05-01T00:00:00.000Z');
      const starterMay = {
        ...STARTER_VERSION,
        id: 'plan-starter-may',
        apiOverageRateMicros: 1_500n,
        walletOverageRateMicros: 10_000n,
      };
      const freeAnchor = {
        ...FREE_VERSION,
        apiOverageRateMicros: 2_000n,
        walletOverageRateMicros: 10_000n,
      };
      const mayStarterAssignment = {
        id: 'assign-starter-may',
        billingAccountId: ACCOUNT.id,
        planVersionId: starterMay.id,
        periodStart: mayStart,
        expiresAt: new Date('2026-06-01T00:00:00.000Z'), // expired before "now"
        source: 'upgrade_payment',
        planVersion: starterMay,
      };
      const currentFreeAssignment = {
        id: 'assign-free-aug',
        billingAccountId: ACCOUNT.id,
        planVersionId: freeAnchor.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: null,
        source: 'default',
        planVersion: freeAnchor,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(freeAnchor);
      assignmentFindMany.mockImplementation(async (args: any) => {
        const lte = args?.where?.periodStart?.lte as Date | undefined;
        if (!lte) return [currentFreeAssignment];
        // Entitlement at May: Starter still valid (expiresAt > May 1).
        if (lte.getTime() < new Date('2026-06-01T00:00:00.000Z').getTime()) {
          return [mayStarterAssignment];
        }
        return [currentFreeAssignment];
      });
      assignmentFindFirst.mockResolvedValue(currentFreeAssignment);
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-usage-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart: mayStart,
        planVersionId: freeAnchor.id,
        status: 'open',
      });
      planVersionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
        if (where?.id === freeAnchor.id) return freeAnchor;
        if (where?.id === starterMay.id) return starterMay;
        return null;
      });
      // 50K API under Starter 100K included → $0 overage; Free would charge heavily.
      usageEventFindMany.mockResolvedValue([
        { metric: 'api_call', quantity: 50_000n, status: 'posted', entryType: 'usage' },
      ]);
      walletCount.mockResolvedValue(0);

      // Summary path (historical requested month).
      const summary = await service.getSummary('user-1', '2026-05');
      expect(summary.planId).toBe('free');
      expect(summary.estimatedBaseCost).toBe('0');
      expect(summary.apiCallsFreeAllowance).toBe('100000');
      expect(summary.estimatedOverageCost).toBe('0');
      expect(summary.estimatedTotal).toBe('0');

      // Finalize path for the same historical month.
      invoiceUpdate.mockResolvedValue({
        id: 'inv-usage-may',
        billingAccountId: ACCOUNT.id,
        periodStart: mayStart,
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        planVersionId: freeAnchor.id,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      });
      await service.finalizeInvoice('user-1', '2026-05');
      expect(invoiceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: freeAnchor.id,
            monthlyFeeMicros: 0n,
            includedApiCalls: 100_000n,
            apiOverageMicros: 0n,
            totalMicros: 0n,
            snapshotJson: expect.objectContaining({
              pricingMode: 'hybrid_period',
              feePlanVersionId: freeAnchor.id,
              usagePlanVersionId: starterMay.id,
            }),
          }),
        }),
      );
    });

    it('BILL-009: re-finalize of already-finalized invoice does not re-resolve entitlement or rewrite', async () => {
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      const frozenSnapshot = {
        version: 1,
        period: '2026-05',
        planVersionId: FREE_VERSION.id,
        pricingMode: 'hybrid_period',
        feePlanVersionId: FREE_VERSION.id,
        usagePlanVersionId: STARTER_VERSION.id,
        plan: { code: 'free', name: 'Free' },
        amounts: { monthlyFeeMicros: '0', totalMicros: '0' },
      };
      const finalizedInvoice = {
        id: 'inv-final-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: FREE_VERSION.id,
        status: 'finalized' as const,
        currency: 'USD',
        totalMicros: 0n,
        snapshotJson: frozenSnapshot,
        snapshotHash: 'a'.repeat(64),
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
        finalizedAt: new Date('2026-06-02T00:00:00.000Z'),
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      // Both pre-check and any locked re-check return finalized (immutable).
      invoiceFindFirst.mockResolvedValue(finalizedInvoice);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-growth-now',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });

      const result = await service.finalizeInvoice('user-1', '2026-05');

      expect(result.id).toBe('inv-final-may');
      expect(result.status).toBe('finalized');
      // Early return: no lock work, no entitlement re-resolve, no rewrite.
      expect(transaction).not.toHaveBeenCalled();
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(lineCreateMany).not.toHaveBeenCalled();
      expect(lineDeleteMany).not.toHaveBeenCalled();
      expect(assignmentFindMany).not.toHaveBeenCalled();
      expect(usageEventFindMany).not.toHaveBeenCalled();
    });

    it('BILL-009: finalize fails closed on incomplete upgrade_payment assignment', async () => {
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindFirst.mockResolvedValue(null);
      assignmentFindUnique.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });
      planChangeFindFirst.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-starter',
        billingAccountId: ACCOUNT.id,
        planVersionId: STARTER_VERSION.id,
        periodStart,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        source: 'upgrade_payment',
        planVersion: STARTER_VERSION,
      });

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(invoiceUpdate).not.toHaveBeenCalled();
    });

    it('BILL-009: finalize fails closed when open invoice plan version is missing', async () => {
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planVersionFindFirst.mockResolvedValue(FREE_VERSION);
      invoiceFindFirst.mockResolvedValue({
        id: 'inv-open-may',
        billingAccountId: ACCOUNT.id,
        purpose: 'usage_period',
        periodStart,
        planVersionId: 'missing-plan-version',
        status: 'open',
      });
      planVersionFindUnique.mockResolvedValue(null);
      assignmentFindFirst.mockResolvedValue({
        id: 'assign-1',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        planVersion: FREE_VERSION,
      });

      await expect(service.finalizeInvoice('user-1', '2026-05')).rejects.toThrow(ConflictException);
      expect(invoiceUpdate).not.toHaveBeenCalled();
    });
  });

  describe('buildInvoiceLineSpecs', () => {
    it('builds monthly_fee and outbound tier lines matching finalize rules', () => {
      const plan = PLANS.starter;
      const totals = calculateInvoiceTotals({
        plan,
        grossOutboundMicros: 0n,
        activeWallets: 0,
        apiCallsTotal: 2,
      });
      const lines = buildInvoiceLineSpecs({
        planVersionName: plan.name,
        plan,
        apiCalls: 2,
        activeWallets: 0,
        totals,
        apiOverageRateMicros: 0n,
        walletOverageRateMicros: 10_000n,
      });
      expect(lines[0]).toEqual(
        expect.objectContaining({
          lineType: 'monthly_fee',
          description: 'Monthly fee — Starter',
          quantity: 1n,
          amountMicros: plan.monthlyFeeMicros,
        }),
      );
      expect(lines.every((l) => l.lineType !== 'api_overage')).toBe(true);
      const sum = lines.reduce((a, l) => a + l.amountMicros, 0n);
      expect(sum).toBe(totals.totalMicros);
    });

    it('rejects nothing extra: zero outbound yields only fee (+ zero-volume tiers if any)', () => {
      const plan = PLANS.free;
      const totals = calculateInvoiceTotals({
        plan,
        grossOutboundMicros: 0n,
        activeWallets: 0,
        apiCallsTotal: 0,
      });
      const lines = buildInvoiceLineSpecs({
        planVersionName: plan.name,
        plan,
        apiCalls: 0,
        activeWallets: 0,
        totals,
        apiOverageRateMicros: 0n,
        walletOverageRateMicros: 0n,
      });
      expect(lines.filter((l) => l.lineType === 'monthly_fee')).toHaveLength(1);
      expect(lines.filter((l) => l.lineType === 'api_overage')).toHaveLength(0);
      expect(lines.filter((l) => l.lineType === 'wallet_overage')).toHaveLength(0);
    });
  });

  describe('createFinalizedInvoiceOnlyInTx', () => {
    const PERIOD_START = new Date('2026-05-01T00:00:00.000Z');
    const PERIOD_END = new Date('2026-06-01T00:00:00.000Z');

    /** Reuse the interactive-tx mock client from beforeEach. */
    async function lockedTx(): Promise<any> {
      return (service as any).prisma.$transaction(async (tx: any) => tx);
    }

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));
    });

    it('creates a finalized invoice and returns created:true when period is blank', async () => {
      const createdRow = {
        id: 'inv-fix',
        billingAccountId: ACCOUNT.id,
        planVersionId: FREE_VERSION.id,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        status: 'finalized',
        currency: 'USD',
        totalMicros: 0n,
        apiCalls: 0n,
        snapshotHash: 'a'.repeat(64),
        snapshotJson: { version: 1, period: '2026-05', planVersionId: FREE_VERSION.id },
        paidAt: null,
        paidVia: null,
        settlementAttemptId: null,
        stripeInvoiceId: null,
        allocatedMicros: 0n,
        lines: [{ amountMicros: 0n }],
      };
      invoiceFindUnique
        .mockResolvedValueOnce(null) // create-only pre-check
        .mockResolvedValueOnce(createdRow); // findUniqueOrThrow after create
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockResolvedValue(createdRow);
      lineCreateMany.mockResolvedValue({ count: 1 });

      const tx = await lockedTx();
      const result = await service.createFinalizedInvoiceOnlyInTx(tx, {
        userId: 'user-1',
        billingAccountId: ACCOUNT.id,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        period: '2026-05',
        planVersionId: FREE_VERSION.id,
      });

      expect(result.created).toBe(true);
      expect(result.invoice.id).toBe('inv-fix');
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'finalized',
            planVersionId: FREE_VERSION.id,
            billingAccountId: ACCOUNT.id,
            paidAt: expect.any(Date),
          }),
        }),
      );
      expect(invoiceUpdate).not.toHaveBeenCalled();
    });

    it('refuses when any invoice already exists (including open)', async () => {
      invoiceFindUnique.mockResolvedValue({ id: 'inv-open', status: 'open' });
      const tx = await lockedTx();
      await expect(
        service.createFinalizedInvoiceOnlyInTx(tx, {
          userId: 'user-1',
          billingAccountId: ACCOUNT.id,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          period: '2026-05',
          planVersionId: FREE_VERSION.id,
        }),
      ).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(invoiceUpdate).not.toHaveBeenCalled();
    });

    it('refuses P2002 concurrent insert without claiming ownership', async () => {
      invoiceFindUnique.mockResolvedValue(null);
      planVersionFindUnique.mockResolvedValue(FREE_VERSION);
      usageEventFindMany.mockResolvedValue([]);
      walletCount.mockResolvedValue(0);
      invoiceCreate.mockRejectedValue(p2002());

      const tx = await lockedTx();
      await expect(
        service.createFinalizedInvoiceOnlyInTx(tx, {
          userId: 'user-1',
          billingAccountId: ACCOUNT.id,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          period: '2026-05',
          planVersionId: FREE_VERSION.id,
        }),
      ).rejects.toThrow(/concurrent invoice insert|create-only/i);
    });
  });
});

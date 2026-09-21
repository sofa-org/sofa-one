import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { BillingWorkerService } from './billing-worker.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { StripeAutoSubscriptionService } from './stripe/stripe-auto-subscription.service';
import { StripeCheckoutSessionCleanupService } from './stripe/stripe-checkout-session-cleanup.service';
import { STRIPE_CLIENT } from './stripe/stripe.constants';
import { formatUtcMonth } from './billing.utils';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

describe('BillingWorkerService', () => {
  let service: BillingWorkerService;

  const configGet = jest.fn();
  const accountFindMany = jest.fn();
  const accountUpdateMany = jest.fn();
  const invoiceFindMany = jest.fn();
  const invoiceFindFirst = jest.fn();
  const paymentAttemptFindMany = jest.fn();
  const stripeWebhookEventFindMany = jest.fn();
  const stripeWebhookEventUpdate = jest.fn();
  const stripeWebhookEventUpdateMany = jest.fn();
  const queryRaw = jest.fn();
  const reconcile = jest.fn();
  const finalizeInvoice = jest.fn();
  const ensureOpenInvoiceForPeriod = jest.fn();
  const recoverRenewalAllocation = jest.fn();
  const usdcClaim = jest.fn();
  const webhookProcessEvent = jest.fn();
  const webhookReconcileOverage = jest.fn();
  const securityRecord = jest.fn();
  const stripeEventsRetrieve = jest.fn();
  const accountFindUnique = jest.fn();
  const heartbeatUpsert = jest.fn();
  const stripePayments = {
    chargeRenewalOverage: jest.fn(),
    recoverOverageCharge: jest.fn(),
    recoverPendingCheckouts: jest.fn(),
  };
  const autoSubscription = {
    processDue: jest.fn(),
  };
  const sessionCleanup = {
    processDue: jest.fn(),
  };
  const autoIntentCount = jest.fn();
  const paymentAttemptCount = jest.fn();

  const ACCOUNT_A = { id: 'acc-a', userId: 'user-a' };

  function setupEnabled() {
    configGet.mockImplementation((key: string) => {
      if (key === 'billing.worker.enabled') return true;
      return undefined;
    });
  }

  // ── Historical-backfill harness helpers ─────────────────────────────────────
  const monthKey = (d: Date) => formatUtcMonth(d);

  /** `count` distinct UTC month starts strictly before the current month, oldest first. */
  function monthsBack(count: number): Date[] {
    const now = new Date();
    const out: Date[] = [];
    for (let i = count; i >= 1; i--) {
      let y = now.getUTCFullYear();
      let m = now.getUTCMonth() - i;
      while (m < 0) {
        m += 12;
        y -= 1;
      }
      out.push(new Date(Date.UTC(y, m, 1)));
    }
    return out;
  }

  /**
   * Mirrors the worker's round-robin selection: months strictly AFTER the
   * cursor first (oldest-first), then a wrap to months at/before the cursor
   * (oldest-first), bounded by `limit`. NULL cursor → oldest `limit` months.
   */
  function roundRobin(missing: Date[], cursor: Date | null, limit: number): Date[] {
    const sorted = [...missing].sort((a, b) => a.getTime() - b.getTime());
    if (cursor === null) return sorted.slice(0, limit);
    const after = sorted.filter((m) => m.getTime() > cursor.getTime());
    const before = sorted.filter((m) => m.getTime() <= cursor.getTime());
    return [...after, ...before].slice(0, limit);
  }

  /**
   * Wires `queryRaw`/`accountUpdateMany`/`accountFindMany`/seam to model the
   * durable round-robin cursor against `allMonths` (distinct historical months,
   * oldest first). `failPeriods` (YYYY-MM) permanently fail materialization.
   * `durableCursor` is advanced only when the CAS predicate matches the read
   * cursor, exactly like the optimistic `billingAccount.updateMany`.
   */
  function setupBackfillHarness(allMonths: Date[], failPeriods = new Set<string>()) {
    const invoiced = new Set<string>();
    let durableCursor: Date | null = null;
    queryRaw.mockImplementation((_s: TemplateStringsArray, ...values: any[]) => {
      const readCursor = values[2] instanceof Date ? (values[2] as Date) : null;
      const limit = values[4] as number;
      const missing = allMonths.filter((m) => !invoiced.has(monthKey(m)));
      const selection = roundRobin(missing, readCursor, limit);
      return Promise.resolve(selection.map((m) => ({ period_start: m })));
    });
    accountUpdateMany.mockImplementation(({ where, data }: any) => {
      const expected = where?.billingBackfillCursor ?? null;
      if (durableCursor === expected) {
        durableCursor = data.billingBackfillCursor;
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });
    accountFindMany.mockImplementation(async () => [
      { id: 'acc-a', userId: 'user-a', billingBackfillCursor: durableCursor },
    ]);
    ensureOpenInvoiceForPeriod.mockImplementation(async (_u: string, period: string) => {
      if (failPeriods.has(period)) throw new ConflictException('Enterprise custom/null terms');
      invoiced.add(period);
      return { id: `inv-${period}`, status: 'open' };
    });
    return { invoiced, getCursor: () => durableCursor };
  }

  const cleanReconcile = {
    scanned: 0,
    notFound: 0,
    transientError: 0,
    errors: 0,
    conflicts: 0,
    noHash: 0,
    skipped: false,
    ownershipLost: false,
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingWorkerService,
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: PrismaService,
          useValue: {
            billingAccount: {
              findMany: accountFindMany,
              findUnique: accountFindUnique,
              updateMany: accountUpdateMany,
            },
            billingInvoice: { findMany: invoiceFindMany, findFirst: invoiceFindFirst },
            billingPaymentAttempt: {
              findMany: paymentAttemptFindMany,
              count: paymentAttemptCount,
            },
            billingAutoSubscriptionIntent: { count: autoIntentCount },
            $queryRaw: queryRaw,
            stripeWebhookEvent: {
              findMany: stripeWebhookEventFindMany,
              update: stripeWebhookEventUpdate,
              updateMany: stripeWebhookEventUpdateMany,
            },
            billingWorkerHeartbeat: { upsert: heartbeatUpsert },
          },
        },
        {
          provide: BillingService,
          useValue: {
            finalizeInvoice: finalizeInvoice,
            ensureOpenInvoiceForPeriod,
            recoverRenewalAllocation,
          },
        },
        {
          provide: BillingReconciliationService,
          useValue: { reconcile: reconcile },
        },
        {
          provide: UsdcPaymentService,
          useValue: { claim: usdcClaim },
        },
        {
          provide: StripeWebhookService,
          useValue: {
            processEvent: webhookProcessEvent,
            reconcileOveragePaymentIntent: webhookReconcileOverage,
          },
        },
        {
          provide: StripePaymentService,
          useValue: stripePayments,
        },
        {
          provide: StripeAutoSubscriptionService,
          useValue: autoSubscription,
        },
        {
          provide: StripeCheckoutSessionCleanupService,
          useValue: sessionCleanup,
        },
        {
          provide: SecurityEventService,
          useValue: { record: securityRecord },
        },
        {
          provide: STRIPE_CLIENT,
          useValue: { events: { retrieve: stripeEventsRetrieve } },
        },
      ],
    }).compile();

    service = module.get<BillingWorkerService>(BillingWorkerService);

    // Safe empty defaults; individual tests override them.
    accountFindMany.mockResolvedValue([]);
    accountUpdateMany.mockResolvedValue({ count: 1 });
    invoiceFindMany.mockResolvedValue([]);
    invoiceFindFirst.mockResolvedValue(null);
    queryRaw.mockResolvedValue([]);
    paymentAttemptFindMany.mockResolvedValue([]);
    stripeWebhookEventFindMany.mockResolvedValue([]);
    stripeWebhookEventUpdateMany.mockResolvedValue({ count: 1 });
    stripeEventsRetrieve.mockResolvedValue({ id: 'evt-none' });
    recoverRenewalAllocation.mockResolvedValue(undefined);
    webhookReconcileOverage.mockResolvedValue('settled');
    heartbeatUpsert.mockResolvedValue({ id: 'hb', status: 'healthy' });
    stripePayments.recoverPendingCheckouts.mockResolvedValue({
      attempted: 0,
      recovered: 0,
      needsReview: 0,
      retryable: 0,
    });
    autoSubscription.processDue.mockResolvedValue({
      attempted: 0,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    sessionCleanup.processDue.mockResolvedValue({
      attempted: 0,
      expired: 0,
      alreadyClosed: 0,
      needsReview: 0,
      retryable: 0,
    });
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);
  });

  it('is disabled by default: tick() is a no-op and no timer is started', async () => {
    configGet.mockReturnValue(undefined);
    service.onModuleInit();
    // tick() must not touch the database when disabled.
    await service.tick();
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it('drains reconciliation for each account via keyset pagination', async () => {
    setupEnabled();
    service.onModuleInit();
    // @Interval scheduling is registered via @nestjs/schedule; onModuleInit
    // only flips the enabled flag, so tick() is exercised directly.

    // A full page of 50 accounts forces the keyset cursor to advance.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: `acc-${i}`,
      userId: `user-${i}`,
    }));
    accountFindMany.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([]);
    // Every account drains cleanly (scanned < limit, no unresolved counters).
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
    });

    await service.tick();

    expect(accountFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ orderBy: { id: 'asc' }, take: 50 }),
    );
    // The pagination cursor advances to the last account id of the full page.
    expect(accountFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: { gt: 'acc-49' } } }),
    );
    expect(reconcile).toHaveBeenCalledWith('user-0', expect.objectContaining({ limit: 200 }));
    expect(reconcile).toHaveBeenCalledWith('user-49', expect.objectContaining({ limit: 200 }));
  });

  it('does not finalize when reconciliation has unresolved work (notFound/transient/conflicts)', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 5,
      notFound: 2,
      transientError: 0,
      errors: 0,
      conflicts: 0,
    });

    await service.tick();

    expect(finalizeInvoice).not.toHaveBeenCalled();
  });

  it('finalizes an eligible open period after a clean drain', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-a', billingAccountId: 'acc-a', periodStart: new Date('2026-07-01T00:00:00.000Z') },
    ]);
    finalizeInvoice.mockResolvedValue({ id: 'inv-finalized' });

    await service.tick();

    expect(invoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'open', billingAccountId: 'acc-a' }),
      }),
    );
    expect(finalizeInvoice).toHaveBeenCalledWith('user-a', '2026-07');
  });

  it('reaches the next due recurring period after the prior invoice is finalized', async () => {
    setupEnabled();
    service.onModuleInit();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    invoiceFindMany.mockResolvedValue([]);
    invoiceFindFirst
      .mockResolvedValueOnce({ periodEnd: new Date('2026-07-01T00:00:00.000Z') })
      .mockResolvedValueOnce(null);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-next', status: 'open' });

    await service.tick();

    // The next recurring period is still materialized from the finalized
    // predecessor ...
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-07');
    expect(finalizeInvoice).not.toHaveBeenCalledWith('user-a', '2026-07');
    // ... and, since the P0 fix, the account's CURRENT UTC period is also
    // materialized every tick (one call for the current period + one for the
    // recurring period).
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledTimes(2);
    expect(finalizeInvoice).toHaveBeenCalledTimes(0);
    // latest/existing discovery must filter usage_period only.
    expect(invoiceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billingAccountId: 'acc-a',
          status: 'finalized',
          purpose: 'usage_period',
        }),
      }),
    );
  });

  it('does not let a finalized plan_charge suppress next usage_period materialization', async () => {
    setupEnabled();
    service.onModuleInit();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    invoiceFindMany.mockResolvedValue([]);
    // First findFirst is latest usage_period finalized (not a plan_charge).
    // If purpose filter were missing, a newer plan_charge could win and stall.
    invoiceFindFirst
      .mockResolvedValueOnce({
        periodEnd: new Date('2026-07-01T00:00:00.000Z'),
        purpose: 'usage_period',
      })
      // existing next usage_period: none (a plan_charge-only next period must not count)
      .mockResolvedValueOnce(null);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-next', status: 'open' });

    await service.tick();

    expect(invoiceFindFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ purpose: 'usage_period', status: 'finalized' }),
    );
    expect(invoiceFindFirst.mock.calls[1][0].where).toEqual(
      expect.objectContaining({ purpose: 'usage_period', periodStart: expect.any(Date) }),
    );
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-07');
  });

  it("never finalizes another account's open invoice (cross-account regression)", async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    // A naive global lookup would return another account's overdue invoice.
    invoiceFindMany.mockResolvedValue([
      {
        id: 'inv-other',
        billingAccountId: 'acc-other',
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
      },
      { id: 'inv-a', billingAccountId: 'acc-a', periodStart: new Date('2026-07-01T00:00:00.000Z') },
    ]);
    finalizeInvoice.mockResolvedValue({ id: 'inv-finalized' });

    await service.tick();

    // Only the account's own eligible period is finalized; the cross-account
    // invoice is filtered by billingAccountId AND the ownership re-check.
    expect(finalizeInvoice).toHaveBeenCalledTimes(1);
    expect(finalizeInvoice).toHaveBeenCalledWith('user-a', '2026-07');
  });

  it('passes the explicit target period to reconciliation for each eligible open invoice', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    // One open invoice (2026-07) plus the current period are drained.
    invoiceFindMany
      .mockResolvedValueOnce([
        {
          id: 'inv-a',
          billingAccountId: 'acc-a',
          periodStart: new Date('2026-07-01T00:00:00.000Z'),
          periodEnd: new Date('2026-08-01T00:00:00.000Z'),
        },
      ])
      .mockResolvedValue([]); // no eligible finalizable period
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });

    await service.tick();

    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({
        limit: 200,
        targetPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
        targetPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      }),
    );
  });

  it('materializes an open invoice for the current UTC period of a first-period account with no finalized invoice', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    // No finalized invoices and no historical usage: the account is in its
    // first billing period. The old materializeDueRecurringPeriod-only path
    // (which requires a finalized predecessor) would have skipped it, leaving
    // its usage unbillable — the P0 leak this fix closes.
    invoiceFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-current', status: 'open' });

    await service.tick();

    // Exactly the current UTC month is materialized, through the shared seam.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledTimes(1);
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith(
      'user-a',
      expect.stringMatching(/^\d{4}-\d{2}$/),
    );
  });

  it('backfills bounded historical periods that have posted usage-ledger activity but no invoice', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    // Two historical months carry posted usage but have no invoice yet.
    queryRaw.mockResolvedValue([
      { period_start: new Date('2026-05-01T00:00:00.000Z') },
      { period_start: new Date('2026-06-01T00:00:00.000Z') },
    ]);
    invoiceFindMany.mockResolvedValue([]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-hist', status: 'open' });

    await service.tick();

    // The backfill is a parameterized missing-invoice query: account-scoped,
    // restricted to posted usage in periods before the current month, and
    // bounded to 24 per account per tick. The $queryRaw mock receives the raw
    // template plus the interpolated parameters (account id, current period
    // start, and the LIMIT bound).
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [rawStrings, ...rawParams] = queryRaw.mock.calls[0];
    const rawSql = (rawStrings as TemplateStringsArray).join('');
    expect(rawSql).toContain('billing_usage_events');
    expect(rawSql).toContain('NOT EXISTS');
    // Gate 1 attempt 3: plan_charge rows must not satisfy the invoice existence
    // probe — only usage_period invoices suppress historical materialization.
    expect(rawSql).toMatch(/purpose.*=.*usage_period/);
    expect(rawSql).toContain('billing_invoices');
    expect(rawParams).toEqual(
      expect.arrayContaining([
        'acc-a',
        expect.any(Date), // currentPeriodStart bound
        24, // LIMIT bound
      ]),
    );
    // Both historical periods plus the current period are materialized.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-05');
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-06');
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledTimes(3);
    // The durable cursor advances to the newest selected historical month
    // (2026-06) via an optimistic CAS pinned to the originally-read NULL cursor.
    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', billingBackfillCursor: null },
      data: { billingBackfillCursor: new Date('2026-06-01T00:00:00.000Z') },
    });
  });

  it('reconciles and finalizes a newly materialized historical period in the same tick', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    // Posted usage exists for a past period; materialization creates its open
    // invoice, which the drain then sees in the open-invoice enumeration and
    // finalizes (periodEnd is well past the 24h grace cutoff).
    queryRaw.mockResolvedValue([{ period_start: new Date('2026-06-01T00:00:00.000Z') }]);
    const openInvoice = {
      id: 'inv-hist',
      billingAccountId: 'acc-a',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
    };
    invoiceFindMany
      // open-invoice candidate enumeration
      .mockResolvedValueOnce([openInvoice])
      // finalizeEligiblePeriods
      .mockResolvedValueOnce([openInvoice])
      // recoverUnallocatedFixedFee
      .mockResolvedValueOnce([]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-hist', status: 'open' });
    finalizeInvoice.mockResolvedValue({ id: 'inv-hist-finalized' });

    await service.tick();

    // The same tick that materializes the historical invoice reconciles its
    // backlog with the exact account/period scope ...
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({
        targetPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
        targetPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    // ... and finalizes it after the clean drain.
    expect(finalizeInvoice).toHaveBeenCalledWith('user-a', '2026-06');
  });

  it('is idempotent across ticks: a repeated run never creates a duplicate invoice', async () => {
    setupEnabled();
    service.onModuleInit();

    // The same posted usage persists across both ticks. Materialization goes
    // exclusively through the idempotent ensureOpenInvoiceForPeriod seam, so
    // the second tick observes the same single open invoice instead of ever
    // creating a duplicate row.
    queryRaw.mockResolvedValue([{ period_start: new Date('2026-06-01T00:00:00.000Z') }]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    const openInvoice = {
      id: 'inv-hist',
      billingAccountId: 'acc-a',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
    };
    invoiceFindMany.mockResolvedValue([openInvoice]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-hist', status: 'open' });

    // A single account drains in one page (1 < ACCOUNT_PAGE_SIZE breaks the
    // keyset loop), so each tick needs exactly one queued page value.
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]);
    await service.tick();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]);
    await service.tick();

    // Two ticks → the seam is invoked twice for the historical period (an
    // idempotent no-op on the repeat) plus twice for the current period.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-06');
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledTimes(4);
    // Exactly one invoice row is ever observed in the candidate enumeration —
    // never a duplicate — and it is drained as a single account/period scope.
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ targetPeriodStart: new Date('2026-06-01T00:00:00.000Z') }),
    );
  });

  it('never creates a zero invoice or aborts other periods when a plan materialization fails closed', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    queryRaw.mockResolvedValue([
      { period_start: new Date('2026-05-01T00:00:00.000Z') },
      { period_start: new Date('2026-06-01T00:00:00.000Z') },
    ]);
    invoiceFindMany.mockResolvedValue([]);
    // The shared seam fails closed for the Enterprise/custom/malformed-plan
    // period (it throws before any write, so no zero invoice is ever created) ...
    ensureOpenInvoiceForPeriod.mockImplementation(async (_userId: string, period: string) => {
      if (period === '2026-06') throw new ConflictException('Enterprise custom/null terms');
      return { id: `inv-${period}`, status: 'open' };
    });

    await service.tick();

    // The failing period was attempted (and skipped without writing) while the
    // other historical period and the tick's reconciliation still completed —
    // a single Enterprise/custom/malformed plan never aborts unrelated periods
    // or accounts. The failed 2026-06 seam call returns no target, so it is
    // NOT carried into reconciliation candidates.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-06');
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-05');
    expect(reconcile).toHaveBeenCalled();
    // The failed period must never become a reconciliation candidate: only the
    // successfully materialized 2026-05 historical month (plus the current
    // period) are reconciled.
    expect(reconcile).not.toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ targetPeriodStart: new Date('2026-06-01T00:00:00.000Z') }),
    );
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ targetPeriodStart: new Date('2026-05-01T00:00:00.000Z') }),
    );
  });

  it('bounds historical backfill to 24 per tick and advances to missing periods on later ticks (no fixed newest-24 starvation)', async () => {
    setupEnabled();
    service.onModuleInit();

    // 25 distinct historical months with posted usage, all strictly before the
    // current UTC month, oldest first. (The bound is HISTORICAL_PERIOD_BACKFILL
    // = 24, so one month cannot be reached in a single tick.)
    const allMonths = monthsBack(25);
    expect(allMonths.map(monthKey)).toHaveLength(
      new Set(allMonths.map(monthKey)).size, // distinct
    );
    // The missing-invoice query + durable cursor model the DB: only not-yet-
    // invoiced months are returned, round-robin, capped at 24; a successful
    // seam call marks a month invoiced; the cursor is advanced via the CAS.
    setupBackfillHarness(allMonths);
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);

    // Tick 1: the selection is bounded to the OLDEST 24 months, leaving the
    // newest one un-materialized. (1 account < ACCOUNT_PAGE_SIZE breaks the
    // keyset loop, so the harness's single persistent page suffices.)
    await service.tick();
    const oldest24 = allMonths.slice(0, 24).map(monthKey);
    for (const p of oldest24) {
      expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', p);
    }
    // The 24 bound held: the newest month was NOT materialized in tick 1.
    expect(ensureOpenInvoiceForPeriod).not.toHaveBeenCalledWith('user-a', monthKey(allMonths[24]));
    // 24 historical + the current period.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledTimes(25);

    // Tick 2: the first 24 are now represented as invoiced, so the query
    // ADVANCES to the remaining missing month instead of repeating a fixed
    // newest-24 (or oldest-24) set — older periods can never be starved.
    const beforeTick2 = ensureOpenInvoiceForPeriod.mock.calls.length;
    await service.tick();
    const tick2Calls = ensureOpenInvoiceForPeriod.mock.calls.slice(beforeTick2);
    expect(tick2Calls.map((c) => c[1])).toContain(monthKey(allMonths[24]));
    expect(tick2Calls.map((c) => c[1])).toHaveLength(2); // remaining historical + current
    // None of the already-materialized months are re-attempted on tick 2.
    for (const p of oldest24) {
      const calls = ensureOpenInvoiceForPeriod.mock.calls.filter((c) => c[1] === p);
      expect(calls).toHaveLength(1);
    }
  });

  it('uses an explicitly-UTC date_trunc in every historical-selection clause (never session timezone)', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValue([ACCOUNT_A]);
    queryRaw.mockResolvedValue([{ period_start: new Date('2026-06-01T00:00:00.000Z') }]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-hist', status: 'open' });
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);

    await service.tick();

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [rawStrings] = queryRaw.mock.calls[0];
    const rawSql = (rawStrings as TemplateStringsArray).join('');

    // The 2-arg session-timezone-dependent form must never be used.
    expect(rawSql).not.toMatch(/date_trunc\(\s*'month'\s*,\s*u\."period_start"\s*\)/);
    // Every clause (SELECT, WHERE, GROUP BY, NOT EXISTS, ORDER BY) truncates
    // explicitly in UTC. The literal must appear in SELECT, WHERE, GROUP BY,
    // and the invoice NOT EXISTS comparison.
    expect(rawSql.match(/'UTC'/g)?.length).toBeGreaterThanOrEqual(4);
    expect(rawSql).toContain("date_trunc('month', u.\"period_start\", 'UTC')::timestamptz AS m");
    expect(rawSql).toContain("AND date_trunc('month', u.\"period_start\", 'UTC') < ");
    expect(rawSql).toContain("GROUP BY date_trunc('month', u.\"period_start\", 'UTC')");
    expect(rawSql).toContain('i."period_start" = date_trunc(\'month\', u."period_start", \'UTC\')');
    // The 2-arg form does not appear in the GROUP BY/NOT EXISTS either.
    expect(rawSql).not.toMatch(/GROUP BY date_trunc\(\s*'month'\s*,\s*u\."period_start"\s*\)/);
  });

  it('reaches a later valid month even when the oldest 24 permanently fail materialization (cursor advances despite failures)', async () => {
    setupEnabled();
    service.onModuleInit();

    // 25 historical months; the oldest 24 fail closed permanently (e.g.
    // Enterprise/custom/malformed plan), the newest is valid.
    const allMonths = monthsBack(25);
    const oldest24 = allMonths.slice(0, 24).map(monthKey);
    const validMonth = monthKey(allMonths[24]);
    const failPeriods = new Set(oldest24);
    setupBackfillHarness(allMonths, failPeriods);
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);

    // Tick 1 (cursor null): selects the oldest 24, all of which FAIL. The
    // durable cursor still advances past them (to the newest selected = M23).
    await service.tick();
    for (const p of oldest24) {
      expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', p);
    }
    expect(ensureOpenInvoiceForPeriod).not.toHaveBeenCalledWith('user-a', validMonth);
    // A failed period is never returned → never reconciled/finalized.
    for (const p of oldest24) {
      expect(reconcile).not.toHaveBeenCalledWith(
        'user-a',
        expect.objectContaining({ targetPeriodStart: new Date(`${p}-01T00:00:00.000Z`) }),
      );
    }

    // Tick 2 (cursor = M23): months strictly after the cursor are selected
    // first, so the VALID later month is now reached even though the older 24
    // still fail. The cursor advances to M24 (the valid month).
    const beforeTick2 = ensureOpenInvoiceForPeriod.mock.calls.length;
    await service.tick();
    const tick2Calls = ensureOpenInvoiceForPeriod.mock.calls.slice(beforeTick2);
    expect(tick2Calls.map((c) => c[1])).toContain(validMonth);
    // The valid month is materialized (returned) and carried into reconciliation.
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ targetPeriodStart: new Date(`${validMonth}-01T00:00:00.000Z`) }),
    );
  });

  it('wraps around to retry failed months after later months are processed, advancing the ring cursor across the pure wrap', async () => {
    setupEnabled();
    service.onModuleInit();

    // Three historical months: the oldest (M0) permanently fails, M1 and M2
    // succeed.
    const allMonths = monthsBack(3); // [M0 (oldest), M1, M2 (newest)]
    const [m0, m1, m2] = allMonths;
    setupBackfillHarness(allMonths, new Set([monthKey(m0)]));
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);

    // Tick 1 (cursor null): selects M0, M1, M2; M0 fails, M1/M2 succeed. The
    // cursor advances to M2 (last selected in circular order) despite M0 failing.
    await service.tick();
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', monthKey(m2));
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ targetPeriodStart: m1 }),
    );
    // The failed M0 is not returned/carried.
    expect(reconcile).not.toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ targetPeriodStart: m0 }),
    );

    // Tick 2 (cursor = M2): M1/M2 now have invoices, so only M0 is missing;
    // selection WRAPS to M0 (at/before cursor) and retries it. The pure-wrap
    // selection still advances the circular cursor to the last selected month
    // (M0): the numeric decrease M2 → M0 is intentional logical ring movement,
    // not a forbidden regression — a wrapped region wider than one month keeps
    // rotating instead of freezing on the same oldest subset forever.
    const seamCallsBefore = ensureOpenInvoiceForPeriod.mock.calls.length;
    await service.tick();
    const callsAfterWrap = ensureOpenInvoiceForPeriod.mock.calls
      .slice(seamCallsBefore)
      .map((c) => c[1]);
    // M0 is retried on the wrapped tick (retryable, not permanently stuck).
    expect(callsAfterWrap).toContain(monthKey(m0));
    // The pure wrap advanced the cursor via the optimistic CAS pinned to the
    // originally-read M2 — never an unpinned write that could clobber a
    // concurrent worker.
    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', billingBackfillCursor: m2 },
      data: { billingBackfillCursor: m0 },
    });
  });

  it('rotates through >24 permanently missing wrapped months so later months are always re-reached (pure-wrap advancement)', async () => {
    setupEnabled();
    service.onModuleInit();

    // 60 historical months with posted usage, ALL permanently failing (e.g.
    // Enterprise/custom/malformed plan). None ever materialize, so once the
    // after-cursor region is exhausted more than 24 missing months sit at or
    // before the cursor — the pure-wrap starvation case. A cursor that only
    // advanced for strictly-after selections would freeze on the same oldest 24
    // forever; the circular cursor must keep rotating so every later wrapped
    // month is re-reached across ticks.
    const allMonths = monthsBack(60);
    const failPeriods = new Set(allMonths.map(monthKey));
    const harness = setupBackfillHarness(allMonths, failPeriods);
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);

    const cursorAfter: Array<Date | null> = [];
    const attemptHistory: string[][] = [];
    for (let tick = 1; tick <= 8; tick++) {
      const seamCallsBefore = ensureOpenInvoiceForPeriod.mock.calls.length;
      await service.tick();
      attemptHistory.push(
        ensureOpenInvoiceForPeriod.mock.calls.slice(seamCallsBefore).map((c) => c[1]),
      );
      cursorAfter.push(harness.getCursor());
    }

    // Expected circular traversal frontier after each tick. The selection
    // windows slide: M0–M23, M24–M47, then (after-region nearly empty) a wrap
    // that advances M47 → M11, onward through M12–M35, M36–M59, and finally a
    // PURE wrap (nothing after M59) that still advances M59 → M23 — the exact
    // movement a strictly-after cursor rule would forbid, leaving the durable
    // cursor frozen at M59 while only the oldest 24 wrapped months repeated.
    const cursorKeys = cursorAfter.map((d) => (d ? monthKey(d) : null));
    expect(cursorKeys).toEqual([
      monthKey(allMonths[23]),
      monthKey(allMonths[47]),
      monthKey(allMonths[11]),
      monthKey(allMonths[35]),
      monthKey(allMonths[59]),
      monthKey(allMonths[23]),
      monthKey(allMonths[47]),
      monthKey(allMonths[11]),
    ]);

    // Eventual reachability of ALL months: because the cursor keeps rotating
    // (including across pure wraps), every one of the 60 missing months is
    // re-attempted on multiple distinct ticks — the later wrapped months are
    // never starved behind a frozen oldest-24 window. (A cursor that only
    // advanced after strictly-after selections would attempt each of
    // M24–M59 exactly once and then repeat M0–M23 forever.)
    const allMonthKeys = new Set(allMonths.map(monthKey));
    const attemptsPerMonth = new Map<string, number>();
    for (const tickCalls of attemptHistory) {
      for (const p of tickCalls) {
        if (!allMonthKeys.has(p)) continue; // ignore the current-period call
        attemptsPerMonth.set(p, (attemptsPerMonth.get(p) ?? 0) + 1);
      }
    }
    expect(attemptsPerMonth.size).toBe(allMonths.length);
    for (const p of allMonthKeys) {
      expect(attemptsPerMonth.get(p)).toBeGreaterThanOrEqual(2);
    }
  });

  it('does not overwrite a newer durable cursor via the optimistic CAS (concurrent advance)', async () => {
    setupEnabled();
    service.onModuleInit();

    // This worker reads cursor = 2026-06 and selects 2026-07 to advance to.
    const readCursor = new Date('2026-06-01T00:00:00.000Z');
    const targetCursor = new Date('2026-07-01T00:00:00.000Z');
    accountFindMany.mockResolvedValue([
      { id: 'acc-a', userId: 'user-a', billingBackfillCursor: readCursor },
    ]);
    queryRaw.mockResolvedValue([{ period_start: targetCursor }]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-2026-07', status: 'open' });
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);
    // A concurrent worker has ALREADY advanced the durable cursor past what
    // this worker read, so the CAS predicate matches zero rows (count 0).
    accountUpdateMany.mockResolvedValue({ count: 0 });

    await service.tick();

    // The CAS pins the predicate to the cursor value this worker READ, so it
    // can never overwrite a newer cursor.
    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { id: 'acc-a', billingBackfillCursor: readCursor },
      data: { billingBackfillCursor: targetCursor },
    });
  });

  it('carries a successfully materialized overdue historical period into reconciliation and finalization in the same tick (causal inclusion)', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    // The invoice enumeration is EMPTY — the capped open-invoice and
    // finalization queries do NOT surface the historical period. It can only
    // reach reconciliation and finalization through the returned materialized
    // targets (the new invoice is NOT injected into invoiceFindMany).
    invoiceFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([{ period_start: new Date('2026-06-01T00:00:00.000Z') }]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-hist', status: 'open' });
    finalizeInvoice.mockResolvedValue({ id: 'inv-hist-finalized' });

    await service.tick();

    // Reconciliation receives the overdue historical period solely via the
    // materialized merge (the open-invoice enumeration was empty).
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({
        targetPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
        targetPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    // Finalization receives it solely via the materialized merge (the
    // finalization query was empty), because the period ended past grace.
    expect(finalizeInvoice).toHaveBeenCalledWith('user-a', '2026-06');
  });

  it('normalizes a non-midnight raw usage row to its UTC month boundary for materialization, reconciliation, and finalization', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    invoiceFindMany.mockResolvedValue([]);
    // A raw usage row at a non-midnight, near-end-of-month instant. The worker
    // must normalize it to the 2026-06 UTC month boundary regardless.
    queryRaw.mockResolvedValue([{ period_start: new Date('2026-06-15T23:59:59.999Z') }]);
    ensureOpenInvoiceForPeriod.mockResolvedValue({ id: 'inv-hist', status: 'open' });
    finalizeInvoice.mockResolvedValue({ id: 'inv-hist-finalized' });

    await service.tick();

    // formatUtcMonth of the normalized start is the correct UTC month.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-06');
    // The reconciliation target is the clean normalized [start, end) boundary.
    expect(reconcile).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({
        targetPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
        targetPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    // finalizeEligiblePeriods derives the normalized period string correctly.
    expect(finalizeInvoice).toHaveBeenCalledWith('user-a', '2026-06');
  });

  it('never overlaps: a second tick returns immediately while the first is in flight', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]);
    let release!: (v: unknown) => void;
    const gate = new Promise((res) => {
      release = res;
    });
    reconcile.mockImplementation(() =>
      gate.then(() => ({
        scanned: 0,
        notFound: 0,
        transientError: 0,
        errors: 0,
        conflicts: 0,
        noHash: 0,
        skipped: false,
        ownershipLost: false,
      })),
    );

    const first = service.tick();
    // Let the first tick start (it will block on the gate inside reconcile).
    for (let i = 0; i < 20 && reconcile.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(reconcile).toHaveBeenCalledTimes(1);

    const second = service.tick();
    await second; // returns immediately without touching the database

    expect(accountFindMany).toHaveBeenCalledTimes(1); // only the first tick scanned
    expect(reconcile).toHaveBeenCalledTimes(1);

    release(undefined);
    await first;
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('recovers due USDC claims through the existing claim verification path', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([]);
    paymentAttemptFindMany.mockResolvedValue([
      {
        id: 'att-1',
        invoiceId: 'inv-1',
        walletPaymentReserved: false,
        submittedTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        invoice: { billingAccount: { userId: 'user-a' } },
      },
    ]);
    usdcClaim.mockResolvedValue({ status: 'pending', retryable: true });

    await service.tick();

    // Phase 2B B2: client claims + reserved due nextCheckAt + succeeded marker repair.
    // Reserved branch must require nextCheckAt <= now (no null = due).
    expect(paymentAttemptFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          method: 'usdc',
          OR: expect.arrayContaining([
            expect.objectContaining({
              walletPaymentReserved: false,
              status: { in: ['pending', 'confirming'] },
              submittedTxHash: { not: null },
            }),
            expect.objectContaining({
              walletPaymentReserved: true,
              status: { in: ['pending', 'confirming', 'needs_review'] },
              nextCheckAt: expect.objectContaining({ lte: expect.any(Date) }),
            }),
            expect.objectContaining({
              walletPaymentReserved: true,
              status: 'succeeded',
              walletPaymentTransaction: expect.objectContaining({
                is: expect.objectContaining({
                  billingReconciledAt: null,
                  operationType: 'billing_payment',
                }),
              }),
            }),
          ]),
        }),
      }),
    );
    expect(usdcClaim).toHaveBeenCalledWith('user-a', 'inv-1', {
      paymentAttemptId: 'att-1',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    });
  });

  it('audits high-risk USDC recovery outcomes (needs_review) without breaking the tick', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([]);
    paymentAttemptFindMany.mockResolvedValue([
      {
        id: 'att-1',
        invoiceId: 'inv-1',
        submittedTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        invoice: { billingAccount: { userId: 'user-a' } },
      },
    ]);
    usdcClaim.mockResolvedValue({ status: 'needs_review', reviewReason: 'evidence_conflict' });

    await service.tick();

    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'billing.usdc.claim_recovered',
        riskLevel: 'high',
        result: 'denied',
        metadata: expect.objectContaining({ paymentAttemptId: 'att-1' }),
      }),
    );
  });

  it('retries deferred Stripe renewal events by re-fetching from Stripe', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      {
        id: 'wev-1',
        stripeEventId: 'evt_1',
        retryCount: 1,
      },
    ]);
    stripeEventsRetrieve.mockResolvedValue({ id: 'evt_1', type: 'invoice.paid' });
    webhookProcessEvent.mockResolvedValue('processed');

    await service.tick();

    expect(stripeEventsRetrieve).toHaveBeenCalledWith('evt_1');
    expect(webhookProcessEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt_1', type: 'invoice.paid' }),
      { ownerId: expect.any(String) },
    );
  });

  it('does not retrieve a deferred event when the lease claim is lost', async () => {
    setupEnabled();
    service.onModuleInit();
    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-lost', stripeEventId: 'evt-lost', retryCount: 1 },
    ]);
    stripeWebhookEventUpdateMany.mockResolvedValueOnce({ count: 0 });

    await service.tick();

    expect(stripeEventsRetrieve).not.toHaveBeenCalled();
    expect(webhookProcessEvent).not.toHaveBeenCalled();
  });

  it('bumps the retry backoff when a deferred Stripe retry fails transiently', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 1 },
    ]);
    stripeEventsRetrieve.mockRejectedValue(new Error('stripe transient'));

    await service.tick();

    // The retry bump is a status-guarded CAS: only a still-deferred event may
    // be rescheduled (a concurrent processed webhook is never overwritten).
    expect(stripeWebhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wev-1', status: 'deferred' }),
        data: expect.objectContaining({ retryCount: 2, nextRetryAt: expect.any(Date) }),
      }),
    );
  });

  it('never finalizes after losing reconciliation ownership (takeover)', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    // The run was taken over mid-drain: the worker must stop and NOT finalize.
    reconcile.mockResolvedValue({
      scanned: 1,
      ownershipLost: true,
      skipped: false,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
    });
    // There IS an eligible open invoice, but finalization must be skipped.
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-a', billingAccountId: 'acc-a', periodStart: new Date('2026-07-01T00:00:00.000Z') },
    ]);

    await service.tick();

    expect(finalizeInvoice).not.toHaveBeenCalled();
  });

  it('marks a deferred Stripe retry exhausted as needs_review instead of retrying forever', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([]);
    // The event already burned the full retry budget; this tick's retrieve
    // fails again — it must transition to needs_review, never reschedule.
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 5, type: 'invoice.paid' },
    ]);
    stripeEventsRetrieve.mockRejectedValue(new Error('stripe down'));

    await service.tick();

    expect(stripeWebhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wev-1', status: 'deferred' }),
        data: expect.objectContaining({
          status: 'needs_review',
          retryCount: 6,
          nextRetryAt: null,
          errorType: 'deferred_retry_exhausted',
        }),
      }),
    );
    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'billing.stripe.renewal_deferred_exhausted',
        riskLevel: 'high',
      }),
    );
  });

  it('never overwrites a concurrently processed deferred event with a stale retry update', async () => {
    setupEnabled();
    service.onModuleInit();

    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 1 },
    ]);
    stripeEventsRetrieve.mockRejectedValue(new Error('stripe down'));
    // A concurrent webhook already processed the event: the status-guarded CAS
    // matches zero rows, so no retry bump and no exhaustion audit happens.
    stripeWebhookEventUpdateMany.mockResolvedValue({ count: 0 });

    await service.tick();

    expect(stripeWebhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'deferred' }) }),
    );
    expect(securityRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'billing.stripe.renewal_deferred_exhausted',
      }),
    );
  });

  it('logs a sanitized top-level tick failure and never rethrows', async () => {
    setupEnabled();
    service.onModuleInit();
    const errorSpy = jest.spyOn((service as any).logger, 'error');

    // An unexpected failure at the very top of the pass (before any per-account
    // scope exists) must be sanitized-logged, not rethrown, so the scheduler
    // loop survives and the in-process single-flight guard is released.
    const rawHex = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    accountFindMany.mockRejectedValue(new Error(`db connection lost ${rawHex}`));

    await expect(service.tick()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Billing worker tick failed'));
    const logged = errorSpy.mock.calls[0][0] as string;
    expect(logged).not.toContain(rawHex);
    expect(logged).toContain('[hex]');
    // The single-flight guard is released after a failed tick.
    accountFindMany.mockResolvedValueOnce([]);
    await expect(service.tick()).resolves.toBeUndefined();
  });

  describe('renewal overage (automatic remainder collection)', () => {
    const cleanReconcile = {
      scanned: 0,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    };
    const renewalAccountRow = {
      id: 'acc-a',
      userId: 'user-a',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      stripeSubscriptionStatus: 'active',
      stripeSubscriptionPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      stripeSubscriptionPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      stripeSubscriptionUpdatedAt: null,
      stripeSubscriptionEventId: null,
      activeSubscriptionPlanVersionId: 'plan-1',
      currency: 'USD',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const renewalInvoiceRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'inv-renew',
      billingAccountId: 'acc-a',
      planVersionId: 'plan-1',
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      status: 'finalized',
      currency: 'USD',
      totalMicros: 109_000_000n,
      allocatedMicros: 49_000_000n,
      paidAt: null,
      settlementAttemptId: null,
      ...overrides,
    });

    it('triggers an overage charge for the frozen remainder after a fixed-fee allocation', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
      reconcile.mockResolvedValue(cleanReconcile);
      // drainAccount: no open invoices; finalizeEligiblePeriods: nothing to
      // finalize; fixed-fee catch-up: none unallocated; overage candidates:
      // the finalized renewal invoice.
      invoiceFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([renewalInvoiceRow()]);
      accountFindUnique.mockResolvedValue(renewalAccountRow);
      stripePayments.chargeRenewalOverage.mockResolvedValue('created');

      await service.tick();

      // The worker's candidate query only selects renewal invoices whose
      // fixed-fee coverage has already been allocated (never manual invoices).
      expect(invoiceFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-a',
            status: 'finalized',
            paidAt: null,
            settlementAttemptId: null,
            paymentAttempts: {
              some: {
                method: 'stripe',
                stripeChargeKind: 'fixed_fee',
                status: 'succeeded',
                allocatedAt: { not: null },
              },
            },
          }),
        }),
      );
      expect(stripePayments.chargeRenewalOverage).toHaveBeenCalledWith(
        renewalAccountRow,
        expect.objectContaining({
          id: 'inv-renew',
          totalMicros: 109_000_000n,
          allocatedMicros: 49_000_000n,
        }),
        expect.stringContaining('billing-worker-'),
      );
    });

    it('skips the charge when the renewal invoice has no remainder (fully covered)', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
      reconcile.mockResolvedValue(cleanReconcile);
      invoiceFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          renewalInvoiceRow({ totalMicros: 49_000_000n, allocatedMicros: 49_000_000n }),
        ]);
      accountFindUnique.mockResolvedValue(renewalAccountRow);

      await service.tick();

      expect(stripePayments.chargeRenewalOverage).not.toHaveBeenCalled();
    });

    it('never charges an invoice without allocated fixed-fee coverage', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
      reconcile.mockResolvedValue(cleanReconcile);
      // No candidate invoice matches the fixed-fee-allocated filter.
      invoiceFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      accountFindUnique.mockResolvedValue(renewalAccountRow);

      await service.tick();

      expect(stripePayments.chargeRenewalOverage).not.toHaveBeenCalled();
    });

    it('audits a fail-closed overage outcome for operator action', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
      reconcile.mockResolvedValue(cleanReconcile);
      invoiceFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([renewalInvoiceRow()]);
      accountFindUnique.mockResolvedValue(renewalAccountRow);
      stripePayments.chargeRenewalOverage.mockResolvedValue('needs_review');

      await service.tick();

      expect(securityRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'billing.stripe.overage.needs_review',
          result: 'denied',
          riskLevel: 'high',
          metadata: expect.objectContaining({ invoiceId: 'inv-renew' }),
        }),
      );
    });

    it('retries the fixed-fee allocation for a finalized invoice whose post-commit allocation failed', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
      reconcile.mockResolvedValue(cleanReconcile);
      // drainAccount: no open invoices; finalize: nothing; fixed-fee catch-up:
      // one finalized invoice with a succeeded-but-unallocated fixed-fee
      // attempt; overage candidates: none yet (allocation runs first).
      invoiceFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([renewalInvoiceRow({ allocatedMicros: 0n })])
        .mockResolvedValueOnce([]);
      accountFindUnique.mockResolvedValue(renewalAccountRow);

      await service.tick();

      // The catch-up query targets succeeded fixed-fee attempts that were never
      // allocated (allocatedAt IS NULL) — exactly the shape left behind when the
      // finalizeInvoice post-commit allocation failed.
      expect(invoiceFindMany).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-a',
            status: 'finalized',
            paidAt: null,
            settlementAttemptId: null,
            paymentAttempts: {
              some: {
                method: 'stripe',
                stripeChargeKind: 'fixed_fee',
                status: 'succeeded',
                allocatedAt: null,
              },
            },
          }),
        }),
      );
      expect(recoverRenewalAllocation).toHaveBeenCalledWith('inv-renew');
    });

    it('recovers interrupted pending overage charges through the retry lease', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([]);
      // Only the overage scan should see the pending overage attempt; the USDC
      // recovery scan must stay empty.
      paymentAttemptFindMany.mockImplementation(({ where }: any) => {
        if (where?.method === 'stripe' && where?.stripeChargeKind === 'overage') {
          return Promise.resolve([
            {
              id: 'att-overage',
              invoiceId: 'inv-renew',
              method: 'stripe',
              status: 'pending',
              stripeChargeKind: 'overage',
              stripePaymentIntentId: null,
              checkoutRetryOwnerId: null,
              checkoutRetryLeaseExpiresAt: null,
            },
          ]);
        }
        return Promise.resolve([]);
      });
      stripePayments.recoverOverageCharge.mockResolvedValue('created');

      await service.tick();

      // The recovery query fails closed on the retry BACKOFF: an attempt is
      // only selected when checkoutNextRetryAt is null or already due. Both
      // pending overage shapes (with and without a persisted PI id) are scanned:
      // the PI-id-present shape is actively reconciled, the PI-less shape is
      // re-issued.
      expect(paymentAttemptFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            method: 'stripe',
            stripeChargeKind: 'overage',
            status: 'pending',
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  { checkoutNextRetryAt: null },
                  { checkoutNextRetryAt: { lte: expect.any(Date) } },
                ]),
              }),
            ]),
          }),
        }),
      );
      expect(stripePayments.recoverOverageCharge).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'att-overage', status: 'pending' }),
        expect.stringContaining('billing-worker-'),
      );
    });

    it('respects the retry backoff: a future nextRetryAt is never recovered, but a due one is', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([]);
      // Model the DB query guard: the overage scan only returns a pending
      // uncertain attempt when its checkoutNextRetryAt has elapsed (the
      // where clause carries `lte now`), exactly like Postgres would.
      const dueRow = (nextRetryAt: Date | null) => ({
        id: 'att-overage',
        invoiceId: 'inv-renew',
        method: 'stripe',
        status: 'pending',
        stripeChargeKind: 'overage',
        stripePaymentIntentId: null,
        checkoutRetryOwnerId: null,
        checkoutRetryLeaseExpiresAt: null,
        checkoutNextRetryAt: nextRetryAt,
      });
      paymentAttemptFindMany.mockImplementation(({ where }: any) => {
        const backoffGuard = where?.AND?.find(
          (c: any) =>
            Array.isArray(c?.OR) &&
            c.OR.some((e: any) => e?.checkoutNextRetryAt?.lte !== undefined),
        );
        const dueAt = backoffGuard?.OR?.find((e: any) => e?.checkoutNextRetryAt?.lte !== undefined)
          ?.checkoutNextRetryAt?.lte;
        if (
          where?.method === 'stripe' &&
          where?.stripeChargeKind === 'overage' &&
          (dueAt instanceof Date || typeof dueAt === 'number')
        ) {
          const row = dueRow(new Date(Date.now() + 10 * 60 * 1000)); // future backoff
          return Promise.resolve(
            (row.checkoutNextRetryAt?.getTime() ?? 0) <= new Date(dueAt).getTime() ? [row] : [],
          );
        }
        return Promise.resolve([]);
      });
      stripePayments.recoverOverageCharge.mockResolvedValue('created');

      await service.tick();
      // Future backoff → the query returns nothing → never re-issued to Stripe
      // even though the 2-minute lease is claimable.
      expect(stripePayments.recoverOverageCharge).not.toHaveBeenCalled();

      // The same attempt once its backoff has elapsed IS recovered.
      paymentAttemptFindMany.mockImplementation(({ where }: any) => {
        const backoffGuard = where?.AND?.find(
          (c: any) =>
            Array.isArray(c?.OR) &&
            c.OR.some((e: any) => e?.checkoutNextRetryAt?.lte !== undefined),
        );
        const dueAt = backoffGuard?.OR?.find((e: any) => e?.checkoutNextRetryAt?.lte !== undefined)
          ?.checkoutNextRetryAt?.lte;
        if (
          where?.method === 'stripe' &&
          where?.stripeChargeKind === 'overage' &&
          (dueAt instanceof Date || typeof dueAt === 'number')
        ) {
          const row = dueRow(new Date(Date.now() - 1000)); // backoff elapsed
          return Promise.resolve(
            (row.checkoutNextRetryAt?.getTime() ?? 0) <= new Date(dueAt).getTime() ? [row] : [],
          );
        }
        return Promise.resolve([]);
      });

      await service.tick();
      expect(stripePayments.recoverOverageCharge).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'att-overage', status: 'pending' }),
        expect.stringContaining('billing-worker-'),
      );
    });

    it('actively reconciles a pending overage that has a persisted PaymentIntent id (lost-webhook recovery)', async () => {
      setupEnabled();
      service.onModuleInit();
      accountFindMany.mockResolvedValueOnce([]);
      // The overage scan returns a pending attempt WITH a persisted PI id.
      paymentAttemptFindMany.mockImplementation(({ where }: any) => {
        if (where?.method === 'stripe' && where?.stripeChargeKind === 'overage') {
          return Promise.resolve([
            {
              id: 'att-overage',
              invoiceId: 'inv-renew',
              method: 'stripe',
              status: 'pending',
              stripeChargeKind: 'overage',
              stripePaymentIntentId: 'pi_ov',
              checkoutRetryOwnerId: null,
              checkoutRetryLeaseExpiresAt: null,
            },
          ]);
        }
        return Promise.resolve([]);
      });
      webhookReconcileOverage.mockResolvedValue('settled');

      await service.tick();

      // A persisted PI id dispatches to the retrieve/validate/settle reconcile
      // path (never a re-issue that could create a second PaymentIntent).
      expect(webhookReconcileOverage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'att-overage',
          status: 'pending',
          stripePaymentIntentId: 'pi_ov',
        }),
        expect.stringContaining('billing-worker-'),
      );
      expect(stripePayments.recoverOverageCharge).not.toHaveBeenCalled();
    });
  });

  // ── Gate 2: scoped failures propagate to the tick heartbeat ──────────────

  it('writes healthy on a fully clean tick with an account that drains cleanly', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);

    await service.tick();

    // Healthy is only written when every bounded stage/account completed.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'healthy',
          lastSuccessAt: expect.any(Date),
          consecutiveFailures: 0,
        }),
        update: expect.objectContaining({
          status: 'healthy',
          lastSuccessAt: expect.any(Date),
          consecutiveFailures: 0,
        }),
      }),
    );
    expect(heartbeatUpsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('marks the tick failed when one account has a swallowed finalization failure but other accounts still drain', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    const accB = { id: 'acc-b', userId: 'user-b' };
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A, accB]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue(cleanReconcile);
    // Account A has an eligible overdue open invoice whose finalization throws
    // (swallowed per-invoice inside drainAccount); account B has nothing to do.
    const invA = {
      id: 'inv-a',
      billingAccountId: 'acc-a',
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
    };
    invoiceFindMany
      .mockResolvedValueOnce([invA]) // A: open-invoice enumeration
      .mockResolvedValueOnce([invA]) // A: finalizeEligiblePeriods candidates
      .mockResolvedValue([]); // everything else
    finalizeInvoice.mockRejectedValue(new Error('finalize db blip'));

    await service.tick();

    // Unrelated accounts still drained despite account A's scoped failure.
    expect(reconcile).toHaveBeenCalledWith('user-a', expect.anything());
    expect(reconcile).toHaveBeenCalledWith('user-b', expect.anything());
    // The swallowed finalization failure fails the tick heartbeat.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
    expect(heartbeatUpsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: 'healthy' }) }),
    );
  });

  it('marks the tick failed when a fail-closed materialization throws for a period', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue(cleanReconcile);
    invoiceFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([]);
    // The shared seam fails closed (never a zero invoice) for the current period.
    ensureOpenInvoiceForPeriod.mockRejectedValue(
      new ConflictException('Enterprise custom/null terms'),
    );

    await service.tick();

    // The failing period is per-period isolated (the drain still ran) but the
    // materialization did not complete, so the tick reports failed.
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalled();
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('marks the tick failed when reconciliation leaves unresolved work (notFound/transient/conflicts)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    invoiceFindMany.mockResolvedValue([]);
    reconcile.mockResolvedValue({
      scanned: 5,
      notFound: 2,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });

    await service.tick();

    // Unresolved reconciliation means the account's drain did not complete.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('marks the tick failed when a deferred Stripe retry fails', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 1, type: 'invoice.paid' },
    ]);
    stripeEventsRetrieve.mockRejectedValue(new Error('stripe down'));
    stripeWebhookEventUpdateMany.mockResolvedValue({ count: 1 });

    await service.tick();

    // The failed retry bumps the backoff ...
    expect(stripeWebhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wev-1', status: 'deferred' }),
        data: expect.objectContaining({ retryCount: 2, nextRetryAt: expect.any(Date) }),
      }),
    );
    // ... and fails the tick heartbeat (work did not complete).
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('marks the tick failed when a normally-returning deferred retry ends needs_review (preflight rejected / exhausted)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 1, type: 'invoice.paid' },
    ]);
    stripeEventsRetrieve.mockResolvedValue({ id: 'evt_1', type: 'invoice.paid' });
    // The pipeline converts a preflight conflict to a durable needs_review and
    // returns normally — the worker must NOT treat that as a healthy tick.
    webhookProcessEvent.mockResolvedValue('needs_review');

    await service.tick();

    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'billing.stripe.renewal_deferred_needs_review',
        riskLevel: 'high',
        result: 'denied',
        metadata: expect.objectContaining({ stripeEventId: 'evt_1' }),
      }),
    );
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('keeps the tick healthy for processed/ignored deferred outcomes', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 1, type: 'invoice.paid' },
      { id: 'wev-2', stripeEventId: 'evt_2', retryCount: 1, type: 'invoice.paid' },
    ]);
    stripeEventsRetrieve.mockResolvedValue({ id: 'evt_1' });
    webhookProcessEvent.mockResolvedValueOnce('processed').mockResolvedValueOnce('ignored');

    await service.tick();

    // Processed and ignored are completed outcomes — the tick reports healthy.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
    expect(heartbeatUpsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('keeps the tick healthy when a deferred retry reports a benign concurrent completion (processed outcome)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    stripeWebhookEventFindMany.mockResolvedValue([
      { id: 'wev-1', stripeEventId: 'evt_1', retryCount: 1, type: 'invoice.paid' },
    ]);
    stripeEventsRetrieve.mockResolvedValue({ id: 'evt_1', type: 'invoice.paid' });
    // A concurrent live webhook/worker already completed the event: the lease
    // clear matches zero rows (the row is no longer leased), which is benign,
    // and the pipeline reports the completed outcome — never a failure.
    webhookProcessEvent.mockResolvedValue('processed');
    stripeWebhookEventUpdateMany.mockResolvedValue({ count: 0 });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('marks the tick failed when checkout recovery leaves a retryable attempt pending', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    // This worker owned a non-exhausted checkout recovery failure: the retry
    // reschedule was persisted (row stays pending/retryable) but the recovery
    // did not complete — the tick must report failed.
    stripePayments.recoverPendingCheckouts.mockResolvedValue({
      attempted: 1,
      recovered: 0,
      needsReview: 0,
      retryable: 1,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('marks the tick failed when checkout recovery leaves exhausted review work', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    stripePayments.recoverPendingCheckouts.mockResolvedValue({
      attempted: 1,
      recovered: 0,
      needsReview: 1,
      retryable: 0,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('keeps the tick healthy when checkout recovery completes or only benign CAS misses occur', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    // A lease/CAS miss (another worker completed the attempt) is benign and
    // never counts as a failure; a fully recovered batch is healthy.
    stripePayments.recoverPendingCheckouts.mockResolvedValue({
      attempted: 2,
      recovered: 2,
      needsReview: 0,
      retryable: 0,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('BILL-020: keeps the tick healthy for terminal no-funds auto-subscription review alone', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 1,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 1,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    // No persisted unfinished backlog (terminal review is excluded).
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('BILL-020: fails the tick for retryable auto-subscription work', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 1,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 0,
      retryable: 1,
      recovered: 0,
      recoveryScanFailed: false,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020: fails the tick for non-terminal auto-subscription needs_review', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 1,
      completed: 0,
      needsReview: 1,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020: fails the tick when recovery scan fails even with zero due work', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 0,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: true,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020: fails a later tick when persisted cleanup/in-flight backlog remains', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    // Current tick counters are clean (nothing due).
    autoSubscription.processDue.mockResolvedValue({
      attempted: 0,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    sessionCleanup.processDue.mockResolvedValue({
      attempted: 0,
      expired: 0,
      alreadyClosed: 0,
      needsReview: 0,
      retryable: 0,
    });
    // Persisted cleanup backlog still unresolved (not due this tick).
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(2);

    await service.tick();

    expect(paymentAttemptCount).toHaveBeenCalled();
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020 B4: fails tick when needs_review has null/partial terminal labels (not safe)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 0,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    // pending=0, unresolved needs_review (partial labels)=1
    autoIntentCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(autoIntentCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'needs_review',
          // Explicit OR (not NOT/AND): nullables, partial labels, fences.
          OR: [
            { lastErrorType: null },
            { lastErrorType: { not: 'terminal_no_funds' } },
            { lastErrorCode: null },
            { lastErrorCode: { not: 'payment_method_not_reusable' } },
            { dispatchedAt: { not: null } },
            { stripeSubscriptionId: { not: null } },
          ],
        }),
      }),
    );
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020 B4: processDue terminalNoFundsReview alone does not fail the tick', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    // Immediate classification reported terminal; no retryable/needsReview/scan fail.
    autoSubscription.processDue.mockResolvedValue({
      attempted: 1,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 1,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    // Persisted row is safe terminal → backlog counts 0.
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('BILL-020 B4: processDue needsReview/retryable still fails the tick', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 1,
      completed: 0,
      needsReview: 1,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020 B4: processDue retryable (in-flight/uncertain) fails even with terminalNoFundsReview present', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    // Mixed tick: one safe terminal outcome must not mask retryable/uncertain work.
    autoSubscription.processDue.mockResolvedValue({
      attempted: 2,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 1,
      retryable: 1,
      recovered: 0,
      recoveryScanFailed: false,
    });
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020 B4: safe terminal predicate excludes only exact type+code+never-dispatched', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoSubscription.processDue.mockResolvedValue({
      attempted: 0,
      completed: 0,
      needsReview: 0,
      terminalNoFundsReview: 0,
      retryable: 0,
      recovered: 0,
      recoveryScanFailed: false,
    });
    // No pending, no unresolved needs_review (safe terminal excluded by WHERE), no cleanup
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('BILL-020: fails closed when unresolved backlog probe throws (DB/infra)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    autoIntentCount.mockRejectedValue(new Error('db unavailable'));

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('BILL-020: normal open Checkout pending does not fail via cleanup backlog probe', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    // Zero cleanup statuses; a plain pending Checkout attempt is not counted.
    autoIntentCount.mockResolvedValue(0);
    paymentAttemptCount.mockResolvedValue(0);

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('BILL-014: keeps the tick healthy when sibling session cleanup completes', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    sessionCleanup.processDue.mockResolvedValue({
      attempted: 2,
      expired: 1,
      alreadyClosed: 1,
      needsReview: 0,
      retryable: 0,
    });

    await service.tick();

    expect(sessionCleanup.processDue).toHaveBeenCalled();
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('BILL-014: fails the tick when session cleanup has retryable or needs_review work', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    sessionCleanup.processDue.mockResolvedValue({
      attempted: 1,
      expired: 0,
      alreadyClosed: 0,
      needsReview: 0,
      retryable: 1,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('marks the tick failed when overage recovery ends needs_review', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    paymentAttemptFindMany.mockImplementation(({ where }: any) => {
      if (where?.method === 'stripe' && where?.stripeChargeKind === 'overage') {
        return Promise.resolve([
          {
            id: 'att-overage',
            invoiceId: 'inv-renew',
            method: 'stripe',
            status: 'pending',
            stripeChargeKind: 'overage',
            stripePaymentIntentId: null,
            checkoutRetryOwnerId: null,
            checkoutRetryLeaseExpiresAt: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    stripePayments.recoverOverageCharge.mockResolvedValue('needs_review');

    await service.tick();

    // Fail-closed recovery exhaustion is audited and fails the tick heartbeat.
    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'billing.stripe.overage.needs_review' }),
    );
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('marks the tick failed when USDC claim recovery ends needs_review', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([]);
    paymentAttemptFindMany.mockImplementation(({ where }: any) => {
      if (where?.method === 'usdc') {
        return Promise.resolve([
          {
            id: 'att-1',
            invoiceId: 'inv-1',
            submittedTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
            invoice: { billingAccount: { userId: 'user-a' } },
          },
        ]);
      }
      return Promise.resolve([]);
    });
    usdcClaim.mockResolvedValue({ status: 'needs_review', reviewReason: 'evidence_conflict' });

    await service.tick();

    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'billing.usdc.claim_recovered' }),
    );
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('does not fail the tick when another worker owns the reconciliation lease (skipped)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    invoiceFindMany.mockResolvedValue([]);
    // A live concurrent worker owns the active run — expected, never a failure.
    reconcile.mockResolvedValue({
      scanned: 0,
      skipped: true,
      ownershipLost: false,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
    });

    await service.tick();

    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('does not fail the tick after losing reconciliation ownership (takeover)', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    invoiceFindMany.mockResolvedValue([]);
    // The run was taken over mid-drain: the worker stops and never finalizes,
    // but the takeover owner reports its own progress — not a failure here.
    reconcile.mockResolvedValue({
      scanned: 1,
      ownershipLost: true,
      skipped: false,
      notFound: 0,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
    });

    await service.tick();

    expect(finalizeInvoice).not.toHaveBeenCalled();
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
        update: expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
      }),
    );
  });

  it('increments consecutive failures on a scoped-failure tick and resets on the next clean tick', async () => {
    setupEnabled();
    service.onModuleInit();
    heartbeatUpsert.mockClear();

    // Tick 1: unresolved reconciliation work → failed + increment.
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]);
    reconcile.mockResolvedValue({
      scanned: 5,
      notFound: 2,
      transientError: 0,
      errors: 0,
      conflicts: 0,
      noHash: 0,
      skipped: false,
      ownershipLost: false,
    });
    invoiceFindMany.mockResolvedValue([]);
    await service.tick();
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', consecutiveFailures: 1 }),
        update: expect.objectContaining({
          status: 'failed',
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );

    // Tick 2: fully clean → healthy + consecutiveFailures reset to 0.
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]);
    reconcile.mockResolvedValue(cleanReconcile);
    await service.tick();
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'healthy',
          lastSuccessAt: expect.any(Date),
          consecutiveFailures: 0,
        }),
        update: expect.objectContaining({
          status: 'healthy',
          lastSuccessAt: expect.any(Date),
          consecutiveFailures: 0,
        }),
      }),
    );
  });

  // ── Worker heartbeat / readiness lifecycle ────────────────────────────────

  it('upserts starting on enabled init, running before tick work, and healthy after a clean tick', async () => {
    setupEnabled();
    await service.onModuleInit();

    // Enabled init upserts `starting` keyed by the worker id.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workerId: expect.stringContaining('billing-worker-') },
        create: expect.objectContaining({ status: 'starting' }),
      }),
    );

    accountFindMany.mockResolvedValueOnce([]);
    await service.tick();

    // Immediately before the tick work: running + refreshed heartbeat/started.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'running', lastStartedAt: expect.any(Date) }),
        update: expect.objectContaining({ status: 'running', lastStartedAt: expect.any(Date) }),
      }),
    );
    // Only after every bounded stage succeeds: healthy + success + reset failures.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'healthy',
          lastSuccessAt: expect.any(Date),
          consecutiveFailures: 0,
        }),
        update: expect.objectContaining({
          status: 'healthy',
          lastSuccessAt: expect.any(Date),
          consecutiveFailures: 0,
        }),
      }),
    );
  });

  it('upserts failed and increments consecutive failures when the top-level tick catch fires', async () => {
    setupEnabled();
    await service.onModuleInit();
    heartbeatUpsert.mockClear();

    // An unexpected failure at the top of the pass reaches the tick catch.
    accountFindMany.mockRejectedValue(new Error('db connection lost'));

    await service.tick();

    // Top-level catch upserts failed, sets failure, refreshes heartbeat, and
    // increments the consecutive-failure counter.
    expect(heartbeatUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'failed',
          lastFailureAt: expect.any(Date),
          consecutiveFailures: 1,
        }),
        update: expect.objectContaining({
          status: 'failed',
          lastFailureAt: expect.any(Date),
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
  });

  it('sanitizes a heartbeat-write failure and never masks the original billing result', async () => {
    setupEnabled();
    await service.onModuleInit();
    heartbeatUpsert.mockClear();
    const errorSpy = jest.spyOn((service as any).logger, 'error');

    // The heartbeat write fails, but the underlying billing pass still completes.
    const rawHex = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    heartbeatUpsert.mockRejectedValue(new Error(`heartbeat db down ${rawHex}`));
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]);
    reconcile.mockResolvedValue(cleanReconcile);

    await expect(service.tick()).resolves.toBeUndefined();

    // The billing work still ran (reconciliation was reached) and the pass was
    // not aborted by the heartbeat failure.
    expect(reconcile).toHaveBeenCalled();
    // The heartbeat failure was sanitized-logged, never rethrown.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Billing worker heartbeat write failed'),
    );
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(rawHex);
  });

  it('does not write a heartbeat when the worker is disabled', async () => {
    configGet.mockReturnValue(undefined);
    await service.onModuleInit();
    await service.tick();

    expect(heartbeatUpsert).not.toHaveBeenCalled();
  });
});

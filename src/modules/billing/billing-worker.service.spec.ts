import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { BillingWorkerService } from './billing-worker.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { STRIPE_CLIENT } from './stripe/stripe.constants';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

describe('BillingWorkerService', () => {
  let service: BillingWorkerService;

  const configGet = jest.fn();
  const accountFindMany = jest.fn();
  const invoiceFindMany = jest.fn();
  const invoiceFindFirst = jest.fn();
  const paymentAttemptFindMany = jest.fn();
  const stripeWebhookEventFindMany = jest.fn();
  const stripeWebhookEventUpdate = jest.fn();
  const stripeWebhookEventUpdateMany = jest.fn();
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
  const stripePayments = {
    chargeRenewalOverage: jest.fn(),
    recoverOverageCharge: jest.fn(),
    recoverPendingCheckouts: jest.fn(),
  };

  const ACCOUNT_A = { id: 'acc-a', userId: 'user-a' };

  function setupEnabled() {
    configGet.mockImplementation((key: string) => {
      if (key === 'billing.worker.enabled') return true;
      return undefined;
    });
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingWorkerService,
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: PrismaService,
          useValue: {
            billingAccount: { findMany: accountFindMany, findUnique: accountFindUnique },
            billingInvoice: { findMany: invoiceFindMany, findFirst: invoiceFindFirst },
            billingPaymentAttempt: { findMany: paymentAttemptFindMany },
            stripeWebhookEvent: {
              findMany: stripeWebhookEventFindMany,
              update: stripeWebhookEventUpdate,
              updateMany: stripeWebhookEventUpdateMany,
            },
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
    invoiceFindMany.mockResolvedValue([]);
    invoiceFindFirst.mockResolvedValue(null);
    paymentAttemptFindMany.mockResolvedValue([]);
    stripeWebhookEventFindMany.mockResolvedValue([]);
    stripeWebhookEventUpdateMany.mockResolvedValue({ count: 1 });
    stripeEventsRetrieve.mockResolvedValue({ id: 'evt-none' });
    recoverRenewalAllocation.mockResolvedValue(undefined);
    webhookReconcileOverage.mockResolvedValue('settled');
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

    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledWith('user-a', '2026-07');
    expect(finalizeInvoice).not.toHaveBeenCalledWith('user-a', '2026-07');
    expect(ensureOpenInvoiceForPeriod).toHaveBeenCalledTimes(1);
    expect(finalizeInvoice).toHaveBeenCalledTimes(0);
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
        submittedTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        invoice: { billingAccount: { userId: 'user-a' } },
      },
    ]);
    usdcClaim.mockResolvedValue({ status: 'pending', retryable: true });

    await service.tick();

    expect(paymentAttemptFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          method: 'usdc',
          status: { in: ['pending', 'confirming'] },
          submittedTxHash: { not: null },
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
    webhookProcessEvent.mockResolvedValue(undefined);

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
});

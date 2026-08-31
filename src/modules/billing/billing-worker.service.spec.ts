import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { BillingWorkerService } from './billing-worker.service';
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
  const usdcClaim = jest.fn();
  const webhookProcessEvent = jest.fn();
  const securityRecord = jest.fn();
  const stripeEventsRetrieve = jest.fn();

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
            billingAccount: { findMany: accountFindMany },
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
          useValue: { finalizeInvoice: finalizeInvoice, ensureOpenInvoiceForPeriod },
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
          useValue: { processEvent: webhookProcessEvent },
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
    accountFindMany
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([]);
    // Every account drains cleanly (scanned < limit, no unresolved counters).
    reconcile.mockResolvedValue({ scanned: 0, notFound: 0, transientError: 0, errors: 0, conflicts: 0 });

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
    reconcile.mockResolvedValue({ scanned: 5, notFound: 2, transientError: 0, errors: 0, conflicts: 0 });

    await service.tick();

    expect(finalizeInvoice).not.toHaveBeenCalled();
  });

  it('finalizes an eligible open period after a clean drain', async () => {
    setupEnabled();
    service.onModuleInit();
    
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({ scanned: 0, notFound: 0, transientError: 0, errors: 0, conflicts: 0, noHash: 0, skipped: false, ownershipLost: false });
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-a', billingAccountId: 'acc-a', periodStart: new Date('2026-07-01T00:00:00.000Z') },
    ]);
    finalizeInvoice.mockResolvedValue({ id: 'inv-finalized' });

    await service.tick();

    expect(invoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'open', billingAccountId: 'acc-a' }) }),
    );
    expect(finalizeInvoice).toHaveBeenCalledWith('user-a', '2026-07');
  });

  it('reaches the next due recurring period after the prior invoice is finalized', async () => {
    setupEnabled();
    service.onModuleInit();
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({ scanned: 0, notFound: 0, transientError: 0, errors: 0, conflicts: 0, noHash: 0, skipped: false, ownershipLost: false });
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

  it('never finalizes another account\'s open invoice (cross-account regression)', async () => {
    setupEnabled();
    service.onModuleInit();
    
    accountFindMany.mockResolvedValueOnce([ACCOUNT_A]).mockResolvedValueOnce([]);
    reconcile.mockResolvedValue({ scanned: 0, notFound: 0, transientError: 0, errors: 0, conflicts: 0, noHash: 0, skipped: false, ownershipLost: false });
    // A naive global lookup would return another account's overdue invoice.
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-other', billingAccountId: 'acc-other', periodStart: new Date('2026-06-01T00:00:00.000Z') },
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
        { id: 'inv-a', billingAccountId: 'acc-a', periodStart: new Date('2026-07-01T00:00:00.000Z'), periodEnd: new Date('2026-08-01T00:00:00.000Z') },
      ])
      .mockResolvedValue([]); // no eligible finalizable period
    reconcile.mockResolvedValue({ scanned: 0, notFound: 0, transientError: 0, errors: 0, conflicts: 0, noHash: 0, skipped: false, ownershipLost: false });

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
    reconcile.mockImplementation(
      () => gate.then(() => ({ scanned: 0, notFound: 0, transientError: 0, errors: 0, conflicts: 0, noHash: 0, skipped: false, ownershipLost: false })),
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

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Billing worker tick failed'),
    );
    const logged = errorSpy.mock.calls[0][0] as string;
    expect(logged).not.toContain(rawHex);
    expect(logged).toContain('[hex]');
    // The single-flight guard is released after a failed tick.
    accountFindMany.mockResolvedValueOnce([]);
    await expect(service.tick()).resolves.toBeUndefined();
  });
});

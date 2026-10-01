import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { InvoiceSettlementService } from '../invoice-settlement.service';
import { BillingPlanChangeService } from '../billing-plan-change.service';
import { SecurityEventService } from '../../security-events/security-event.service';
import { STRIPE_CLIENT } from './stripe.constants';
import { StripeWebhookService } from './stripe-webhook.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

// Valid UUIDs (the local attempt/invoice id columns are UUIDs; metadata
// lookups format-validate before querying).
const ATTEMPT_UUID = '11111111-1111-4111-8111-111111111111';
const INVOICE_UUID = '22222222-2222-4222-8222-222222222222';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_123',
    payment_status: 'paid',
    amount_received: 4900,
    amount_total: 4900,
    amount_subtotal: 4900,
    mode: 'payment',
    currency: 'usd',
    customer: 'cus_123',
    ...overrides,
  };
}

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_123',
    status: 'succeeded',
    amount: 4900,
    amount_received: 4900,
    currency: 'usd',
    customer: 'cus_123',
    last_payment_error: null,
    ...overrides,
  };
}

function renewalInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_123',
    subscription: 'sub_123',
    customer: 'cus_123',
    currency: 'usd',
    amount_paid: 4900,
    total: 4900,
    status: 'finalized',
    period_start: 1_785_542_400,
    period_end: 1_788_220_800, // 2026-08-01T00:00:00Z → 2026-09-01T00:00:00Z
    ...overrides,
  };
}

function event(type: string, object: unknown, id = 'evt_1') {
  return { id, type, created: 1_700_000_000, data: { object } } as any;
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    invoiceId: 'inv-1',
    method: 'stripe',
    status: 'pending',
    amountMicros: 49_000_000n,
    currency: 'USD',
    stripeChargeKind: 'full',
    stripeCheckoutSessionId: 'cs_123',
    stripePaymentIntentId: 'pi_123',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
    failureCode: null,
    failureMessage: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    succeededAt: null,
    failedAt: null,
    ...overrides,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    billingAccountId: 'acct-1',
    planVersionId: 'plan-1',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-01T00:00:00.000Z'),
    status: 'finalized',
    currency: 'USD',
    totalMicros: 49_000_000n,
    paidAt: null,
    settlementAttemptId: null,
    snapshotJson: {
      renewal: true,
      planVersionId: 'plan-1',
      fixedFeeMicros: '49000000',
      period: '2026-08-01',
    },
    snapshotHash: '866992bfad24dfffd0349f15a125a49c1dad07aea403a0f55543a30d2d6262d5',
    lines: [{ lineType: 'monthly_fee', amountMicros: 49_000_000n }],
    ...overrides,
  };
}

/**
 * The guarded paid-marker CAS the coverage-allocation boundary runs when the
 * cumulative allocation reaches the frozen total: it sets paidAt/paidVia/pointer
 * only for a finalized, unpaid, unsettled invoice whose allocatedMicros already
 * equals the full amount.
 */
function casWhere(invoiceId: string) {
  return {
    id: invoiceId,
    status: 'finalized',
    paidAt: null,
    settlementAttemptId: null,
    allocatedMicros: 49_000_000n,
  };
}

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;

  const webhookEventCreate = jest.fn();
  const webhookEventCreateMany = jest.fn();
  const webhookEventUpdate = jest.fn();
  const webhookEventUpdateMany = jest.fn();
  const webhookEventFindUnique = jest.fn();
  const attemptFindFirst = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptUpdate = jest.fn();
  const attemptUpdateMany = jest.fn();
  const attemptCreate = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const invoiceCreate = jest.fn();
  const invoiceLineCreateMany = jest.fn();
  const invoiceLineDeleteMany = jest.fn();
  const invoiceUpdate = jest.fn();
  const invoiceUpdateMany = jest.fn();
  const accountFindUnique = jest.fn();
  const accountFindFirst = jest.fn();
  const accountUpdate = jest.fn();
  const accountUpdateMany = jest.fn();
  const planVersionFindUnique = jest.fn();
  const syncIntentFindFirst = jest.fn();
  const syncIntentFindMany = jest.fn();
  const applyFixedFeeRenewalCoverage = jest.fn();
  const queryRaw = jest.fn();
  const transaction = jest.fn();
  const configGet = jest.fn();
  const constructEventAsync = jest.fn();
  const paymentIntentRetrieve = jest.fn();
  const securityRecord = jest.fn();

  const stripeMock = {
    webhooks: { constructEventAsync },
    paymentIntents: { retrieve: paymentIntentRetrieve },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    // Model Prisma's updateMany result while retaining the existing update spy
    // as a compact assertion surface for the business mutation. The production
    // service still exercises the guarded updateMany call below.
    webhookEventUpdateMany.mockImplementation(
      (args: { where: { stripeEventId: string }; data: unknown }) => {
        webhookEventUpdate({ where: { stripeEventId: args.where.stripeEventId }, data: args.data });
        return Promise.resolve({ count: 1 });
      },
    );
    webhookEventCreateMany.mockImplementation((args: { data: unknown[] }) => {
      for (const data of args.data) webhookEventCreate({ data });
      return Promise.resolve({ count: args.data.length });
    });
    attemptUpdateMany.mockImplementation(
      (args: { data?: Record<string, unknown>; where: unknown }) => {
        if (args.data?.stripePaymentIntentId || args.data?.stripeCheckoutSessionId) {
          attemptUpdate({ where: { id: (args.where as { id: string }).id }, data: args.data });
        }
        return Promise.resolve({ count: 1 });
      },
    );
    accountUpdateMany.mockImplementation((args: { where: { id: string }; data: unknown }) => {
      accountUpdate({ where: { id: args.where.id }, data: args.data });
      return Promise.resolve({ count: 1 });
    });

    configGet.mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        'stripe.webhookSecret': 'whsec_test',
      };
      return values[key];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        InvoiceSettlementService,
        {
          provide: PrismaService,
          useValue: {
            stripeWebhookEvent: {
              create: webhookEventCreate,
              createMany: webhookEventCreateMany,
              update: webhookEventUpdate,
              updateMany: webhookEventUpdateMany,
              findUnique: webhookEventFindUnique,
            },
            billingPaymentAttempt: {
              findFirst: attemptFindFirst,
              findUnique: attemptFindUnique,
              update: attemptUpdate,
              updateMany: attemptUpdateMany,
              create: attemptCreate,
            },
            billingInvoice: {
              findUnique: invoiceFindUnique,
              findFirst: invoiceFindFirst,
              create: invoiceCreate,
              update: invoiceUpdate,
              updateMany: invoiceUpdateMany,
            },
            billingInvoiceLine: {
              createMany: invoiceLineCreateMany,
              deleteMany: invoiceLineDeleteMany,
            },
            billingAccount: {
              findUnique: accountFindUnique,
              findFirst: accountFindFirst,
              update: accountUpdate,
              updateMany: accountUpdateMany,
            },
            billingPlanVersion: { findUnique: planVersionFindUnique },
            billingSubscriptionSyncIntent: {
              findFirst: syncIntentFindFirst,
              findMany: syncIntentFindMany,
            },
            $queryRaw: queryRaw,
            $transaction: transaction,
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: STRIPE_CLIENT, useValue: stripeMock },
        { provide: SecurityEventService, useValue: { record: securityRecord } },
        {
          provide: BillingPlanChangeService,
          useValue: { applyFixedFeeRenewalCoverage },
        },
      ],
    }).compile();

    service = module.get<StripeWebhookService>(StripeWebhookService);
    applyFixedFeeRenewalCoverage.mockResolvedValue(true);
    syncIntentFindFirst.mockResolvedValue(null);
    syncIntentFindMany.mockResolvedValue([]);
    invoiceLineDeleteMany.mockResolvedValue({ count: 0 });

    // The interactive transaction client shares the same jest.fn() instances
    // as this.prisma so the production transaction path is exercised.
    const tx = {
      stripeWebhookEvent: {
        create: webhookEventCreate,
        createMany: webhookEventCreateMany,
        update: webhookEventUpdate,
        updateMany: webhookEventUpdateMany,
        findUnique: webhookEventFindUnique,
      },
      billingPaymentAttempt: {
        findFirst: attemptFindFirst,
        findUnique: attemptFindUnique,
        update: attemptUpdate,
        updateMany: attemptUpdateMany,
        create: attemptCreate,
      },
      billingInvoice: {
        findUnique: invoiceFindUnique,
        findFirst: invoiceFindFirst,
        create: invoiceCreate,
        update: invoiceUpdate,
        updateMany: invoiceUpdateMany,
      },
      billingInvoiceLine: {
        createMany: invoiceLineCreateMany,
        deleteMany: invoiceLineDeleteMany,
      },
      billingAccount: {
        findUnique: accountFindUnique,
        findFirst: accountFindFirst,
        update: accountUpdate,
        updateMany: accountUpdateMany,
      },
      billingPlanVersion: { findUnique: planVersionFindUnique },
      billingSubscriptionSyncIntent: {
        findFirst: syncIntentFindFirst,
        findMany: syncIntentFindMany,
      },
      $queryRaw: queryRaw,
      $executeRaw: queryRaw,
    };
    transaction.mockImplementation(async (cb) => cb(tx));

    // The settlement service takes stable row locks (FOR UPDATE) on the
    // attempt and the invoice before re-reading them through the same tx.
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('billing_payment_attempts')) return Promise.resolve([{ id: 'att-1' }]);
      if (sql.includes('billing_invoices')) return Promise.resolve([{ id: 'inv-1' }]);
      return Promise.resolve([]);
    });

    // The settlement service re-reads the attempt (already marked succeeded in
    // this transaction) and the invoice through the same tx before settling.
    attemptFindUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        attemptRow({
          id: where.id,
          invoiceId: where.id === ATTEMPT_UUID ? INVOICE_UUID : 'inv-1',
          status: 'succeeded',
        }),
      ),
    );
    invoiceFindUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        invoiceRow({
          id: where.id,
          status: 'finalized',
          currency: 'USD',
          totalMicros: 49_000_000n,
          paidAt: null,
        }),
      ),
    );
    // usage_period lookups use findFirst (purpose filter); keep the same mock
    // chain as findUnique unless a test overrides findFirst explicitly.
    invoiceFindFirst.mockImplementation((args) => invoiceFindUnique(args));
    webhookEventFindUnique.mockResolvedValue(null);
    // Default account mirror: a customer exists, no subscription yet.
    accountFindUnique.mockResolvedValue({
      id: 'acct-1',
      userId: 'user-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      stripeSubscriptionPeriodStart: null,
      stripeSubscriptionUpdatedAt: null,
      activeSubscriptionPlanVersionId: null,
    });
    accountFindFirst.mockResolvedValue(null);
    attemptCreate.mockResolvedValue({ id: 'att-renewal', invoiceId: 'inv-1', method: 'stripe' });
  });

  describe('verification', () => {
    it('fails closed with 503 when the webhook secret is not configured', async () => {
      configGet.mockReturnValue(undefined);

      await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('fails closed with 503 when Stripe is not configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StripeWebhookService,
          InvoiceSettlementService,
          { provide: PrismaService, useValue: {} },
          { provide: ConfigService, useValue: { get: configGet } },
          { provide: STRIPE_CLIENT, useValue: null },
        ],
      }).compile();
      const unconfigured = module.get<StripeWebhookService>(StripeWebhookService);

      await expect(unconfigured.handleWebhook(Buffer.from('{}'), 't=1,v1=sig')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('rejects a missing payload with 400', async () => {
      await expect(service.handleWebhook(undefined, 't=1,v1=sig')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a missing signature with 400', async () => {
      await expect(service.handleWebhook(Buffer.from('{}'), undefined)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a tampered/wrong signature with 400 and no side effects', async () => {
      constructEventAsync.mockRejectedValue(new Error('Signature verification failed'));

      await expect(
        service.handleWebhook(Buffer.from('{"tampered":true}'), 't=1,v1=bad'),
      ).rejects.toThrow(BadRequestException);

      expect(webhookEventCreate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdate).not.toHaveBeenCalled();
    });
  });

  describe('unknown events', () => {
    it('records a verified unknown event as ignored and answers 2xx', async () => {
      constructEventAsync.mockResolvedValue(
        event('charge.succeeded', { id: 'ch_1' }, 'evt_unknown'),
      );
      webhookEventCreate.mockResolvedValue({});

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreate).toHaveBeenCalledWith({
        data: {
          stripeEventId: 'evt_unknown',
          type: 'charge.succeeded',
          status: 'ignored',
          objectId: 'ch_1',
        },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('treats a duplicate unknown event as idempotent', async () => {
      constructEventAsync.mockResolvedValue(
        event('charge.succeeded', { id: 'ch_1' }, 'evt_unknown'),
      );
      webhookEventCreate.mockRejectedValueOnce(p2002());
      webhookEventFindUnique.mockResolvedValueOnce({ status: 'processed' });
      webhookEventFindUnique.mockResolvedValueOnce({ status: 'processed' });

      await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig')).resolves.toBeUndefined();
    });
  });

  describe('known events', () => {
    it('marks the attempt succeeded and settles the invoice on a paid checkout completion', async () => {
      constructEventAsync.mockResolvedValue(
        event('checkout.session.completed', session({ payment_status: 'paid' })),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreate).toHaveBeenCalledWith({
        data: {
          stripeEventId: 'evt_1',
          type: 'checkout.session.completed',
          status: 'processed',
          objectId: 'cs_123',
        },
      });
      expect(attemptFindFirst).toHaveBeenCalledWith({
        where: { stripeCheckoutSessionId: 'cs_123', method: 'stripe' },
      });
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
        data: expect.objectContaining({
          status: 'succeeded',
          succeededAt: expect.any(Date),
          failedAt: null,
          failureCode: null,
          failureMessage: null,
        }),
      });
      // Atomic first-rail-wins settlement: paidAt/paidVia/pointer set together
      // under the full CAS (finalized/unpaid/amount/currency + succeeded
      // attempt with the referenced id/method).
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: casWhere('inv-1'),
        data: {
          paidAt: expect.any(Date),
          paidVia: 'stripe',
          settlementAttemptId: 'att-1',
        },
      });
    });

    it('keeps the attempt pending when checkout completes unpaid', async () => {
      constructEventAsync.mockResolvedValue(
        event('checkout.session.completed', session({ payment_status: 'unpaid' })),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('marks the attempt succeeded on payment_intent.succeeded', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent({ status: 'succeeded' })),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_123', method: 'stripe' },
      });
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(invoiceUpdateMany).toHaveBeenCalled();
    });

    it('marks the attempt failed on payment_intent.payment_failed and leaves the invoice unpaid', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.payment_failed',
          paymentIntent({
            status: 'requires_payment_method',
            last_payment_error: {
              code: 'card_declined',
              decline_code: 'generic_decline',
              message: 'Your card was declined.',
            },
          }),
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // The failure transition is a CAS: only a pending attempt may become
      // failed, so a concurrent success can never be regressed.
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'pending' },
        data: expect.objectContaining({
          status: 'failed',
          failedAt: expect.any(Date),
          failureCode: 'card_declined',
          failureMessage: 'Your card was declined.',
        }),
      });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('keeps the attempt pending on payment_intent.processing', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.processing', paymentIntent({ status: 'processing' })),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('marks the attempt failed on checkout.session.async_payment_failed', async () => {
      constructEventAsync.mockResolvedValue(
        event('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' })),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-1', status: 'pending' },
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('marks the attempt succeeded on checkout.session.async_payment_succeeded', async () => {
      constructEventAsync.mockResolvedValue(
        event('checkout.session.async_payment_succeeded', session({ payment_status: 'paid' })),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(invoiceUpdateMany).toHaveBeenCalled();
    });

    it('rejects a fixed-fee attempt completed with a payment-mode Checkout', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'checkout.session.completed',
          session({ payment_status: 'paid', mode: 'payment' }),
          'evt_mode_mismatch',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(
        attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
      );

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });

    it.each([
      [
        'full attempt completed with a subscription-mode Checkout',
        { mode: 'subscription', subscription: 'sub_123' },
        {},
      ],
      ['full attempt completed with a setup-mode Checkout', { mode: 'setup' }, {}],
      [
        'fixed-fee attempt completed with a setup-mode Checkout',
        { mode: 'setup' },
        { stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' },
      ],
    ])('rejects %s without settlement', async (_label, sessionOverrides, attemptOverrides) => {
      constructEventAsync.mockResolvedValue(
        event(
          'checkout.session.completed',
          session({ payment_status: 'paid', ...sessionOverrides }),
          'evt_mode_reject',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow(attemptOverrides));

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });
  });

  describe('idempotency and ordering', () => {
    it('does not double-apply a duplicate event id', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_dup'),
      );
      webhookEventCreate.mockRejectedValueOnce(p2002());

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('handles PaymentIntent-before-Checkout ordering: PI success then checkout completion is a no-op', async () => {
      // First delivery: payment_intent.succeeded marks the attempt succeeded
      // and settles the invoice (first rail wins).
      constructEventAsync.mockResolvedValueOnce(
        event('payment_intent.succeeded', paymentIntent(), 'evt_pi'),
      );
      webhookEventCreate.mockResolvedValueOnce({});
      attemptFindFirst.mockResolvedValueOnce(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 1 }); // increment + paid-marker CAS

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // Second delivery: checkout.session.completed arrives after the attempt
      // is already succeeded and the invoice is already settled — the attempt's
      // coverage is already allocated (replay), so the checkout completion is a
      // pure no-op and never overwrites or double-allocates the settlement.
      constructEventAsync.mockResolvedValueOnce(
        event('checkout.session.completed', session({ payment_status: 'paid' }), 'evt_cs'),
      );
      webhookEventCreate.mockResolvedValueOnce({});
      attemptFindFirst.mockResolvedValueOnce(
        attemptRow({
          status: 'succeeded',
          succeededAt: new Date('2026-06-01T00:00:00.000Z'),
          allocatedAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      );
      // The settlement re-reads the attempt under the row lock; it must see
      // the allocation recorded by the first delivery (idempotent replay).
      attemptFindUnique.mockResolvedValue(
        attemptRow({
          id: 'att-1',
          invoiceId: 'inv-1',
          status: 'succeeded',
          succeededAt: new Date('2026-06-01T00:00:00.000Z'),
          allocatedAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      );

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // The first (PI) delivery performed the settlement: the paid-marker CAS
      // ran exactly once and set paidAt/paidVia/pointer under the full guard.
      const paidCalls = invoiceUpdateMany.mock.calls.filter(
        (c) => (c[0].data as Record<string, unknown> | undefined)?.paidAt !== undefined,
      );
      expect(paidCalls).toHaveLength(1);
      expect(paidCalls[0][0].where).toEqual(casWhere('inv-1'));
      expect(paidCalls[0][0].data).toEqual(
        expect.objectContaining({ paidVia: 'stripe', settlementAttemptId: 'att-1' }),
      );
      // The second (checkout) delivery is an idempotent replay: no additional
      // paid-marker write, and the already-allocated coverage is never doubled.
      expect(
        invoiceUpdateMany.mock.calls.filter(
          (c) => (c[0].data as Record<string, unknown> | undefined)?.allocatedMicros !== undefined,
        ),
      ).toHaveLength(1);
    });

    it('rejects a succeeded event for a previously failed attempt', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_retry'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(
        attemptRow({
          status: 'failed',
          failedAt: new Date('2026-06-01T00:00:00.000Z'),
          failureCode: 'card_declined',
        }),
      );
      accountFindFirst.mockResolvedValue({
        id: 'acct-1',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        stripeSubscriptionUpdatedAt: null,
      });
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });

    it('never regresses a succeeded attempt on a later failure event', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.payment_failed',
          paymentIntent({ status: 'requires_payment_method' }),
          'evt_late_fail',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(
        attemptRow({
          status: 'succeeded',
          succeededAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      );

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('failure CAS cannot overwrite an attempt a concurrent success already committed', async () => {
      // The webhook read the attempt as pending (stale under Read Committed),
      // but a concurrent success delivery committed first. The failure
      // transition must be a CAS on status = 'pending' that matches zero rows —
      // the succeeded attempt and its settlement are never regressed.
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.payment_failed',
          paymentIntent({ status: 'requires_payment_method' }),
          'evt_cas_race',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow({ status: 'pending' }));
      attemptUpdateMany.mockResolvedValue({ count: 0 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'pending' },
        data: expect.objectContaining({ status: 'failed' }),
      });
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('does not let a stale success overwrite a failure committed after preflight', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.succeeded',
          paymentIntent({ status: 'succeeded' }),
          'evt_stale_success',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow({ status: 'pending' }));
      // The failure won after the success preflight read and before its CAS.
      attemptUpdateMany.mockResolvedValueOnce({ count: 0 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });

    it('success CAS rejects a conflicting stripeInvoiceId bound after preflight', async () => {
      // The renewal invoice id matched preflight, but by CAS time the attempt
      // was rebound to a different invoice — the success must not be applied.
      constructEventAsync.mockResolvedValue(
        event('invoice.paid', renewalInvoice({ status: 'paid' }), 'evt_inv_conflict'),
      );
      webhookEventCreate.mockResolvedValue({});
      accountFindFirst.mockResolvedValue({
        id: 'acct-1',
        userId: '00000000-0000-4000-8000-000000000001',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
        stripeSubscriptionUpdatedAt: null,
        activeSubscriptionPlanVersionId: 'plan-1',
      });
      accountFindUnique.mockResolvedValue({
        id: 'acct-1',
        userId: '00000000-0000-4000-8000-000000000001',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
        stripeSubscriptionUpdatedAt: null,
        activeSubscriptionPlanVersionId: 'plan-1',
      });
      attemptFindFirst.mockResolvedValue(
        attemptRow({
          stripeChargeKind: 'full',
          stripeInvoiceId: 'in_123',
        }),
      );
      invoiceFindUnique.mockResolvedValue(invoiceRow());
      attemptUpdateMany.mockResolvedValueOnce({ count: 0 }); // CAS misses
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // The success CAS now also carries the stripeInvoiceId null-or-same fence.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'pending',
            AND: expect.arrayContaining([
              { OR: [{ stripeInvoiceId: null }, { stripeInvoiceId: 'in_123' }] },
            ]),
          }),
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });

    it('marks a succeeded Stripe attempt duplicate_unallocated when another rail already settled the invoice', async () => {
      // A USDC attempt already settled the invoice (paidAt/paidVia/pointer set
      // by the USDC confirmation path). A later Stripe success must mark its
      // own attempt succeeded but must NOT overwrite the settlement, and the
      // succeeded Stripe attempt is recorded as duplicate/unallocated review.
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_dual_rail'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      // The guarded settlement update matches zero rows: the invoice is already
      // settled by the USDC rail.
      invoiceUpdateMany.mockResolvedValue({ count: 0 });
      invoiceFindUnique.mockResolvedValue(invoiceRow({ settlementAttemptId: 'att-usdc' }));

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // The Stripe attempt's own success fact is recorded...
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      // ...but the coverage-allocation boundary never overwrites the USDC win
      // (the already-settled invoice makes the allocation a no-op), and the
      // succeeded Stripe attempt is marked duplicate/unallocated review.
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdate).toHaveBeenLastCalledWith({
        where: { id: 'att-1' },
        data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
      });
    });

    it('does not mark duplicate when the settlement precondition fails (invoice unsettled/open)', async () => {
      // A settlement precondition failure (e.g. the local invoice is still
      // open) is a no-op — the succeeded Stripe attempt is not a duplicate and
      // must not be flagged. (A genuine CAS anomaly instead aborts the whole
      // webhook transaction, which is covered by the CAS-loss tests.)
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_no_dup'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 1 });
      invoiceFindUnique.mockResolvedValue(
        invoiceRow({ settlementAttemptId: null, status: 'open' }),
      );

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(attemptUpdate).not.toHaveBeenCalledWith({
        where: { id: 'att-1' },
        data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
      });
    });

    it('aborts the webhook transaction when the settlement CAS loses (rolls back the success, never half-committed)', async () => {
      // A coverage-increment CAS failure is a genuine anomaly under the row
      // locks: the whole webhook transaction must roll back (the succeeded CAS
      // included) and the failure must surface as a retryable error instead of
      // being silently treated as a successful replay.
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_cas_loss'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 0 });
      invoiceFindUnique.mockResolvedValue(invoiceRow({ settlementAttemptId: null }));

      await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig')).rejects.toThrow(
        'Stripe settlement CAS lost',
      );
      // The failure is not recorded as a success audit and the duplicate
      // review path never ran.
      expect(securityRecord).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalledWith({
        where: { id: 'att-1' },
        data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
      });
    });

    it('does not mark duplicate when the invoice was settled by this same attempt (idempotent replay)', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_own_replay'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 0 });
      invoiceFindUnique.mockResolvedValue(invoiceRow({ settlementAttemptId: 'att-1' }));

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdate).not.toHaveBeenCalledWith({
        where: { id: 'att-1' },
        data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
      });
    });

    it('records a legitimate event with no local attempt as ignored', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent({ id: 'pi_unknown' }), 'evt_orphan'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(null);

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
      );
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('propagates a DB processing error so Stripe retries (5xx)', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_db'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      attemptUpdateMany.mockRejectedValue(new Error('database unavailable'));

      await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig')).rejects.toThrow(
        'database unavailable',
      );
    });
  });

  describe('metadata and fallback lookup (out-of-order delivery)', () => {
    it('finds the attempt via metadata attemptId when the PaymentIntent id is not yet persisted and sets paidAt', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.succeeded',
          paymentIntent({
            id: 'pi_123',
            metadata: { attemptId: ATTEMPT_UUID, invoiceId: INVOICE_UUID },
          }),
          'evt_pi_meta',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      // Persisted-id lookup misses (PI id not yet stored); metadata attemptId hits.
      attemptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripePaymentIntentId: null,
        }),
      );
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenNthCalledWith(1, {
        where: { stripePaymentIntentId: 'pi_123', method: 'stripe' },
      });
      expect(attemptFindFirst).toHaveBeenNthCalledWith(2, {
        where: { id: ATTEMPT_UUID, method: 'stripe' },
      });
      // The actual PI id is persisted so later events match by id.
      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: ATTEMPT_UUID },
        data: { stripePaymentIntentId: 'pi_123' },
      });
      // And the attempt is marked succeeded with the invoice settled.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ATTEMPT_UUID, status: 'pending' }),
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: casWhere(INVOICE_UUID),
        data: expect.objectContaining({
          paidAt: expect.any(Date),
          paidVia: 'stripe',
          settlementAttemptId: ATTEMPT_UUID,
        }),
      });
    });

    it('finds the attempt via invoiceId metadata when attemptId is absent', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.succeeded',
          paymentIntent({
            id: 'pi_123',
            metadata: { invoiceId: INVOICE_UUID },
          }),
          'evt_pi_inv',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripePaymentIntentId: null,
        }),
      );
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenNthCalledWith(2, {
        where: { invoiceId: INVOICE_UUID, status: 'pending', method: 'stripe' },
        orderBy: { createdAt: 'desc' },
      });
      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: ATTEMPT_UUID },
        data: { stripePaymentIntentId: 'pi_123' },
      });
      expect(invoiceUpdateMany).toHaveBeenCalled();
    });

    it('finds the attempt via client_reference_id when the session id is not persisted', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'checkout.session.completed',
          session({
            id: 'cs_unknown',
            payment_status: 'paid',
            client_reference_id: INVOICE_UUID,
          }),
          'evt_cs_ref',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst
        .mockResolvedValueOnce(null) // by session id
        .mockResolvedValueOnce(
          attemptRow({
            id: ATTEMPT_UUID,
            invoiceId: INVOICE_UUID,
            stripeCheckoutSessionId: null,
          }),
        ); // by client_reference
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenNthCalledWith(2, {
        where: { invoiceId: INVOICE_UUID, status: 'pending', method: 'stripe' },
        orderBy: { createdAt: 'desc' },
      });
      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: ATTEMPT_UUID },
        data: { stripeCheckoutSessionId: 'cs_unknown' },
      });
      expect(invoiceUpdateMany).toHaveBeenCalled();
    });

    it('persists the PI id on processing but keeps the attempt pending', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.processing',
          paymentIntent({
            id: 'pi_123',
            status: 'processing',
            metadata: { attemptId: ATTEMPT_UUID, invoiceId: INVOICE_UUID },
          }),
          'evt_pi_proc',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripePaymentIntentId: null,
        }),
      );

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // Only the id persistence happens — no status change, no settlement.
      expect(attemptUpdate).toHaveBeenCalledTimes(1);
      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: ATTEMPT_UUID },
        data: { stripePaymentIntentId: 'pi_123' },
      });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('ignores an event whose metadata is malformed instead of failing with a 500', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.succeeded',
          paymentIntent({
            id: 'pi_123',
            metadata: { attemptId: 'not-a-uuid', invoiceId: 'also-not-a-uuid' },
          }),
          'evt_bad_meta',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(null); // persisted-id lookup misses

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
      );
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('cross-rail isolation (USDC attempts are never claimed by Stripe)', () => {
    it('never claims a USDC attempt via a persisted PaymentIntent id', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent({ id: 'pi_123' }), 'evt_cross_pi'),
      );
      webhookEventCreate.mockResolvedValue({});
      // A USDC attempt happens to carry the same PI id — the method filter must
      // exclude it, so every lookup misses and the event is recorded as ignored.
      attemptFindFirst.mockResolvedValue(null);

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_123', method: 'stripe' },
      });
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('never claims a USDC attempt via a persisted Checkout Session id', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'checkout.session.completed',
          session({ id: 'cs_123', payment_status: 'paid' }),
          'evt_cross_cs',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(null);

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenCalledWith({
        where: { stripeCheckoutSessionId: 'cs_123', method: 'stripe' },
      });
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('never claims a USDC attempt via metadata attemptId', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.succeeded',
          paymentIntent({
            id: 'pi_123',
            metadata: { attemptId: ATTEMPT_UUID, invoiceId: INVOICE_UUID },
          }),
          'evt_cross_meta',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(null);

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenNthCalledWith(1, {
        where: { stripePaymentIntentId: 'pi_123', method: 'stripe' },
      });
      expect(attemptFindFirst).toHaveBeenNthCalledWith(2, {
        where: { id: ATTEMPT_UUID, method: 'stripe' },
      });
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('never claims a USDC pending attempt via the invoiceId metadata fallback', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'payment_intent.succeeded',
          paymentIntent({
            id: 'pi_123',
            metadata: { invoiceId: INVOICE_UUID },
          }),
          'evt_cross_inv',
        ),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(null);

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).toHaveBeenNthCalledWith(2, {
        where: { invoiceId: INVOICE_UUID, status: 'pending', method: 'stripe' },
        orderBy: { createdAt: 'desc' },
      });
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('subscription renewal events (Phase 1 worker foundation)', () => {
    it('defers an unmatched renewal invoice.paid event for bounded retry (never silently ignored)', async () => {
      constructEventAsync.mockResolvedValue(
        event('invoice.paid', { id: 'in_123', subscription: 'sub_123' }, 'evt_renewal'),
      );
      webhookEventCreate.mockResolvedValue({});
      // No local attempt/invoice exists yet (out-of-order delivery).
      attemptFindFirst.mockResolvedValue(null);
      webhookEventFindUnique.mockResolvedValue(null);

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
      );
      expect(webhookEventUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('marks deferred retry exhausted as needs_review after the bounded retry budget', async () => {
      constructEventAsync.mockResolvedValue(
        event('invoice.paid', { id: 'in_123', subscription: 'sub_123' }, 'evt_renewal'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(null);
      // A prior retry already bumped retryCount past the max budget.
      webhookEventFindUnique.mockResolvedValue({ retryCount: 5 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
      );
      expect(webhookEventUpdate).not.toHaveBeenCalled();
    });

    it('re-processes a deferred event once the local renewal invoice appears', async () => {
      // First delivery deferred the event (no local match). The worker retries
      // by re-fetching; the event id already exists as `deferred`, and
      // the now-existing local attempt is found and processed.
      constructEventAsync.mockResolvedValue(event('invoice.paid', renewalInvoice(), 'evt_renewal'));
      webhookEventFindUnique.mockResolvedValue({ status: 'deferred', retryCount: 2 });
      attemptFindFirst.mockResolvedValue(
        attemptRow({
          stripeChargeKind: 'fixed_fee',
          stripeSubscriptionId: 'sub_123',
        }),
      );
      invoiceFindUnique.mockResolvedValue(invoiceRow());
      invoiceUpdateMany.mockResolvedValue({ count: 1 }); // exact-match CAS succeeds

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(webhookEventCreateMany).not.toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
    });

      it('never settles a dynamic invoice with a smaller fixed recurring charge', async () => {
      constructEventAsync.mockResolvedValue(event('invoice.paid', renewalInvoice(), 'evt_renewal'));
      webhookEventCreate.mockResolvedValue({});
      // The renewal attempt charges only the fixed plan fee ($49).
      attemptFindFirst.mockResolvedValue(
        attemptRow({
          stripeChargeKind: 'fixed_fee',
          stripeSubscriptionId: 'sub_123',
          amountMicros: 49_000_000n,
        }),
      );
      // The local invoice carries dynamic overage on top of the fixed fee.
      invoiceFindUnique.mockResolvedValue({
        ...invoiceRow(),
        totalMicros: 99_000_000n,
        settlementAttemptId: null,
      });
      invoiceUpdateMany.mockResolvedValue({ count: 1 }); // coverage-increment CAS wins

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // The fixed recurring charge allocates partial coverage (49 of 99) but
      // NEVER marks the dynamic invoice paid — the separately-payable overage
      // remainder (50) stays outstanding and is collected by the overage
      // worker instead of being faked away.
      expect(
        invoiceUpdateMany.mock.calls.some(
          ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
        ),
      ).toBe(false);
      // The legitimate partial allocation is NOT demoted to
      // fixed_fee_partial_balance / needs_review.
      expect(
        attemptUpdateMany.mock.calls.some(
          ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.status === 'needs_review',
        ),
      ).toBe(false);
    });

    describe('renewal materialization and provider-fact validation (Gate 1 remediation)', () => {
      // A subscription account with a proven active plan version.
      function renewalAccount() {
        return {
          id: 'acct-1',
          userId: '00000000-0000-4000-8000-000000000001',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          stripeSubscriptionStatus: 'active',
          // Mirror period must match the renewal invoice month for fallback identity.
          stripeSubscriptionPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        };
      }

      function fixedFeePlan() {
        return {
          id: 'plan-1',
          code: 'pro',
          version: 2,
          name: 'Pro',
          monthlyFeeMicros: 49_000_000n,
          includedOutboundMicros: 100_000_000n,
          includedApiCalls: 100_000n,
          includedWallets: 1,
        };
      }

      beforeEach(() => {
        webhookEventCreate.mockResolvedValue({});
        // invoice.created/finalized events resolve the account via the
        // subscription mirror (no metadata userId on renewal invoices).
        accountFindFirst.mockResolvedValue(renewalAccount());
        accountFindUnique.mockResolvedValue(renewalAccount());
        planVersionFindUnique.mockResolvedValue(fixedFeePlan());
        attemptCreate.mockResolvedValue({
          id: 'att-renewal',
          invoiceId: 'inv-renew',
          method: 'stripe',
        });
      });

      it('accepts a matched real Invoice without Checkout amount_total', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.created', renewalInvoice({ status: 'open' }), 'evt_matched_invoice'),
        );
        attemptFindFirst.mockResolvedValue(
          attemptRow({ stripeInvoiceId: 'in_123', stripeChargeKind: 'full' }),
        );
        invoiceFindUnique.mockResolvedValue(invoiceRow({ status: 'open' }));

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'processed' }) }),
        );
        expect(attemptUpdate).not.toHaveBeenCalled();
      });

      it('materializes the local renewal invoice and fixed-fee attempt exactly once', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.finalized', renewalInvoice(), 'evt_materialize'),
        );
        // No attempt/invoice exists locally yet (out-of-order delivery).
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindUnique.mockResolvedValue(null);
        invoiceFindFirst.mockResolvedValue(null);
        invoiceCreate.mockResolvedValue({
          id: 'inv-renew',
          billingAccountId: 'acct-1',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          periodEnd: new Date('2026-09-01T00:00:00.000Z'),
          status: 'finalized',
          totalMicros: 49_000_000n,
          currency: 'USD',
          stripeInvoiceId: 'in_123',
        });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The renewal invoice is created as a fixed-only open invoice and the
        // fixed-fee attempt is bound to it exactly once via the unique Stripe
        // invoice mapping.
        expect(invoiceCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              billingAccountId: 'acct-1',
              planVersionId: 'plan-1',
              periodStart: new Date('2026-08-01T00:00:00.000Z'),
              periodEnd: new Date('2026-09-01T00:00:00.000Z'),
              status: 'open',
              totalMicros: 49_000_000n,
              stripeInvoiceId: 'in_123',
            }),
          }),
        );
        expect(attemptCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              invoiceId: 'inv-renew',
              method: 'stripe',
              status: 'pending',
              amountMicros: 49_000_000n,
              currency: 'USD',
              stripeInvoiceId: 'in_123',
              stripeSubscriptionId: 'sub_123',
              stripeChargeKind: 'fixed_fee',
            }),
          }),
        );
      });

      it('replays the same Stripe invoice id without creating a second attempt', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.created', renewalInvoice(), 'evt_replay_2'),
        );
        // A prior delivery already materialized the attempt for in_123.
        attemptFindFirst.mockResolvedValue(
          attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
        );
        invoiceFindUnique.mockResolvedValue(invoiceRow({ status: 'finalized' }));
        invoiceUpdateMany.mockResolvedValue({ count: 1 });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // No duplicate attempt is created (the materializer short-circuits on
        // the unique stripeInvoiceId mapping) is not enough by itself: replay
        // proof is mandatory and an incomplete fixture is durably reviewed.
        expect(attemptCreate).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'needs_review' }),
          }),
        );
      });

      it('never attaches a fixed-fee attempt to a dynamic-overage local invoice', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.finalized', renewalInvoice(), 'evt_dynamic'),
        );
        attemptFindFirst.mockResolvedValue(null);
        // The local open invoice for the period carries dynamic overage.
        invoiceFindUnique.mockResolvedValue({
          id: 'inv-dynamic',
          billingAccountId: 'acct-1',
          status: 'open',
          totalMicros: 99_000_000n,
          currency: 'USD',
        });
        invoiceFindFirst.mockResolvedValue({
          id: 'inv-dynamic',
          billingAccountId: 'acct-1',
          status: 'open',
          totalMicros: 99_000_000n,
          currency: 'USD',
          planVersionId: 'plan-1',
          stripeInvoiceId: null,
          paidAt: null,
          settlementAttemptId: null,
          allocatedMicros: 0n,
          purpose: 'usage_period',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          periodEnd: new Date('2026-09-01T00:00:00.000Z'),
        });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // Fail closed: no fixed-fee attempt is materialized against the dynamic
        // invoice, and the unmatched event is deferred (never ignored, never a
        // false settlement).
        expect(attemptCreate).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalled();
        expect(webhookEventUpdate).not.toHaveBeenCalled();
      });

      it('uses September sync effective start for October renewal (not expected window)', async () => {
        // Provider renewal for Oct 2026; Sep plan-change sync stored effective Oct.
        const octStart = Math.floor(new Date('2026-10-01T00:00:00.000Z').getTime() / 1000);
        const octEnd = Math.floor(new Date('2026-11-01T00:00:00.000Z').getTime() / 1000);
        constructEventAsync.mockResolvedValue(
          event(
            'invoice.finalized',
            renewalInvoice({
              period_start: octStart,
              period_end: octEnd,
              amount_paid: 19900,
              total: 19900,
            }),
            'evt_oct_from_sep_sync',
          ),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindFirst.mockResolvedValue(null);
        // Stale mirror still shows prior month / prior plan — must not win.
        accountFindFirst.mockResolvedValue({
          ...renewalAccount(),
          activeSubscriptionPlanVersionId: 'plan-starter-stale',
          stripeSubscriptionPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
        });
        accountFindUnique.mockResolvedValue({
          ...renewalAccount(),
          activeSubscriptionPlanVersionId: 'plan-starter-stale',
          stripeSubscriptionPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
        });
        syncIntentFindMany.mockResolvedValue([
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-growth',
            targetUnitAmountCents: 19900,
            revision: 3,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          },
        ]);
        planVersionFindUnique.mockResolvedValue({
          ...fixedFeePlan(),
          id: 'plan-growth',
          code: 'growth',
          name: 'Growth',
          monthlyFeeMicros: 199_000_000n,
        });
        invoiceCreate.mockResolvedValue({
          id: 'inv-oct',
          billingAccountId: 'acct-1',
          planVersionId: 'plan-growth',
          status: 'open',
          totalMicros: 199_000_000n,
        });
        attemptCreate.mockResolvedValue({ id: 'att-oct', invoiceId: 'inv-oct' });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(syncIntentFindMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              effectivePeriodStart: { lte: new Date('2026-10-01T00:00:00.000Z') },
            }),
            orderBy: { revision: 'desc' },
          }),
        );
        expect(invoiceCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              planVersionId: 'plan-growth',
              totalMicros: 199_000_000n,
            }),
          }),
        );
      });

      it('carries September Growth sync forward to November without a new intent', async () => {
        const novStart = Math.floor(new Date('2026-11-01T00:00:00.000Z').getTime() / 1000);
        const novEnd = Math.floor(new Date('2026-12-01T00:00:00.000Z').getTime() / 1000);
        constructEventAsync.mockResolvedValue(
          event(
            'invoice.finalized',
            renewalInvoice({
              period_start: novStart,
              period_end: novEnd,
              amount_paid: 19900,
              total: 19900,
            }),
            'evt_nov_carry_forward',
          ),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindFirst.mockResolvedValue(null);
        accountFindFirst.mockResolvedValue({
          ...renewalAccount(),
          activeSubscriptionPlanVersionId: 'plan-starter-stale',
          stripeSubscriptionPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
        });
        accountFindUnique.mockResolvedValue({
          ...renewalAccount(),
          activeSubscriptionPlanVersionId: 'plan-starter-stale',
          stripeSubscriptionPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
        });
        // Only Oct-effective Growth row — no November-specific intent.
        syncIntentFindMany.mockResolvedValue([
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-growth',
            targetUnitAmountCents: 19900,
            revision: 3,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          },
        ]);
        planVersionFindUnique.mockResolvedValue({
          ...fixedFeePlan(),
          id: 'plan-growth',
          code: 'growth',
          name: 'Growth',
          monthlyFeeMicros: 199_000_000n,
        });
        invoiceCreate.mockResolvedValue({
          id: 'inv-nov',
          billingAccountId: 'acct-1',
          planVersionId: 'plan-growth',
          status: 'open',
          totalMicros: 199_000_000n,
        });
        attemptCreate.mockResolvedValue({ id: 'att-nov', invoiceId: 'inv-nov' });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(invoiceCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              planVersionId: 'plan-growth',
              totalMicros: 199_000_000n,
              periodStart: new Date('2026-11-01T00:00:00.000Z'),
            }),
          }),
        );
      });

      it('later cancel_at_period_end revision wins over older paid update for the period', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.finalized', renewalInvoice(), 'evt_cancel_wins'),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindFirst.mockResolvedValue(null);
        // Highest revision is cancel — paid update must not materialize.
        syncIntentFindMany.mockResolvedValue([
          {
            kind: 'cancel_at_period_end',
            targetPlanVersionId: null,
            targetUnitAmountCents: null,
            revision: 5,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-08-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
          },
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-1',
            targetUnitAmountCents: 4900,
            revision: 3,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-08-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]);

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptCreate).not.toHaveBeenCalled();
        expect(invoiceCreate).not.toHaveBeenCalled();
      });

      it('carried-forward cancel blocks older paid update for following months', async () => {
        const novStart = Math.floor(new Date('2026-11-01T00:00:00.000Z').getTime() / 1000);
        const novEnd = Math.floor(new Date('2026-12-01T00:00:00.000Z').getTime() / 1000);
        constructEventAsync.mockResolvedValue(
          event(
            'invoice.finalized',
            renewalInvoice({
              period_start: novStart,
              period_end: novEnd,
              amount_paid: 4900,
              total: 4900,
            }),
            'evt_nov_cancel_carry',
          ),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindFirst.mockResolvedValue(null);
        // r5 cancel effective Oct carries into Nov; older Growth must not win.
        syncIntentFindMany.mockResolvedValue([
          {
            kind: 'cancel_at_period_end',
            targetPlanVersionId: null,
            revision: 5,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          },
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-growth',
            targetUnitAmountCents: 19900,
            revision: 3,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          },
        ]);

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptCreate).not.toHaveBeenCalled();
        expect(invoiceCreate).not.toHaveBeenCalled();
      });

      it('does not let a lower revision roll back a newer carried-forward config', async () => {
        const novStart = Math.floor(new Date('2026-11-01T00:00:00.000Z').getTime() / 1000);
        const novEnd = Math.floor(new Date('2026-12-01T00:00:00.000Z').getTime() / 1000);
        constructEventAsync.mockResolvedValue(
          event(
            'invoice.finalized',
            renewalInvoice({
              period_start: novStart,
              period_end: novEnd,
              amount_paid: 19900,
              total: 19900,
            }),
            'evt_nov_revision_order',
          ),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindFirst.mockResolvedValue(null);
        // Returned desc: r4 Growth must beat r2 Starter.
        syncIntentFindMany.mockResolvedValue([
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-growth',
            targetUnitAmountCents: 19900,
            revision: 4,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          },
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-1',
            targetUnitAmountCents: 4900,
            revision: 2,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
          },
        ]);
        planVersionFindUnique.mockResolvedValue({
          ...fixedFeePlan(),
          id: 'plan-growth',
          code: 'growth',
          name: 'Growth',
          monthlyFeeMicros: 199_000_000n,
        });
        invoiceCreate.mockResolvedValue({ id: 'inv-nov', planVersionId: 'plan-growth' });
        attemptCreate.mockResolvedValue({ id: 'att-nov' });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(invoiceCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ planVersionId: 'plan-growth' }),
          }),
        );
      });

      it('adopts worker-first open Free estimate when later paid fixed_fee webhook arrives', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.finalized', renewalInvoice(), 'evt_adopt_free'),
        );
        attemptFindFirst.mockResolvedValue(null);
        const freeEstimate = {
          id: 'inv-worker-free',
          billingAccountId: 'acct-1',
          planVersionId: 'plan-free',
          purpose: 'usage_period',
          status: 'open',
          currency: 'USD',
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          periodEnd: new Date('2026-09-01T00:00:00.000Z'),
          totalMicros: 0n,
          monthlyFeeMicros: 0n,
          stripeInvoiceId: null,
          paidAt: null,
          settlementAttemptId: null,
          allocatedMicros: 0n,
          lines: [],
        };
        invoiceFindFirst.mockResolvedValue(freeEstimate);
        // Sync history proves paid plan for this renewal month.
        syncIntentFindMany.mockResolvedValue([
          {
            kind: 'update_item',
            targetPlanVersionId: 'plan-1',
            targetUnitAmountCents: 4900,
            revision: 2,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
            effectivePeriodStart: new Date('2026-08-01T00:00:00.000Z'),
            expectedPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
            expectedPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]);
        planVersionFindUnique.mockResolvedValue(fixedFeePlan());
        invoiceUpdateMany.mockResolvedValue({ count: 1 });
        invoiceFindUnique.mockResolvedValue({
          ...freeEstimate,
          planVersionId: 'plan-1',
          totalMicros: 49_000_000n,
          monthlyFeeMicros: 49_000_000n,
          stripeInvoiceId: 'in_123',
          lines: [{ lineType: 'monthly_fee', quantity: 1n, amountMicros: 49_000_000n }],
        });
        attemptCreate.mockResolvedValue({
          id: 'att-adopt',
          invoiceId: 'inv-worker-free',
          method: 'stripe',
        });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(invoiceUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'inv-worker-free',
              status: 'open',
              stripeInvoiceId: null,
            }),
            data: expect.objectContaining({
              planVersionId: 'plan-1',
              totalMicros: 49_000_000n,
              stripeInvoiceId: 'in_123',
            }),
          }),
        );
        expect(invoiceLineDeleteMany).toHaveBeenCalled();
        expect(invoiceLineCreateMany).toHaveBeenCalled();
        expect(attemptCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              invoiceId: 'inv-worker-free',
              amountMicros: 49_000_000n,
              stripeChargeKind: 'fixed_fee',
            }),
          }),
        );
        expect(invoiceCreate).not.toHaveBeenCalled();
      });

      it('deferrals eventually exhaust into needs_review (never silently dropped)', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.finalized', renewalInvoice(), 'evt_exhaust'),
        );
        // The account is not resolvable (no metadata, no mirror) so the event
        // cannot be materialized — it is deferred.
        accountFindFirst.mockResolvedValue(null);
        attemptFindFirst.mockResolvedValue(null);
        // The bounded retry budget is already exhausted.
        webhookEventFindUnique.mockResolvedValue({ status: 'deferred', retryCount: 5 });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(webhookEventUpdate).not.toHaveBeenCalled();
      });

      it('rejects a success event whose provider amount does not match the attempt', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.paid', renewalInvoice({ amount_paid: 9900 }), 'evt_overpay'),
        );
        attemptFindFirst.mockResolvedValue(
          attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
        );
        invoiceFindUnique.mockResolvedValue(invoiceRow());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // Overpayment is rejected without settling: the attempt goes to
        // needs_review, never succeeded.
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('never materializes a renewal from a non-exact UTC period (mid-month interval defers)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'invoice.created',
            renewalInvoice({
              period_start: 1_787_407_200,
              period_end: 1_789_999_200, // 2026-08-15 → 2026-09-15 (not a month boundary)
            }),
            'evt_midmonth',
          ),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindUnique.mockResolvedValue(null);

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // Fail closed: no local invoice/attempt is created for a partial
        // interval, and the event stays deferred (never silently fabricated).
        expect(invoiceCreate).not.toHaveBeenCalled();
        expect(attemptCreate).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
        expect(webhookEventUpdate).not.toHaveBeenCalled();
      });

      it('never materializes a renewal whose provider total does not equal the fixed fee', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.created', renewalInvoice({ total: 9900 }), 'evt_wrong_amt'),
        );
        attemptFindFirst.mockResolvedValue(null);
        invoiceFindUnique.mockResolvedValue(null);

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(invoiceCreate).not.toHaveBeenCalled();
        expect(attemptCreate).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
        expect(webhookEventUpdate).not.toHaveBeenCalled();
      });

      it('rejects a success event with a wrong currency without settling', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.paid', renewalInvoice({ currency: 'eur' }), 'evt_currency'),
        );
        attemptFindFirst.mockResolvedValue(
          attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
        );
        invoiceFindUnique.mockResolvedValue(invoiceRow());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('rejects a success event whose customer does not match the account mirror', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.paid', renewalInvoice({ customer: 'cus_other' }), 'evt_customer'),
        );
        attemptFindFirst.mockResolvedValue(
          attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
        );
        invoiceFindUnique.mockResolvedValue(invoiceRow());
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          stripeCustomerId: 'cus_123',
        });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('rejects a success event whose subscription does not match the fixed-fee attempt', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.paid', renewalInvoice({ subscription: 'sub_other' }), 'evt_sub'),
        );
        attemptFindFirst.mockResolvedValue(
          attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
        );
        invoiceFindUnique.mockResolvedValue(invoiceRow());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(webhookEventUpdate).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('updates the subscription mirror from customer.subscription.created even before any attempt exists', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'customer.subscription.created',
            {
              id: 'sub_123',
              status: 'active',
              current_period_start: 1_784_764_800,
              current_period_end: 1_787_356_800,
              customer: 'cus_123',
              metadata: { userId: '00000000-0000-4000-8000-000000000001' },
            },
            'evt_sub_created',
          ),
        );
        // No local attempt exists for a freshly created subscription.
        attemptFindFirst.mockResolvedValue(null);
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: null,
          stripeSubscriptionUpdatedAt: null,
        });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The mirror is updated from validated metadata even with no attempt.
        expect(accountUpdate).toHaveBeenCalledWith({
          where: { id: 'acct-1' },
          data: expect.objectContaining({
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionStatus: 'active',
            stripeSubscriptionPeriodStart: new Date(1_784_764_800 * 1000),
            stripeSubscriptionPeriodEnd: new Date(1_787_356_800 * 1000),
          }),
        });
        expect(webhookEventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
          where: expect.objectContaining({ status: 'processed' }),
          data: expect.objectContaining({ processedAt: expect.any(Date) }),
        }));
        expect(webhookEventUpdateMany.mock.calls.some(([args]) => args.data?.status === 'deferred')).toBe(false);
      });

      it('completes an existing deferred lifecycle row under its lease and clears retry ownership', async () => {
        const retryLeaseExpiresAt = new Date(Date.now() + 60_000);
        const lifecycleEvent = event('customer.subscription.updated', {
          id: 'sub_123',
          status: 'active',
          current_period_start: 1_784_764_800,
          current_period_end: 1_787_356_800,
          customer: 'cus_123',
        }, 'evt_sub_deferred');
        webhookEventFindUnique.mockResolvedValue({
          status: 'deferred', retryOwnerId: 'worker-1', retryLeaseExpiresAt,
          retryCount: 1, nextRetryAt: new Date(),
        });
        attemptFindFirst.mockResolvedValue(null);
        accountFindUnique.mockResolvedValue({
          id: 'acct-1', userId: 'user-1', stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123', stripeSubscriptionStatus: 'active',
          stripeSubscriptionUpdatedAt: null, stripeSubscriptionEventId: null,
        });

        await expect(service.processEvent(lifecycleEvent, { ownerId: 'worker-1' })).resolves.toBe('processed');

        expect(webhookEventCreateMany).not.toHaveBeenCalled();
        expect(webhookEventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
          where: expect.objectContaining({
            stripeEventId: 'evt_sub_deferred', status: 'deferred', retryOwnerId: 'worker-1',
            retryLeaseExpiresAt: expect.objectContaining({ gt: expect.any(Date) }),
          }),
          data: expect.objectContaining({
            status: 'processed', nextRetryAt: null, retryOwnerId: null, retryLeaseExpiresAt: null,
          }),
        }));
      });
    });

    describe('audit outbox (Gate 1 remediation)', () => {
      it('never emits a success audit when the business transaction rolls back', async () => {
        constructEventAsync.mockResolvedValue(event('checkout.session.completed', session()));
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(attemptRow());
        // The settlement CAS fails AND the attempt update for the lost race
        // throws, rolling the whole transaction back.
        invoiceUpdateMany.mockResolvedValue({ count: 0 });
        attemptUpdateMany.mockRejectedValue(new Error('db error'));

        await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig')).rejects.toThrow(
          'db error',
        );

        // No audit intent is emitted for a transition that never committed.
        expect(securityRecord).not.toHaveBeenCalled();
      });

      it('audit/notification failure never rolls back an already-settled payment', async () => {
        constructEventAsync.mockResolvedValue(event('checkout.session.completed', session()));
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(attemptRow());
        invoiceUpdateMany.mockResolvedValue({ count: 1 }); // settlement CAS succeeds
        securityRecord.mockRejectedValue(new Error('SIEM timeout'));

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The invoice is settled and the webhook answers 2xx despite the audit
        // exporter failure.
        expect(
          invoiceUpdateMany.mock.calls.some(
            ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
          ),
        ).toBe(true);
        expect(securityRecord).toHaveBeenCalled();
      });
    });

    describe('Stripe identity hardening (Gate 1 remediation round 2)', () => {
      it('never binds/overwrites a subscription from metadata userId when the account has no matching mirror', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'customer.subscription.created',
            {
              id: 'sub_999',
              status: 'active',
              current_period_start: 1_784_764_800,
              current_period_end: 1_787_356_800,
              customer: 'cus_999',
              metadata: { userId: '00000000-0000-4000-8000-000000000001' },
            },
            'evt_unproven',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(null);
        // The metadata userId resolves to an account, but that account has NO
        // Stripe mirror at all — metadata alone must never bind it.
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: null,
          stripeSubscriptionUpdatedAt: null,
        });
        accountFindFirst.mockResolvedValue(null);

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // No mirror write happened (cannot be proven), and the event is deferred
        // for bounded retry — never silently bound.
        expect(accountUpdate).not.toHaveBeenCalled();
        expect(webhookEventUpdate).not.toHaveBeenCalled();
      });

      it('rejects a metadata attemptId/invoiceId disagreement before mutating anything', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.succeeded',
            paymentIntent({
              id: 'pi_123',
              metadata: {
                attemptId: ATTEMPT_UUID,
                invoiceId: '33333333-3333-4333-8333-333333333333',
              },
            }),
            'evt_conflict',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        // Persisted-id lookup misses; metadata attemptId resolves to an attempt
        // whose invoiceId DIFFERS from the metadata invoiceId.
        attemptFindFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(attemptRow({ id: ATTEMPT_UUID, invoiceId: INVOICE_UUID }));
        invoiceUpdateMany.mockResolvedValue({ count: 1 });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The event is recorded for manual review; nothing is mutated/settled.
        expect(webhookEventUpdate).not.toHaveBeenCalled();
        expect(attemptUpdate).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        expect(securityRecord).not.toHaveBeenCalled();
      });

      it('rejects a forged failure event with a mismatched metadata user before any write', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.payment_failed',
            paymentIntent({ metadata: { userId: '33333333-3333-4333-8333-333333333333' } }),
            'evt_failure_identity_conflict',
          ),
        );
        attemptFindFirst.mockResolvedValue(attemptRow());
        invoiceFindUnique.mockResolvedValue(invoiceRow());
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: '11111111-1111-4111-8111-111111111111',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: null,
        });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
        expect(webhookEventUpdate).not.toHaveBeenCalled();
        expect(attemptUpdate).not.toHaveBeenCalled();
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });
    });
    describe('renewal overage webhook transitions', () => {
      const overageAttempt = (overrides: Record<string, unknown> = {}) =>
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripeChargeKind: 'overage',
          stripePaymentIntentId: 'pi_ov',
          amountMicros: 60_000_000n,
          ...overrides,
        });
      const overageInvoice = (overrides: Record<string, unknown> = {}) =>
        invoiceRow({
          id: INVOICE_UUID,
          totalMicros: 109_000_000n,
          allocatedMicros: 49_000_000n,
          ...overrides,
        });
      const overageIntent = (overrides: Record<string, unknown> = {}) =>
        paymentIntent({
          id: 'pi_ov',
          amount: 6000,
          amount_received: 6000,
          metadata: {
            invoiceId: INVOICE_UUID,
            attemptId: ATTEMPT_UUID,
            period: '2026-08',
            chargeKind: 'overage',
          },
          ...overrides,
        });

      it('allocates the overage remainder and marks the invoice paid on payment_intent.succeeded', async () => {
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', overageIntent(), 'evt_overage_paid'),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());
        // The settlement re-reads the attempt and invoice under the row lock.
        attemptFindUnique.mockResolvedValue(overageAttempt({ status: 'succeeded' }));
        invoiceFindUnique.mockResolvedValue(overageInvoice());
        invoiceUpdateMany.mockResolvedValue({ count: 1 });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The overage attempt is marked succeeded (forward-only CAS).
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: ATTEMPT_UUID, status: 'pending' }),
            data: expect.objectContaining({ status: 'succeeded' }),
          }),
        );
        // The coverage-allocation boundary tops the invoice up: 49 (fixed fee)
        // + 60 (overage) = 109 → the paid markers are set by the overage attempt.
        const paidCalls = invoiceUpdateMany.mock.calls.filter(
          (c) => (c[0].data as Record<string, unknown> | undefined)?.paidAt !== undefined,
        );
        expect(paidCalls).toHaveLength(1);
        expect(paidCalls[0][0].where).toEqual(
          expect.objectContaining({ id: INVOICE_UUID, allocatedMicros: 109_000_000n }),
        );
        expect(paidCalls[0][0].data).toEqual(
          expect.objectContaining({ paidVia: 'stripe', settlementAttemptId: ATTEMPT_UUID }),
        );
      });

      it('keeps the overage attempt pending on payment_intent.processing (never fake success)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.processing',
            overageIntent({ status: 'processing' }),
            'evt_overage_proc',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdate).not.toHaveBeenCalled();
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('marks the overage attempt failed on payment_intent.payment_failed and never touches the invoice', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.payment_failed',
            overageIntent({
              status: 'requires_payment_method',
              last_payment_error: {
                code: 'authentication_required',
                message: 'Card requires authentication',
              },
            }),
            'evt_overage_failed',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // Failure is a pending-only CAS: the attempt fails, the invoice stays
        // unpaid and no coverage is fabricated.
        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({
            status: 'failed',
            failureCode: 'authentication_required',
          }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        // A later success must not resurrect this failed attempt.
        expect(attemptUpdate).not.toHaveBeenCalled();
      });

      it('marks a canceled PaymentIntent failed (never pending forever, never fake success)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.canceled',
            overageIntent({ status: 'canceled' }),
            'evt_overage_canceled',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The canceled event maps to a forward-only failure: the attempt fails,
        // the invoice stays unpaid, and the state is recoverable/reviewable.
        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({ status: 'failed' }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('fails closed on a requires_action payment_intent.payment_failed (SCA surfaced as failed, not pending forever)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.payment_failed',
            overageIntent({ status: 'requires_action' }),
            'evt_overage_sca',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({ status: 'failed' }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        // Never a fabricated success.
        expect(
          invoiceUpdateMany.mock.calls.some(
            ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
          ),
        ).toBe(false);
      });

      it('rejects an overage event whose provider amount does not match the persisted remainder', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.succeeded',
            overageIntent({ amount_received: 9999 }),
            'evt_overage_wrong',
          ),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // Provider-fact mismatch fails closed: no success transition, no
        // settlement, no paidAt.
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        expect(
          invoiceUpdateMany.mock.calls.some(
            ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
          ),
        ).toBe(false);
      });

      it('records an overage event on an already-paid invoice as duplicate/unallocated review', async () => {
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', overageIntent(), 'evt_overage_dup'),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(overageAttempt());
        attemptFindUnique.mockResolvedValue(overageAttempt({ status: 'succeeded' }));
        // The invoice was already paid by a different rail.
        invoiceFindUnique.mockResolvedValue(
          overageInvoice({
            paidAt: new Date('2026-08-10T00:00:00.000Z'),
            settlementAttemptId: 'att-other',
            allocatedMicros: 109_000_000n,
          }),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The paid invoice is never overwritten; the overage success is surfaced
        // as duplicate/unallocated review instead of a fake settlement.
        expect(attemptUpdate).toHaveBeenLastCalledWith({
          where: { id: ATTEMPT_UUID },
          data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
        });
        expect(
          invoiceUpdateMany.mock.calls.some(
            ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
          ),
        ).toBe(false);
      });
    });

    describe('fixed-fee PaymentIntent webhook identity (invoice-based renewal proof)', () => {
      // Stripe PaymentIntents carry `invoice`, not `subscription`. A fixed-fee
      // renewal is proven from the PERSISTED account subscription mirror + the
      // Stripe invoice identity.
      const fixedFeeRenewalAttempt = (overrides: Record<string, unknown> = {}) =>
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripeChargeKind: 'fixed_fee',
          stripeSubscriptionId: 'sub_123',
          stripeInvoiceId: 'in_123',
          stripePaymentIntentId: 'pi_123',
          ...overrides,
        });
      const fixedFeeInvoice = (overrides: Record<string, unknown> = {}) =>
        invoiceRow({ id: INVOICE_UUID, ...overrides });
      const fixedFeePi = (overrides: Record<string, unknown> = {}) =>
        paymentIntent({
          id: 'pi_123',
          amount: 4900,
          amount_received: 4900,
          invoice: 'in_123',
          metadata: {
            invoiceId: INVOICE_UUID,
            attemptId: ATTEMPT_UUID,
            period: '2026-08',
            chargeKind: 'fixed_fee',
          },
          ...overrides,
        });

      beforeEach(() => {
        // Account mirror carries the persisted subscription (customer cus_123).
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        });
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(fixedFeeRenewalAttempt());
      });

      it('settles a fixed-fee payment_intent.succeeded that only references its invoice (no subscription field)', async () => {
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', fixedFeePi(), 'evt_fixed_pi_ok'),
        );
        attemptFindUnique.mockResolvedValue(fixedFeeRenewalAttempt({ status: 'succeeded' }));
        invoiceFindUnique.mockResolvedValue(fixedFeeInvoice());
        invoiceUpdateMany.mockResolvedValue({ count: 1 });

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The PI event is accepted: the persisted subscription mirror + the
        // matching Stripe invoice id prove the renewal.
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: ATTEMPT_UUID, status: 'pending' }),
            data: expect.objectContaining({ status: 'succeeded' }),
          }),
        );
        const paidCalls = invoiceUpdateMany.mock.calls.filter(
          (c) => (c[0].data as Record<string, unknown> | undefined)?.paidAt !== undefined,
        );
        expect(paidCalls).toHaveLength(1);
      });

      it('fails closed when a fixed-fee payment_intent.succeeded references a DIFFERENT Stripe invoice', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.succeeded',
            fixedFeePi({ invoice: 'in_OTHER' }),
            'evt_fixed_pi_bad',
          ),
        );
        attemptFindUnique.mockResolvedValue(fixedFeeRenewalAttempt({ status: 'succeeded' }));
        invoiceFindUnique.mockResolvedValue(fixedFeeInvoice());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The Stripe invoice identity mismatch fails closed: no success
        // transition, no settlement, review recorded.
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
      });

      it('fails closed when the account mirror has no persisted subscription (bare PI cannot prove a renewal)', async () => {
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: null,
        });
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', fixedFeePi(), 'evt_fixed_pi_nosub'),
        );
        attemptFindUnique.mockResolvedValue(fixedFeeRenewalAttempt({ status: 'succeeded' }));
        invoiceFindUnique.mockResolvedValue(fixedFeeInvoice());

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('marks a fixed-fee payment_intent.payment_failed attempt failed (invoice-based proof)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.payment_failed',
            fixedFeePi({
              status: 'requires_payment_method',
              last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
            }),
            'evt_fixed_pi_fail',
          ),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({ status: 'failed', failureCode: 'card_declined' }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('marks a fixed-fee payment_intent.canceled attempt failed (never pending forever)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.canceled',
            fixedFeePi({ status: 'canceled' }),
            'evt_fixed_pi_cancel',
          ),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({ status: 'failed' }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });
    });

    describe('initial subscription Checkout PI-before-invoice identity (provider invoice ref exemption)', () => {
      // A FIRST-PERIOD subscription Checkout attempt: the Checkout's PI
      // references the subscription's first Stripe invoice BEFORE the local
      // attempt ever learned its id (`persistSubscriptionCheckout` does not
      // store stripeInvoiceId). The bare provider invoice reference is accepted
      // ONLY with strict proof (`validateAttemptIdentity` →
      // `isInitialSubscriptionCheckoutAttempt`): the attempt must be fixed_fee,
      // bound to a Checkout session AND to a subscription, that subscription
      // must exactly match the account mirror, and the local invoice period must
      // match the mirror's subscription period when the mirror carries one.
      const initialAttempt = (overrides: Record<string, unknown> = {}) =>
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripeChargeKind: 'fixed_fee',
          stripeCheckoutSessionId: 'cs_sub',
          stripeSubscriptionId: 'sub_123',
          stripeInvoiceId: null,
          stripePaymentIntentId: null,
          ...overrides,
        });
      const initialInvoice = (overrides: Record<string, unknown> = {}) =>
        invoiceRow({
          id: INVOICE_UUID,
          monthlyFeeMicros: 49_000_000n,
          grossOutboundMicros: 0n,
          billableOutboundMicros: 0n,
          outboundOverageMicros: 0n,
          apiOverageMicros: 0n,
          walletOverageMicros: 0n,
          snapshotJson: {
            renewal: true,
            planVersionId: 'plan-1',
            fixedFeeMicros: '49000000',
            period: '2026-08-01',
          },
          snapshotHash: 'b9137cdf1cb4a737e45eabf914a5cc45753de035968afa3d99f6ab3ef1f12a6b',
          ...overrides,
        });
      const firstInvoicePi = (overrides: Record<string, unknown> = {}) =>
        paymentIntent({
          id: 'pi_first',
          amount: 4900,
          amount_received: 4900,
          invoice: 'in_first',
          metadata: {
            invoiceId: INVOICE_UUID,
            attemptId: ATTEMPT_UUID,
            period: '2026-08',
            chargeKind: 'fixed_fee',
          },
          ...overrides,
        });

      beforeEach(() => {
        // The account mirror is bound to the SAME subscription and its period
        // matches the local invoice's UTC month (billing_cycle_anchor = the
        // invoice periodStart), which is the first-period proof.
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        });
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(initialAttempt());
        invoiceFindUnique.mockResolvedValue(initialInvoice());
        invoiceUpdateMany.mockResolvedValue({ count: 1 });
        planVersionFindUnique.mockResolvedValue({
          id: 'plan-1',
          code: 'pro',
          version: 2,
          name: 'Pro',
          monthlyFeeMicros: 49_000_000n,
        });
      });

      it('accepts a first-period PI that references an unbound Stripe invoice and settles it', async () => {
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', firstInvoicePi(), 'evt_first_pi_ok'),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The identity proof passed: fixed_fee + Checkout session + matching
        // subscription mirror. The attempt is succeeded and the invoice settled.
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: ATTEMPT_UUID, status: 'pending' }),
            data: expect.objectContaining({ status: 'succeeded' }),
          }),
        );
        // The provider invoice reference is CAS-bound on the safe event-identity
        // persistence path (stripeInvoiceId was null before this event).
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: ATTEMPT_UUID, stripeInvoiceId: null }),
            data: expect.objectContaining({ stripeInvoiceId: 'in_first' }),
          }),
        );
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: ATTEMPT_UUID, stripePaymentIntentId: null }),
            data: expect.objectContaining({ stripePaymentIntentId: 'pi_first' }),
          }),
        );
        const paidCalls = invoiceUpdateMany.mock.calls.filter(
          (c) => (c[0].data as Record<string, unknown> | undefined)?.paidAt !== undefined,
        );
        expect(paidCalls).toHaveLength(1);
      });

      it('rejects a PI whose account mirror subscription differs from the attempt (wrong subscription)', async () => {
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_OTHER',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        });
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', firstInvoicePi(), 'evt_first_pi_sub'),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // The account/attempt subscription disagreement fails closed: no success
        // transition, no settlement, durably reviewed.
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
      });

      it('rejects a PI whose local invoice period does not match the mirror period (non-first-period)', async () => {
        // The subscription mirror already advanced to the NEXT period (July),
        // so the August invoice cannot be proven to be the subscription's first
        // Checkout invoice — the bare invoice reference is never loosened.
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
          stripeSubscriptionPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        });
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', firstInvoicePi(), 'evt_first_pi_period'),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
      });

      it('rejects a bare renewal PI whose attempt has no Checkout session (never loosened)', async () => {
        // A fixed-fee renewal PI without a Checkout session is never exempted:
        // its Stripe invoice must already be bound AND match locally.
        attemptFindFirst.mockResolvedValue(initialAttempt({ stripeCheckoutSessionId: null }));
        constructEventAsync.mockResolvedValue(
          event('payment_intent.succeeded', firstInvoicePi(), 'evt_first_pi_nosession'),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'needs_review' }) }),
        );
      });

      it('marks the first-period PI attempt failed on payment_intent.payment_failed', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.payment_failed',
            firstInvoicePi({
              status: 'requires_payment_method',
              last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
            }),
            'evt_first_pi_fail',
          ),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({ status: 'failed', failureCode: 'card_declined' }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('marks the first-period PI attempt failed on payment_intent.canceled (never pending forever)', async () => {
        constructEventAsync.mockResolvedValue(
          event(
            'payment_intent.canceled',
            firstInvoicePi({ status: 'canceled' }),
            'evt_first_pi_cancel',
          ),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(attemptUpdateMany).toHaveBeenCalledWith({
          where: { id: ATTEMPT_UUID, status: 'pending' },
          data: expect.objectContaining({ status: 'failed' }),
        });
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });
    });

    describe('validateRenewalReplay companion no-op (strict replay proof)', () => {
      // Every strict fact a replay must prove exactly: fixed-fee, exact UTC
      // month, single monthly-fee line, snapshot hash, and provider identity.
      const replayAttempt = (overrides: Record<string, unknown> = {}) =>
        attemptRow({
          id: ATTEMPT_UUID,
          invoiceId: INVOICE_UUID,
          stripeChargeKind: 'fixed_fee',
          stripeSubscriptionId: 'sub_123',
          stripeInvoiceId: 'in_123',
          stripePaymentIntentId: 'pi_123',
          amountMicros: 49_000_000n,
          ...overrides,
        });
      const replayInvoice = (overrides: Record<string, unknown> = {}) =>
        invoiceRow({
          id: INVOICE_UUID,
          monthlyFeeMicros: 49_000_000n,
          grossOutboundMicros: 0n,
          billableOutboundMicros: 0n,
          outboundOverageMicros: 0n,
          apiOverageMicros: 0n,
          walletOverageMicros: 0n,
          snapshotJson: {
            renewal: true,
            planVersionId: 'plan-1',
            fixedFeeMicros: '49000000',
            period: '2026-08-01',
          },
          snapshotHash: 'b9137cdf1cb4a737e45eabf914a5cc45753de035968afa3d99f6ab3ef1f12a6b',
          lines: [{ lineType: 'monthly_fee', amountMicros: 49_000_000n, quantity: 1n }],
          ...overrides,
        });

      beforeEach(() => {
        accountFindUnique.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        });
        // invoice.* events also resolve the account via the subscription mirror
        // (no metadata userId on renewal invoices).
        accountFindFirst.mockResolvedValue({
          id: 'acct-1',
          userId: 'user-1',
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionUpdatedAt: null,
          activeSubscriptionPlanVersionId: 'plan-1',
        });
        planVersionFindUnique.mockResolvedValue({
          id: 'plan-1',
          code: 'pro',
          version: 2,
          name: 'Pro',
          monthlyFeeMicros: 49_000_000n,
        });
      });

      it('allows the invoice.paid companion no-op when the same fixed-fee attempt is the settlement winner', async () => {
        invoiceFindUnique.mockResolvedValue(
          replayInvoice({
            paidAt: new Date('2026-08-02T00:00:00.000Z'),
            settlementAttemptId: ATTEMPT_UUID,
          }),
        );

        const result = await (service as any).validateRenewalReplay(
          (service as any).prisma,
          event('invoice.paid', renewalInvoice({ status: 'paid' }), 'evt_companion'),
          replayAttempt(),
        );

        expect(result).toBe(true);
      });

      it('applies the companion invoice.paid as a true no-op (no re-settlement, no duplicate review)', async () => {
        constructEventAsync.mockResolvedValue(
          event('invoice.paid', renewalInvoice({ status: 'paid' }), 'evt_inv_paid_companion'),
        );
        webhookEventCreate.mockResolvedValue({});
        attemptFindFirst.mockResolvedValue(
          replayAttempt({ status: 'succeeded', allocatedAt: new Date() }),
        );
        attemptFindUnique.mockResolvedValue(
          replayAttempt({ status: 'succeeded', allocatedAt: new Date() }),
        );
        invoiceFindUnique.mockResolvedValue(
          replayInvoice({
            paidAt: new Date('2026-08-02T00:00:00.000Z'),
            settlementAttemptId: ATTEMPT_UUID,
          }),
        );

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        expect(webhookEventCreate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'processed' }) }),
        );
        // The already-settled invoice is never re-settled and the succeeded
        // attempt is never regressed or marked duplicate — a pure no-op.
        expect(attemptUpdateMany).not.toHaveBeenCalled();
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('rejects a companion invoice.payment_failed on an already-paid invoice (paid state never regressed)', async () => {
        invoiceFindUnique.mockResolvedValue(
          replayInvoice({
            paidAt: new Date('2026-08-02T00:00:00.000Z'),
            settlementAttemptId: ATTEMPT_UUID,
          }),
        );

        const result = await (service as any).validateRenewalReplay(
          (service as any).prisma,
          event('invoice.payment_failed', renewalInvoice({ status: 'open' }), 'evt_fail'),
          replayAttempt(),
        );

        expect(result).toBe(false);
      });

      it('rejects an invoice.paid replay when a DIFFERENT attempt owns the settlement', async () => {
        invoiceFindUnique.mockResolvedValue(
          replayInvoice({
            paidAt: new Date('2026-08-02T00:00:00.000Z'),
            settlementAttemptId: '99999999-9999-4999-8999-999999999999',
          }),
        );

        const result = await (service as any).validateRenewalReplay(
          (service as any).prisma,
          event('invoice.paid', renewalInvoice({ status: 'paid' }), 'evt_other_winner'),
          replayAttempt(),
        );

        expect(result).toBe(false);
      });

      it('rejects a companion replay whose local invoice facts no longer match the fixed fee (strict facts required)', async () => {
        // The same winner, but the local invoice total drifted to a dynamic
        // overage amount — a replay must never ride on a changed fact set.
        invoiceFindUnique.mockResolvedValue(
          replayInvoice({
            paidAt: new Date('2026-08-02T00:00:00.000Z'),
            settlementAttemptId: ATTEMPT_UUID,
            totalMicros: 99_000_000n,
            monthlyFeeMicros: 99_000_000n,
          }),
        );

        const result = await (service as any).validateRenewalReplay(
          (service as any).prisma,
          event('invoice.paid', renewalInvoice({ status: 'paid' }), 'evt_drift'),
          replayAttempt(),
        );

        expect(result).toBe(false);
      });
    });

    describe('overage PaymentIntent reconciliation (lost-webhook recovery)', () => {
      const reconcilableAttempt = (overrides: Record<string, unknown> = {}) =>
        attemptRow({
          stripeChargeKind: 'overage',
          stripePaymentIntentId: 'pi_ov',
          amountMicros: 60_000_000n,
          ...overrides,
        });
      const reconciledInvoice = () =>
        invoiceRow({
          totalMicros: 109_000_000n,
          allocatedMicros: 49_000_000n,
        });
      const overagePi = (overrides: Record<string, unknown> = {}) =>
        ({
          id: 'pi_ov',
          status: 'succeeded',
          amount: 6000,
          currency: 'usd',
          customer: 'cus_123',
          metadata: {
            invoiceId: 'inv-1',
            attemptId: 'att-1',
            chargeKind: 'overage',
          },
          ...overrides,
        }) as any;

      beforeEach(() => {
        // The reconcile's initial read sees the pending attempt; the shared
        // settlement boundary re-reads it AFTER the forward-only succeeded CAS,
        // so it must see `succeeded` (exactly like the real DB).
        attemptFindUnique
          .mockResolvedValueOnce({
            ...reconcilableAttempt(),
            invoice: { ...reconciledInvoice(), billingAccount: { stripeCustomerId: 'cus_123' } },
          })
          .mockResolvedValue({
            ...reconcilableAttempt({ status: 'succeeded' }),
            invoice: { ...reconciledInvoice(), billingAccount: { stripeCustomerId: 'cus_123' } },
          });
        invoiceFindUnique.mockResolvedValue(reconciledInvoice());
        attemptUpdateMany.mockResolvedValue({ count: 1 });
        invoiceUpdateMany.mockResolvedValue({ count: 1 });
        paymentIntentRetrieve.mockResolvedValue(overagePi());
      });

      it('settles a PaymentIntent that succeeded but whose webhook was lost', async () => {
        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('settled');
        // Forward-only CAS to succeeded + shared coverage settlement.
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'att-1',
              status: 'pending',
              stripePaymentIntentId: 'pi_ov',
            }),
            data: expect.objectContaining({ status: 'succeeded' }),
          }),
        );
        const paidCalls = invoiceUpdateMany.mock.calls.filter(
          (c) => (c[0].data as Record<string, unknown> | undefined)?.paidAt !== undefined,
        );
        expect(paidCalls).toHaveLength(1);
        // The SAME PI identity is used — nothing is re-created.
        expect(paymentIntentRetrieve).toHaveBeenCalledWith('pi_ov');
      });

      it('keeps a processing PaymentIntent pending with a re-check backoff (never fake success)', async () => {
        paymentIntentRetrieve.mockResolvedValue(overagePi({ status: 'processing' }));

        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('pending');
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
            data: expect.objectContaining({ checkoutNextRetryAt: expect.any(Date) }),
          }),
        );
        expect(attemptUpdate).not.toHaveBeenCalled();
      });

      it('marks a canceled PaymentIntent failed', async () => {
        paymentIntentRetrieve.mockResolvedValue(overagePi({ status: 'canceled' }));

        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('failed');
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
            data: expect.objectContaining({ status: 'failed', failureCode: 'canceled' }),
          }),
        );
      });

      it('marks a requires_action PaymentIntent needs_review (SCA, never a fake success)', async () => {
        paymentIntentRetrieve.mockResolvedValue(overagePi({ status: 'requires_action' }));

        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('needs_review');
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'needs_review',
              reviewReason: 'payment_intent_requires_action',
            }),
          }),
        );
      });

      it('marks a PaymentIntent with a mismatched identity needs_review (never settled)', async () => {
        paymentIntentRetrieve.mockResolvedValue(
          overagePi({ amount: 9999 }), // wrong amount
        );

        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('needs_review');
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'needs_review',
              reviewReason: 'payment_intent_reconciliation_mismatch',
            }),
          }),
        );
        expect(invoiceUpdateMany).not.toHaveBeenCalled();
      });

      it('keeps a transient retrieve failure pending with backoff (no state change)', async () => {
        paymentIntentRetrieve.mockRejectedValue(new Error('network timeout'));

        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('pending');
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ checkoutNextRetryAt: expect.any(Date) }),
          }),
        );
      });

      it('marks a PaymentIntent that no longer exists at Stripe as needs_review', async () => {
        paymentIntentRetrieve.mockRejectedValue(
          Object.assign(new Error('No such payment_intent'), {
            code: 'resource_missing',
            statusCode: 404,
          }),
        );

        const result = await service.reconcileOveragePaymentIntent(
          reconcilableAttempt() as any,
          'worker-1',
        );

        expect(result).toBe('needs_review');
        expect(attemptUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: 'needs_review',
              reviewReason: 'payment_intent_not_found',
            }),
          }),
        );
      });
    });

    describe('deferred worker re-processing outcome contract (Gate 2)', () => {
      const deferredRow = () => ({
        status: 'deferred',
        retryCount: 1,
        retryOwnerId: 'worker-1',
        retryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
        nextRetryAt: new Date(),
      });

      it('returns needs_review when a deferred preflight conflict is durably recorded', async () => {
        webhookEventFindUnique.mockResolvedValue(deferredRow());
        webhookEventCreate.mockRejectedValue(p2002());
        // The metadata attemptId/invoiceId disagreement is a preflight conflict.
        attemptFindFirst
          .mockResolvedValueOnce(null) // persisted-id lookup misses
          .mockResolvedValueOnce(
            attemptRow({ id: ATTEMPT_UUID, invoiceId: '33333333-3333-4333-8333-333333333333' }),
          );

        const result = await service.processEvent(
          event(
            'payment_intent.succeeded',
            paymentIntent({ metadata: { attemptId: ATTEMPT_UUID, invoiceId: INVOICE_UUID } }),
            'evt_1',
          ),
          { ownerId: 'worker-1' },
        );

        // The pipeline (sole authority) converted the preflight conflict to a
        // durable needs_review and reported it — the worker must fail its tick.
        expect(result).toBe('needs_review');
        expect(webhookEventUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ stripeEventId: 'evt_1' }),
            data: expect.objectContaining({ status: 'needs_review' }),
          }),
        );
      });

      it('returns processed when a deferred preflight-review CAS misses (benign concurrent completion)', async () => {
        webhookEventFindUnique.mockResolvedValue(deferredRow());
        webhookEventCreate.mockRejectedValue(p2002());
        attemptFindFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(
            attemptRow({ id: ATTEMPT_UUID, invoiceId: '33333333-3333-4333-8333-333333333333' }),
          );
        // A concurrent processor already completed the event: the needs_review
        // transition CAS matches zero rows.
        webhookEventUpdateMany.mockResolvedValue({ count: 0 });

        const result = await service.processEvent(
          event(
            'payment_intent.succeeded',
            paymentIntent({ metadata: { attemptId: ATTEMPT_UUID, invoiceId: INVOICE_UUID } }),
            'evt_1',
          ),
          { ownerId: 'worker-1' },
        );

        // The benign CAS miss is reported as the completed outcome — never a
        // needs_review failure for the worker tick.
        expect(result).toBe('processed');
      });

      it('returns processed when a deferred event is re-applied through the worker pipeline', async () => {
        webhookEventFindUnique.mockResolvedValue(deferredRow());
        webhookEventCreate.mockRejectedValue(p2002());
        attemptFindFirst.mockResolvedValue(attemptRow());
        invoiceUpdateMany.mockResolvedValue({ count: 1 });

        const result = await service.processEvent(
          event('checkout.session.completed', session({ payment_status: 'paid' }), 'evt_1'),
          { ownerId: 'worker-1' },
        );

        expect(result).toBe('processed');
        expect(webhookEventUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'processed' }),
          }),
        );
      });
    });
  });
});

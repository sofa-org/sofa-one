import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { InvoiceSettlementService } from '../invoice-settlement.service';
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
    snapshotJson: { renewal: true, planVersionId: 'plan-1', fixedFeeMicros: '49000000', period: '2026-08-01' },
    snapshotHash: '866992bfad24dfffd0349f15a125a49c1dad07aea403a0f55543a30d2d6262d5',
    lines: [{ lineType: 'monthly_fee', amountMicros: 49_000_000n }],
    ...overrides,
  };
}

/** The full CAS where clause the settlement update must carry. */
function casWhere(invoiceId: string, attemptId: string) {
  return {
    id: invoiceId,
    status: 'finalized',
    paidAt: null,
    settlementAttemptId: null,
    totalMicros: 49_000_000n,
    currency: 'USD',
    paymentAttempts: {
      some: { id: attemptId, method: 'stripe', status: 'succeeded' },
    },
  };
}

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;

  const webhookEventCreate = jest.fn();
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
  const invoiceUpdate = jest.fn();
  const invoiceUpdateMany = jest.fn();
  const accountFindUnique = jest.fn();
  const accountFindFirst = jest.fn();
  const accountUpdate = jest.fn();
  const accountUpdateMany = jest.fn();
  const planVersionFindUnique = jest.fn();
  const queryRaw = jest.fn();
  const transaction = jest.fn();
  const configGet = jest.fn();
  const constructEventAsync = jest.fn();
  const securityRecord = jest.fn();

  const stripeMock = { webhooks: { constructEventAsync } };

  beforeEach(async () => {
    jest.resetAllMocks();
    // Model Prisma's updateMany result while retaining the existing update spy
    // as a compact assertion surface for the business mutation. The production
    // service still exercises the guarded updateMany call below.
    webhookEventUpdateMany.mockImplementation((args: { where: { stripeEventId: string }; data: unknown }) => {
      webhookEventUpdate({ where: { stripeEventId: args.where.stripeEventId }, data: args.data });
      return Promise.resolve({ count: 1 });
    });
    attemptUpdateMany.mockImplementation((args: { data?: Record<string, unknown>; where: unknown }) => {
      if (args.data?.stripePaymentIntentId || args.data?.stripeCheckoutSessionId) {
        attemptUpdate({ where: { id: (args.where as { id: string }).id }, data: args.data });
      }
      return Promise.resolve({ count: 1 });
    });
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
            billingInvoiceLine: { createMany: invoiceLineCreateMany },
            billingAccount: {
              findUnique: accountFindUnique,
              findFirst: accountFindFirst,
              update: accountUpdate,
              updateMany: accountUpdateMany,
            },
            billingPlanVersion: { findUnique: planVersionFindUnique },
            $queryRaw: queryRaw,
            $transaction: transaction,
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: STRIPE_CLIENT, useValue: stripeMock },
        { provide: SecurityEventService, useValue: { record: securityRecord } },
      ],
    }).compile();

    service = module.get<StripeWebhookService>(StripeWebhookService);

    // The interactive transaction client shares the same jest.fn() instances
    // as this.prisma so the production transaction path is exercised.
    const tx = {
      stripeWebhookEvent: {
        create: webhookEventCreate,
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
      billingInvoiceLine: { createMany: invoiceLineCreateMany },
      billingAccount: {
        findUnique: accountFindUnique,
        findFirst: accountFindFirst,
        update: accountUpdate,
        updateMany: accountUpdateMany,
      },
      billingPlanVersion: { findUnique: planVersionFindUnique },
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
        where: casWhere('inv-1', 'att-1'),
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
        event('checkout.session.completed', session({ payment_status: 'paid', mode: 'payment' }), 'evt_mode_mismatch'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(
        attemptRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }),
      );

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'needs_review' }),
      }));
    });

    it.each([
      ['full attempt completed with a subscription-mode Checkout', { mode: 'subscription', subscription: 'sub_123' }, {}],
      ['full attempt completed with a setup-mode Checkout', { mode: 'setup' }, {}],
      ['fixed-fee attempt completed with a setup-mode Checkout', { mode: 'setup' }, { stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_123' }],
    ])('rejects %s without settlement', async (_label, sessionOverrides, attemptOverrides) => {
      constructEventAsync.mockResolvedValue(
        event('checkout.session.completed', session({ payment_status: 'paid', ...sessionOverrides }), 'evt_mode_reject'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow(attemptOverrides));

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'needs_review' }),
      }));
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
      invoiceUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // Second delivery: checkout.session.completed arrives after the attempt
      // is already succeeded and the invoice is already settled — the guarded
      // settlement update must match zero rows (never overwrite).
      constructEventAsync.mockResolvedValueOnce(
        event('checkout.session.completed', session({ payment_status: 'paid' }), 'evt_cs'),
      );
      webhookEventCreate.mockResolvedValueOnce({});
      attemptFindFirst.mockResolvedValueOnce(
        attemptRow({
          status: 'succeeded',
          succeededAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      );
      invoiceUpdateMany.mockResolvedValueOnce({ count: 0 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledTimes(1); // only the PI event updated
      expect(invoiceUpdateMany).toHaveBeenCalledTimes(2); // both events attempted settlement
      // Every settlement attempt carries the full CAS guard: an already-settled
      // invoice can never be overwritten (the second call matched 0 rows).
      for (const call of invoiceUpdateMany.mock.calls) {
        expect(call[0].where).toEqual(casWhere('inv-1', 'att-1'));
      }
      expect(invoiceUpdateMany.mock.results[0].value).resolves.toEqual({ count: 1 });
      expect(invoiceUpdateMany.mock.results[1].value).resolves.toEqual({ count: 0 });
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
      expect(webhookEventCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'needs_review' }),
      }));
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
        event('payment_intent.succeeded', paymentIntent({ status: 'succeeded' }), 'evt_stale_success'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow({ status: 'pending' }));
      // The failure won after the success preflight read and before its CAS.
      attemptUpdateMany.mockResolvedValueOnce({ count: 0 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
        data: expect.objectContaining({ status: 'succeeded' }),
      }));
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(webhookEventCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'needs_review' }),
      }));
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
      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          AND: expect.arrayContaining([
            { OR: [{ stripeInvoiceId: null }, { stripeInvoiceId: 'in_123' }] },
          ]),
        }),
        data: expect.objectContaining({ status: 'succeeded' }),
      }));
      expect(webhookEventCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'needs_review' }),
      }));
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
      // ...but the settlement CAS prevents any overwrite of the USDC win, and
      // the succeeded Stripe attempt is marked duplicate/unallocated review.
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: casWhere('inv-1', 'att-1'),
        data: expect.objectContaining({
          paidVia: 'stripe',
          settlementAttemptId: 'att-1',
        }),
      });
      expect(attemptUpdate).toHaveBeenLastCalledWith({
        where: { id: 'att-1' },
        data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
      });
    });

    it('does not mark duplicate when the settlement CAS fails but the invoice is unsettled', async () => {
      // A settlement precondition failure (e.g. invoice no longer finalized)
      // leaves the invoice unsettled — the succeeded Stripe attempt is not a
      // duplicate and must not be flagged.
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_no_dup'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      invoiceUpdateMany.mockResolvedValue({ count: 0 });
      invoiceFindUnique.mockResolvedValue(invoiceRow({ settlementAttemptId: null }));

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
        where: casWhere(INVOICE_UUID, ATTEMPT_UUID),
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
      // by re-fetching; the event id already exists as `deferred` (P2002), and
      // the now-existing local attempt is found and processed.
      constructEventAsync.mockResolvedValue(
        event(
          'invoice.paid',
          renewalInvoice(),
          'evt_renewal',
        ),
      );
      webhookEventCreate.mockRejectedValueOnce(p2002());
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

      // An unmatched mirror is a pure-preflight failure and remains deferred;
      // no local attempt or settlement mutation is permitted.
      expect(webhookEventUpdate).toHaveBeenCalled();
      expect(attemptUpdate).not.toHaveBeenCalled();
    });

    it('never settles a dynamic invoice with a smaller fixed recurring charge', async () => {
      constructEventAsync.mockResolvedValue(
        event(
          'invoice.paid',
          renewalInvoice(),
          'evt_renewal',
        ),
      );
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
      invoiceUpdateMany.mockResolvedValue({ count: 0 }); // exact-match CAS misses

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      // The exact-match settlement CAS cannot match (isSettlable short-circuits
      // on the amount mismatch), so the dynamic invoice is NOT marked paid by
      // the smaller recurring charge; the mismatch is surfaced as needs_review
      // (separately payable balance).
      expect(
        invoiceUpdateMany.mock.calls.some(
          ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
        ),
      ).toBe(false);
      // The fixed recurring charge must not settle the dynamic invoice. Any
      // resulting attempt bookkeeping/review remains forward-only and is not
      // part of this settlement invariant.
      expect(attemptUpdateMany.mock.calls.some(([arg]) =>
        (arg as { data?: Record<string, unknown> })?.data?.status === 'needs_review',
      )).toBe(false);
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
          stripeSubscriptionPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
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
        attemptCreate.mockResolvedValue({ id: 'att-renewal', invoiceId: 'inv-renew', method: 'stripe' });
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

        await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

        // Fail closed: no fixed-fee attempt is materialized against the dynamic
        // invoice, and the unmatched event is deferred (never ignored, never a
        // false settlement).
        expect(attemptCreate).not.toHaveBeenCalled();
        expect(webhookEventCreate).toHaveBeenCalled();
        expect(webhookEventUpdate).not.toHaveBeenCalled();
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
            metadata: { attemptId: ATTEMPT_UUID, invoiceId: '33333333-3333-4333-8333-333333333333' },
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
  });
});

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { InvoiceSettlementService } from '../invoice-settlement.service';
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
  return { id: 'cs_123', payment_status: 'paid', ...overrides };
}

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_123',
    status: 'succeeded',
    last_payment_error: null,
    ...overrides,
  };
}

function event(type: string, object: unknown, id = 'evt_1') {
  return { id, type, data: { object } } as any;
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    invoiceId: 'inv-1',
    method: 'stripe',
    status: 'pending',
    amountMicros: 49_000_000n,
    currency: 'USD',
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
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-01T00:00:00.000Z'),
    status: 'finalized',
    currency: 'USD',
    totalMicros: 49_000_000n,
    paidAt: null,
    settlementAttemptId: null,
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
  const attemptFindFirst = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptUpdate = jest.fn();
  const attemptUpdateMany = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceUpdate = jest.fn();
  const invoiceUpdateMany = jest.fn();
  const queryRaw = jest.fn();
  const transaction = jest.fn();
  const configGet = jest.fn();
  const constructEventAsync = jest.fn();

  const stripeMock = { webhooks: { constructEventAsync } };

  beforeEach(async () => {
    jest.resetAllMocks();

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
            stripeWebhookEvent: { create: webhookEventCreate, update: webhookEventUpdate },
            billingPaymentAttempt: {
              findFirst: attemptFindFirst,
              findUnique: attemptFindUnique,
              update: attemptUpdate,
              updateMany: attemptUpdateMany,
            },
            billingInvoice: {
              findUnique: invoiceFindUnique,
              update: invoiceUpdate,
              updateMany: invoiceUpdateMany,
            },
            $queryRaw: queryRaw,
            $transaction: transaction,
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: STRIPE_CLIENT, useValue: stripeMock },
      ],
    }).compile();

    service = module.get<StripeWebhookService>(StripeWebhookService);

    // The interactive transaction client shares the same jest.fn() instances
    // as this.prisma so the production transaction path is exercised.
    const tx = {
      stripeWebhookEvent: { create: webhookEventCreate, update: webhookEventUpdate },
      billingPaymentAttempt: {
        findFirst: attemptFindFirst,
        findUnique: attemptFindUnique,
        update: attemptUpdate,
        updateMany: attemptUpdateMany,
      },
      billingInvoice: {
        findUnique: invoiceFindUnique,
        update: invoiceUpdate,
        updateMany: invoiceUpdateMany,
      },
      $queryRaw: queryRaw,
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
      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: 'att-1' },
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
      expect(attemptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-1' },
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

      expect(attemptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
      expect(invoiceUpdateMany).toHaveBeenCalled();
    });
  });

  describe('idempotency and ordering', () => {
    it('does not double-apply a duplicate event id', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_dup'),
      );
      webhookEventCreate.mockRejectedValueOnce(p2002());

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptFindFirst).not.toHaveBeenCalled();
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

      expect(attemptUpdate).toHaveBeenCalledTimes(1); // only the PI event updated
      expect(invoiceUpdateMany).toHaveBeenCalledTimes(2); // both events attempted settlement
      // Every settlement attempt carries the full CAS guard: an already-settled
      // invoice can never be overwritten (the second call matched 0 rows).
      for (const call of invoiceUpdateMany.mock.calls) {
        expect(call[0].where).toEqual(casWhere('inv-1', 'att-1'));
      }
      expect(invoiceUpdateMany.mock.results[0].value).resolves.toEqual({ count: 1 });
      expect(invoiceUpdateMany.mock.results[1].value).resolves.toEqual({ count: 0 });
    });

    it('moves a failed attempt forward to succeeded', async () => {
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
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      await service.handleWebhook(Buffer.from('{}'), 't=1,v1=sig');

      expect(attemptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'succeeded',
            failedAt: null,
            failureCode: null,
            failureMessage: null,
          }),
        }),
      );
      expect(invoiceUpdateMany).toHaveBeenCalled();
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
      expect(attemptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-1' },
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

      expect(attemptUpdate).toHaveBeenCalledWith(
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

      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_orphan' },
        data: { status: 'ignored' },
      });
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('propagates a DB processing error so Stripe retries (5xx)', async () => {
      constructEventAsync.mockResolvedValue(
        event('payment_intent.succeeded', paymentIntent(), 'evt_db'),
      );
      webhookEventCreate.mockResolvedValue({});
      attemptFindFirst.mockResolvedValue(attemptRow());
      attemptUpdate.mockRejectedValue(new Error('database unavailable'));

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
      expect(attemptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ATTEMPT_UUID },
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

      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_bad_meta' },
        data: { status: 'ignored' },
      });
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
      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_cross_pi' },
        data: { status: 'ignored' },
      });
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
      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_cross_cs' },
        data: { status: 'ignored' },
      });
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
      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_cross_meta' },
        data: { status: 'ignored' },
      });
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
      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_cross_inv' },
        data: { status: 'ignored' },
      });
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });
  });
});

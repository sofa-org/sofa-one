import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { STRIPE_CLIENT } from './stripe.constants';
import { StripePaymentService, withCheckoutReturnMarker } from './stripe-payment.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

/**
 * attemptFindFirst mock that returns `value` for checkout reuse/poll/fresh-read
 * lookups but `null` for the full-checkout coverage gate's fixed-fee probe (so
 * a checkout attempt row never false-positives the coverage gate). The returned
 * row is also recorded as the current "bound attempt" so the where-aware
 * updateMany CAS below can judge whether a stale release can ever match.
 */
let boundAttempt: Record<string, unknown> | null = null;

function gateAwareFindFirst(value: unknown) {
  boundAttempt = (value as Record<string, unknown>) ?? null;
  return jest.fn(({ where }: any) =>
    where?.stripeChargeKind === 'fixed_fee' && where?.status === 'succeeded'
      ? Promise.resolve(null)
      : Promise.resolve(value),
  );
}

/**
 * The stale-release CAS demands every provider identity column be NULL at the
 * TOP level of its WHERE. When the current bound attempt carries a non-null
 * value for any of those columns, the CAS can never match (count 0) — the
 * caller must fail closed instead of replacing a provider-bound attempt.
 */
const RELEASE_NULL_IDENTITY_FIELDS = [
  'stripeCheckoutSessionId',
  'stripePaymentIntentId',
  'stripeInvoiceId',
  'stripeSubscriptionId',
  'checkoutUrl',
];

function nullReleaseConflict(where: Record<string, unknown>): boolean {
  return RELEASE_NULL_IDENTITY_FIELDS.some(
    (field) => where[field] === null && boundAttempt?.[field] != null,
  );
}

const ACCOUNT = {
  id: 'acc-1',
  userId: 'user-1',
  stripeCustomerId: null,
  currency: 'USD',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    billingAccountId: ACCOUNT.id,
    planVersionId: 'plan-1',
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-01T00:00:00.000Z'),
    status: 'finalized',
    currency: 'USD',
    grossOutboundMicros: 0n,
    includedOutboundMicros: 0n,
    billableOutboundMicros: 0n,
    apiCalls: 0n,
    includedApiCalls: 0n,
    activeWallets: 0,
    includedWallets: 0,
    monthlyFeeMicros: 49_000_000n,
    outboundOverageMicros: 0n,
    apiOverageMicros: 0n,
    walletOverageMicros: 0n,
    totalMicros: 49_000_000n, // $49.00 -> 4900 cents
    snapshotJson: {},
    snapshotHash: 'hash',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    finalizedAt: new Date('2026-06-01T00:00:00.000Z'),
    paidAt: null,
    settlementAttemptId: null,
    allocatedMicros: 0n,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    invoiceId: 'inv-1',
    method: 'stripe',
    status: 'pending',
    amountMicros: 49_000_000n,
    currency: 'USD',
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    checkoutUrl: null,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    succeededAt: null,
    failedAt: null,
    ...overrides,
  };
}

describe('StripePaymentService', () => {
  let service: StripePaymentService;

  const accountFindUnique = jest.fn();
  const accountUpdate = jest.fn();
  const accountUpdateMany = jest.fn();
  const userFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const attemptFindFirst = jest.fn();
  const attemptFindMany = jest.fn();
  const attemptCount = jest.fn();
  const attemptCreate = jest.fn();
  const attemptUpdate = jest.fn();
  const attemptUpdateMany = jest.fn();
  const planVersionFindUnique = jest.fn();
  const configGet = jest.fn();
  const customerCreate = jest.fn();
  const customerRetrieve = jest.fn();
  const paymentMethodRetrieve = jest.fn();
  const paymentIntentCreate = jest.fn();
  const sessionCreate = jest.fn();
  const sessionRetrieve = jest.fn();

  const stripeMock = {
    customers: { create: customerCreate, retrieve: customerRetrieve },
    paymentMethods: { retrieve: paymentMethodRetrieve },
    paymentIntents: { create: paymentIntentCreate },
    checkout: { sessions: { create: sessionCreate, retrieve: sessionRetrieve } },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    boundAttempt = null;
    accountUpdateMany.mockImplementation((args: { where: { id: string }; data: unknown }) => {
      accountUpdate({ where: { id: args.where.id }, data: args.data });
      return Promise.resolve({ count: 1 });
    });
    // Where-aware updateMany: a stale release whose null-identity CAS can never
    // match the bound attempt returns count 0 (fail closed, never a replacement
    // attempt); every other CAS matches exactly one row.
    attemptUpdateMany.mockImplementation((args: any) =>
      Promise.resolve({ count: nullReleaseConflict(args?.where ?? {}) ? 0 : 1 }),
    );

    configGet.mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        'stripe.successUrl': 'https://app.example.com/billing?checkout=success',
        'stripe.cancelUrl': 'https://app.example.com/billing?checkout=cancelled',
      };
      return values[key];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripePaymentService,
        {
          provide: PrismaService,
          useValue: {
            billingAccount: {
              findUnique: accountFindUnique,
              update: accountUpdate,
              updateMany: accountUpdateMany,
            },
            user: { findUnique: userFindUnique },
            billingInvoice: { findFirst: invoiceFindFirst, findUnique: invoiceFindFirst },
            billingPaymentAttempt: {
              findFirst: attemptFindFirst,
              findMany: attemptFindMany,
              findUnique: attemptFindFirst,
              count: attemptCount,
              create: attemptCreate,
              update: attemptUpdate,
              updateMany: attemptUpdateMany,
            },
            billingPlanVersion: { findUnique: planVersionFindUnique },
            $transaction: async (work: (tx: any) => Promise<unknown>) => {
              const attemptState = await Promise.resolve(attemptCreate.mock.results.at(-1)?.value);
              return work({
                billingAccount: { findUnique: accountFindUnique, updateMany: accountUpdateMany },
                billingInvoice: { findUnique: invoiceFindFirst },
                billingPaymentAttempt: {
                  findUnique: jest.fn().mockResolvedValue(attemptState),
                  findFirst: attemptFindFirst,
                  create: attemptCreate,
                  updateMany: attemptUpdateMany.mockImplementation((args: any) => {
                    if (attemptState) Object.assign(attemptState, args?.data ?? {});
                    return Promise.resolve({
                      count: nullReleaseConflict(args?.where ?? {}) ? 0 : 1,
                    });
                  }),
                },
                // Row locks taken by the full-invoice coverage gate and the
                // persistence re-check (attempt → invoice order).
                $queryRaw: jest.fn((strings: TemplateStringsArray) => {
                  const sql = strings.join('');
                  if (sql.includes('billing_payment_attempts'))
                    return Promise.resolve([{ id: 'att-1' }]);
                  if (sql.includes('billing_invoices')) return Promise.resolve([{ id: 'inv-1' }]);
                  return Promise.resolve([]);
                }),
                $executeRaw: jest.fn().mockResolvedValue(0),
              });
            },
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: STRIPE_CLIENT, useValue: stripeMock },
      ],
    }).compile();

    service = module.get<StripePaymentService>(StripePaymentService);
  });

  describe('configuration', () => {
    it('fails closed with 503 when Stripe is not configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StripePaymentService,
          { provide: PrismaService, useValue: {} },
          { provide: ConfigService, useValue: { get: configGet } },
          { provide: STRIPE_CLIENT, useValue: null },
        ],
      }).compile();
      const unconfigured = module.get<StripePaymentService>(StripePaymentService);

      await expect(unconfigured.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('fails closed with 503 when success/cancel URLs are not configured', async () => {
      configGet.mockReturnValue(undefined);

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('withCheckoutReturnMarker', () => {
    it('appends the success marker when the URL has no query string', () => {
      expect(withCheckoutReturnMarker('https://app.example.com/billing', 'success')).toBe(
        'https://app.example.com/billing?success=1',
      );
    });

    it('appends the canceled marker when the URL has no query string', () => {
      expect(withCheckoutReturnMarker('https://app.example.com/billing', 'canceled')).toBe(
        'https://app.example.com/billing?canceled=1',
      );
    });

    it('merges the success marker into an existing query string', () => {
      expect(
        withCheckoutReturnMarker('https://app.example.com/billing?checkout=success', 'success'),
      ).toBe('https://app.example.com/billing?checkout=success&success=1');
    });

    it('merges the canceled marker into an existing query string', () => {
      expect(
        withCheckoutReturnMarker('https://app.example.com/billing?checkout=cancelled', 'canceled'),
      ).toBe('https://app.example.com/billing?checkout=cancelled&canceled=1');
    });

    it('places the marker before the fragment when the URL has only a fragment', () => {
      expect(withCheckoutReturnMarker('https://app.example.com/billing#section', 'success')).toBe(
        'https://app.example.com/billing?success=1#section',
      );
      expect(withCheckoutReturnMarker('https://app.example.com/billing#section', 'canceled')).toBe(
        'https://app.example.com/billing?canceled=1#section',
      );
    });

    it('places the marker before the fragment when the URL has both a query string and a fragment', () => {
      expect(
        withCheckoutReturnMarker(
          'https://app.example.com/billing?checkout=success#section',
          'success',
        ),
      ).toBe('https://app.example.com/billing?checkout=success&success=1#section');
      expect(
        withCheckoutReturnMarker(
          'https://app.example.com/billing?checkout=cancelled#section',
          'canceled',
        ),
      ).toBe('https://app.example.com/billing?checkout=cancelled&canceled=1#section');
    });

    it('never duplicates an already-present success marker', () => {
      expect(withCheckoutReturnMarker('https://app.example.com/billing?success=1', 'success')).toBe(
        'https://app.example.com/billing?success=1',
      );
      expect(
        withCheckoutReturnMarker(
          'https://app.example.com/billing?checkout=success&success=1#section',
          'success',
        ),
      ).toBe('https://app.example.com/billing?checkout=success&success=1#section');
    });

    it('never duplicates an already-present canceled marker', () => {
      expect(
        withCheckoutReturnMarker('https://app.example.com/billing?canceled=1', 'canceled'),
      ).toBe('https://app.example.com/billing?canceled=1');
      expect(
        withCheckoutReturnMarker(
          'https://app.example.com/billing?checkout=cancelled&canceled=1#section',
          'canceled',
        ),
      ).toBe('https://app.example.com/billing?checkout=cancelled&canceled=1#section');
    });

    it('does not append a marker when the key already exists with a different value', () => {
      expect(withCheckoutReturnMarker('https://app.example.com/billing?success=0', 'success')).toBe(
        'https://app.example.com/billing?success=0',
      );
      expect(
        withCheckoutReturnMarker('https://app.example.com/billing?canceled=0', 'canceled'),
      ).toBe('https://app.example.com/billing?canceled=0');
    });

    it('preserves every existing configured query parameter in order', () => {
      expect(
        withCheckoutReturnMarker(
          'https://app.example.com/billing?checkout=success&from=email&retry=2',
          'success',
        ),
      ).toBe('https://app.example.com/billing?checkout=success&from=email&retry=2&success=1');
    });
  });

  describe('ownership and eligibility', () => {
    it('throws NotFound when the user has no billing account', async () => {
      accountFindUnique.mockResolvedValue(null);

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFound when the invoice is not owned by the user', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(null);

      await expect(service.createCheckoutSession('user-1', 'inv-other')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects non-finalized invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ status: 'open' }));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects already-paid invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ paidAt: new Date('2026-06-02T00:00:00.000Z') }));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects non-USD invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ currency: 'EUR' }));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects zero-amount invoices', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ totalMicros: 0n }));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects amounts that cannot be represented losslessly in cents', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice({ totalMicros: 49_000_001n }));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('checkout session creation', () => {
    it('creates a customer with an idempotency key and a session with server-side amounts and metadata', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(attempt());
      userFindUnique.mockResolvedValue({ email: 'user@example.com' });
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      accountUpdate.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      sessionCreate.mockResolvedValue({
        id: 'cs_123',
        url: 'https://checkout.stripe.com/c/pay/cs_123',
        payment_intent: 'pi_123',
      });
      attemptUpdate.mockResolvedValue(
        attempt({
          stripeCheckoutSessionId: 'cs_123',
          stripePaymentIntentId: 'pi_123',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
        }),
      );

      const result = await service.createCheckoutSession('user-1', 'inv-1');

      expect(customerCreate).toHaveBeenCalledWith(
        {
          email: 'user@example.com',
          metadata: { userId: 'user-1', billingAccountId: 'acc-1' },
        },
        { idempotencyKey: 'customer:acc-1' },
      );
      expect(accountUpdate).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { stripeCustomerId: 'cus_123' },
      });
      expect(sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          mode: 'payment',
          success_url: 'https://app.example.com/billing?checkout=success&success=1',
          cancel_url: 'https://app.example.com/billing?checkout=cancelled&canceled=1',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: 4900,
                product_data: { name: 'SOFA ONE — 2026-05 invoice' },
              },
            },
          ],
          metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05' },
          payment_intent_data: { metadata: { invoiceId: 'inv-1', attemptId: 'att-1' } },
          client_reference_id: 'inv-1',
        }),
        // Deterministic idempotency key derived from the local attempt so a
        // Stripe timeout/retry never creates a duplicate Session.
        { idempotencyKey: 'checkout:att-1' },
      );
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-1' }),
          data: expect.objectContaining({
            stripeCheckoutSessionId: 'cs_123',
            stripePaymentIntentId: 'pi_123',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
          }),
        }),
      );
      expect(result).toEqual({
        invoiceId: 'inv-1',
        sessionId: 'cs_123',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
      });
    });

    it('creates the pending attempt on the stripe rail and scopes pending lookups to stripe', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(attempt());
      userFindUnique.mockResolvedValue(null);
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      accountUpdate.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      sessionCreate.mockResolvedValue({
        id: 'cs_123',
        url: 'https://checkout.stripe.com/c/pay/cs_123',
        payment_intent: 'pi_123',
      });
      attemptUpdate.mockResolvedValue(
        attempt({
          stripeCheckoutSessionId: 'cs_123',
          stripePaymentIntentId: 'pi_123',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
        }),
      );

      await service.createCheckoutSession('user-1', 'inv-1');

      // The pending attempt is explicitly created on the stripe rail so a
      // USDC pending attempt can coexist for the same invoice.
      expect(attemptCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoiceId: 'inv-1',
          method: 'stripe',
          status: 'pending',
          amountMicros: 49_000_000n,
          currency: 'USD',
        }),
      });
      // The reusable-pending lookup is scoped to the stripe rail so a USDC
      // pending attempt is never reused as a Stripe checkout session. (Call 1
      // is the full-checkout coverage gate's fixed-fee probe; call 2 is the
      // reusable lookup.)
      expect(attemptFindFirst).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({
            invoiceId: 'inv-1',
            method: 'stripe',
            status: 'pending',
          }),
        }),
      );
    });

    it('reuses an existing Stripe customer id without calling Stripe customers.create', async () => {
      accountFindUnique.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_existing' });
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(attempt());
      sessionCreate.mockResolvedValue({
        id: 'cs_123',
        url: 'https://checkout.stripe.com/c/pay/cs_123',
        payment_intent: 'pi_123',
      });
      attemptUpdate.mockResolvedValue(
        attempt({
          stripeCheckoutSessionId: 'cs_123',
          stripePaymentIntentId: 'pi_123',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
        }),
      );

      await service.createCheckoutSession('user-1', 'inv-1');

      expect(customerCreate).not.toHaveBeenCalled();
      expect(sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' }),
        { idempotencyKey: 'checkout:att-1' },
      );
    });

    it('reuses a valid pending Checkout session without any Stripe call', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockImplementation(
        gateAwareFindFirst(
          attempt({
            stripeCheckoutSessionId: 'cs_old',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_old',
          }),
        ),
      );

      const result = await service.createCheckoutSession('user-1', 'inv-1');

      expect(attemptCreate).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(result).toEqual({
        invoiceId: 'inv-1',
        sessionId: 'cs_old',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_old',
      });
    });

    it('reuses the concurrent winner attempt when the pending insert races (P2002)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002());
      // The winner already persisted its session id.
      attemptFindFirst.mockImplementation(
        gateAwareFindFirst(
          attempt({
            stripeCheckoutSessionId: 'cs_winner',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_winner',
          }),
        ),
      );

      const result = await service.createCheckoutSession('user-1', 'inv-1');

      expect(sessionCreate).not.toHaveBeenCalled();
      expect(result).toEqual({
        invoiceId: 'inv-1',
        sessionId: 'cs_winner',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_winner',
      });
    });

    it('marks the attempt failed and propagates when Stripe session creation fails', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(attempt());
      userFindUnique.mockResolvedValue(null);
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      accountUpdate.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      const stripeError = Object.assign(new Error('card_error: card declined'), {
        code: 'card_declined',
      });
      sessionCreate.mockRejectedValue(stripeError);

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        'card_error: card declined',
      );

      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'pending' },
        data: expect.objectContaining({
          status: 'failed',
          failureCode: 'card_declined',
          failureMessage: 'card_error: card declined',
        }),
      });
    });

    it('never regresses a succeeded attempt when Stripe session creation fails', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(attempt());
      userFindUnique.mockResolvedValue(null);
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      accountUpdate.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      sessionCreate.mockRejectedValue(new Error('request timed out'));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        'request timed out',
      );

      // A timeout is ambiguous: preserve the pending attempt so the exact
      // attempt-derived Stripe idempotency key can be retried/recovered.
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'pending' },
        data: expect.objectContaining({
          status: 'pending',
          failureCode: 'local_persistence_uncertain',
        }),
      });
    });
  });

  describe('full-invoice Checkout coverage gate', () => {
    // The one-time full-invoice Checkout charges the frozen total, so it is
    // ONLY allowed while the invoice has NO coverage yet (`allocatedMicros === 0`
    // AND no succeeded-but-not-yet-allocated fixed-fee attempt). The gate is
    // charge-kind scoped: it fires exclusively in `createCheckoutSession` and
    // never blocks the fixed-fee subscription Checkout, the renewal-overage
    // worker, or the USDC remainder rail (which keep their own coverage-aware
    // semantics).

    it('rejects creating a full-invoice Checkout when the invoice already has allocated coverage', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // The invoice is finalized but a fixed-fee renewal already allocated $49
      // of coverage — a full-total Checkout would overcharge.
      invoiceFindFirst.mockResolvedValue(invoice({ allocatedMicros: 49_000_000n }));

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );

      // Fail closed before any attempt/session creation: never a full-total
      // charge on a partially-covered invoice.
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('rejects reusing a full-total Checkout session once coverage was allocated between the gate and the reuse', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // The invoice loads with no coverage (the first atomic gate passes)...
      invoiceFindFirst
        .mockResolvedValueOnce(invoice()) // initial load
        .mockResolvedValueOnce(invoice()) // first atomic gate
        .mockResolvedValue(invoice({ allocatedMicros: 49_000_000n })); // reuse re-gate
      // A pending full-invoice session exists locally (where-aware mock keeps
      // the gate's fixed-fee probe null).
      attemptFindFirst.mockImplementation(
        gateAwareFindFirst(
          attempt({
            stripeCheckoutSessionId: 'cs_old',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_old',
          }),
        ),
      );

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );

      // The reused full-total session is never handed back; no Stripe call and
      // no new attempt.
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('rejects a full-invoice Checkout while a succeeded fixed-fee renewal is pending allocation', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      // The gate's fixed-fee probe finds a succeeded-but-not-yet-allocated
      // fixed-fee attempt: a real renewal charge whose coverage has not been
      // counted yet. A full-total Checkout would double-charge.
      attemptFindFirst.mockImplementation(({ where }: any) =>
        where?.stripeChargeKind === 'fixed_fee' && where?.status === 'succeeded'
          ? Promise.resolve(
              attempt({
                id: 'att-fixed',
                stripeChargeKind: 'fixed_fee',
                status: 'succeeded',
                allocatedAt: null,
              }),
            )
          : Promise.resolve(null),
      );

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('rejects reusing a full-total Checkout session once a succeeded fixed-fee renewal appeared', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      // The first gate's fixed-fee probe sees nothing; between the gate and the
      // reuse a succeeded-but-unallocated fixed-fee attempt appears (webhook
      // confirmed before allocation). The reuse re-gate must fail closed.
      attemptFindFirst
        .mockResolvedValueOnce(null) // first gate's fixed-fee probe
        .mockImplementation(({ where }: any) =>
          where?.stripeChargeKind === 'fixed_fee' && where?.status === 'succeeded'
            ? Promise.resolve(
                attempt({
                  id: 'att-fixed',
                  stripeChargeKind: 'fixed_fee',
                  status: 'succeeded',
                  allocatedAt: null,
                }),
              )
            : Promise.resolve(
                attempt({
                  stripeCheckoutSessionId: 'cs_old',
                  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_old',
                }),
              ),
        );

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('never fires the full-invoice coverage gate on the fixed-fee subscription path (overage remainder unaffected)', async () => {
      const PRO_PLAN = {
        id: 'plan-pro',
        code: 'pro',
        version: 2,
        name: 'Pro',
        monthlyFeeMicros: 49_000_000n,
      };
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // A partially-covered dynamic invoice ($49 fixed fee allocated against a
      // $109 total): the overage remainder stays payable via the subscription
      // path's OWN rules — the full-invoice coverage gate is never invoked here.
      invoiceFindFirst.mockResolvedValue(
        invoice({
          planVersionId: PRO_PLAN.id,
          totalMicros: 109_000_000n,
          allocatedMicros: 49_000_000n,
        }),
      );
      planVersionFindUnique.mockResolvedValue(PRO_PLAN);

      await expect(
        service.createSubscriptionCheckout('user-1', 'inv-1', 'plan-pro'),
      ).rejects.toThrow(ConflictException);
      // The rejection is the subscription path's fixed-fee==total rule (dynamic
      // overage) — not the full-invoice gate: no attempt/session creation.
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });
  });

  describe('concurrent pending attempt handling', () => {
    it('returns a retryable conflict for a young in-flight pending attempt instead of creating a second one', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002());
      // The winner is still creating its Stripe session: young pending attempt
      // with no session id yet.
      attemptFindFirst.mockImplementation(
        gateAwareFindFirst(
          attempt({
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      );

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );

      // Only the initial (failed) insert happened — no second pending attempt
      // and no Stripe session.
      expect(attemptCreate).toHaveBeenCalledTimes(1);
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('releases a clearly stale pending attempt and creates a fresh one', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002()).mockResolvedValueOnce(attempt({ id: 'att-2' }));
      // The winner died long ago: stale pending attempt older than the reuse TTL.
      const stale = attempt({
        id: 'att-stale',
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });
      attemptFindFirst.mockImplementation(gateAwareFindFirst(stale));
      attemptUpdate.mockResolvedValue({ ...stale, status: 'failed' });
      userFindUnique.mockResolvedValue(null);
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      accountUpdate.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      sessionCreate.mockResolvedValue({
        id: 'cs_2',
        url: 'https://checkout.stripe.com/c/pay/cs_2',
        payment_intent: null,
      });
      attemptUpdate.mockResolvedValue(
        attempt({
          id: 'att-2',
          stripeCheckoutSessionId: 'cs_2',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2',
        }),
      );

      const result = await service.createCheckoutSession('user-1', 'inv-1');

      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'att-stale', method: 'stripe', status: 'pending' }),
        data: expect.objectContaining({
          status: 'failed',
          failureCode: 'checkout_session_creation_timeout',
        }),
      });
      expect(attemptCreate).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        invoiceId: 'inv-1',
        sessionId: 'cs_2',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2',
      });
    });

    it.each([
      'stripeCheckoutSessionId',
      'stripePaymentIntentId',
      'stripeInvoiceId',
      'stripeSubscriptionId',
      'checkoutUrl',
    ])('does not replace a stale attempt bound by %s', async (providerField) => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockImplementation(
        gateAwareFindFirst(
          attempt({
            id: 'att-bound',
            createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            [providerField]:
              providerField === 'checkoutUrl' ? 'https://stripe.test/session' : 'provider-id',
          }),
        ),
      );
      attemptCreate.mockRejectedValueOnce(p2002());

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
      // The stale release CAS is attempted once but can never match a
      // provider-bound attempt: its WHERE demands every identity column be
      // NULL, so count 0 → fail closed. Never a replacement attempt and never a
      // second session.
      expect(attemptUpdateMany).toHaveBeenCalledTimes(1);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-bound',
            method: 'stripe',
            status: 'pending',
            stripeCheckoutSessionId: null,
            stripePaymentIntentId: null,
            stripeInvoiceId: null,
            stripeSubscriptionId: null,
            checkoutUrl: null,
          }),
          data: expect.objectContaining({
            status: 'failed',
            failureCode: 'checkout_session_creation_timeout',
          }),
        }),
      );
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptCreate).toHaveBeenCalledTimes(1);
    });

    it('creates a fresh attempt when the winner released the pending slot', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockRejectedValueOnce(p2002()).mockResolvedValueOnce(attempt({ id: 'att-2' }));
      // The winner's Stripe call failed and it released the slot (no pending row).
      attemptFindFirst.mockResolvedValue(null);
      userFindUnique.mockResolvedValue(null);
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      accountUpdate.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      sessionCreate.mockResolvedValue({
        id: 'cs_2',
        url: 'https://checkout.stripe.com/c/pay/cs_2',
        payment_intent: null,
      });
      attemptUpdate.mockResolvedValue(
        attempt({
          id: 'att-2',
          stripeCheckoutSessionId: 'cs_2',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2',
        }),
      );

      const result = await service.createCheckoutSession('user-1', 'inv-1');

      expect(attemptCreate).toHaveBeenCalledTimes(2);
      expect(sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { invoiceId: 'inv-1', attemptId: 'att-2', period: '2026-05' },
        }),
        { idempotencyKey: 'checkout:att-2' },
      );
      expect(result).toEqual({
        invoiceId: 'inv-1',
        sessionId: 'cs_2',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2',
      });
    });

    it('conflicts (never double-charges) when an active USDC attempt holds the unified reservation slot', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindFirst.mockResolvedValue(invoice());
      // The initial insert and the fresh re-create are both rejected by the
      // unified active-payment index (`billing_payment_attempts_one_active_payment_per_invoice_idx`).
      attemptCreate.mockRejectedValueOnce(p2002()).mockRejectedValueOnce(p2002());
      attemptFindFirst.mockImplementation(({ where }: any) => {
        // The cross-rail conflict lookup (any active rail) finds the USDC attempt.
        if (where?.status && Array.isArray(where.status.in)) {
          return Promise.resolve({
            id: 'att-usdc-active',
            invoiceId: 'inv-1',
            method: 'usdc',
            status: 'confirming',
          });
        }
        // No reusable/pending Stripe attempt exists.
        return Promise.resolve(null);
      });

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        'An active payment of another rail is already in progress for this invoice',
      );
      expect(attemptCreate).toHaveBeenCalledTimes(2);
      expect(sessionCreate).not.toHaveBeenCalled();
    });
  });

  describe('markAttemptUnknown identity fencing', () => {
    it('applies every null-or-same identity predicate in a single AND when both PI and subscription exist', async () => {
      await (service as any).markAttemptUnknown('att-1', {
        sessionId: 'cs_1',
        checkoutUrl: 'https://stripe.test/u',
        paymentIntentId: 'pi_1',
        subscriptionId: 'sub_1',
      });

      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-1',
            status: 'pending',
            AND: expect.arrayContaining([
              { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: 'cs_1' }] },
              { OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: 'pi_1' }] },
              { OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: 'sub_1' }] },
            ]),
          }),
          data: expect.objectContaining({ failureCode: 'local_persistence_uncertain' }),
        }),
      );
    });

    it('cannot rebind a conflicting payment intent when the subscription predicate is also present', async () => {
      await (service as any).markAttemptUnknown('att-1', {
        sessionId: 'cs_1',
        checkoutUrl: 'https://stripe.test/u',
        paymentIntentId: 'pi_1',
        subscriptionId: 'sub_1',
      });

      // A single AND means a DIFFERENT persisted PI (pi_other) can never match.
      const where = (attemptUpdateMany.mock.calls.at(-1)?.[0] as any).where;
      expect(where.AND).toContainEqual({
        OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: 'pi_1' }],
      });
      expect(where.AND).toContainEqual({
        OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: 'sub_1' }],
      });
      expect(where.AND).toHaveLength(3);
    });
  });

  describe('subscription checkout — charge-kind reuse safety + plan/amount fail-closed', () => {
    const PRO_PLAN = {
      id: 'plan-pro',
      code: 'pro',
      version: 2,
      name: 'Pro',
      monthlyFeeMicros: 49_000_000n, // $49.00
      includedOutboundMicros: 100_000_000n,
      includedApiCalls: 100_000n,
      includedWallets: 1,
    };

    beforeEach(() => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      // The invoice is owned by the account, uses EXACTLY the Pro plan, and
      // its total equals the fixed fee (no overage) — the only shape that may
      // proceed to a subscription checkout.
      invoiceFindFirst.mockResolvedValue(
        invoice({ planVersionId: PRO_PLAN.id, totalMicros: PRO_PLAN.monthlyFeeMicros }),
      );
      planVersionFindUnique.mockResolvedValue(PRO_PLAN);
      customerCreate.mockResolvedValue({ id: 'cus_123' });
      attemptUpdate.mockResolvedValue(attempt());
    });

    it('rejects a one-time pending attempt instead of reusing it for a subscription', async () => {
      // No reusable fixed-fee attempt. A young one-time (full) pending attempt
      // occupies the pending slot (P2002 on insert).
      attemptFindFirst.mockResolvedValue(null); // no reusable fixed-fee session
      attemptCreate.mockRejectedValueOnce(p2002());
      attemptFindFirst.mockResolvedValue(
        attempt({
          stripeChargeKind: 'full',
          amountMicros: 49_000_000n,
          createdAt: new Date(), // young — never treated as stale
        }),
      );

      await expect(
        service.createSubscriptionCheckout('user-1', 'inv-1', 'plan-pro'),
      ).rejects.toThrow(ConflictException);
      // The one-time pending attempt was never released or reused.
      expect(attemptUpdate).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('reuses a fixed-fee pending attempt with a matching amount for a subscription', async () => {
      attemptFindFirst.mockResolvedValue(
        attempt({
          stripeChargeKind: 'fixed_fee',
          amountMicros: 49_000_000n,
          stripeCheckoutSessionId: 'cs_sub',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_sub',
        }),
      );

      const result = await service.createSubscriptionCheckout('user-1', 'inv-1', 'plan-pro');

      expect(result).toEqual({
        invoiceId: 'inv-1',
        sessionId: 'cs_sub',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_sub',
      });
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('never reuses a fixed-fee pending attempt whose amount differs from the plan fee', async () => {
      // A pending fixed-fee attempt for a different plan amount must not be
      // reused for this subscription; the insert races and a mismatch conflict
      // is raised rather than reusing the wrong amount.
      attemptFindFirst.mockResolvedValue(
        attempt({
          stripeChargeKind: 'fixed_fee',
          amountMicros: 99_000_000n,
          stripeCheckoutSessionId: 'cs_sub',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_sub',
        }),
      );
      attemptCreate.mockRejectedValueOnce(p2002());
      attemptFindFirst.mockResolvedValue(
        attempt({
          stripeChargeKind: 'fixed_fee',
          amountMicros: 99_000_000n,
          createdAt: new Date(),
        }),
      );

      await expect(
        service.createSubscriptionCheckout('user-1', 'inv-1', 'plan-pro'),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a selected plan version that does not match the owned invoice plan', async () => {
      invoiceFindFirst.mockResolvedValue(
        invoice({ planVersionId: 'plan-other', totalMicros: 49_000_000n }),
      );

      await expect(
        service.createSubscriptionCheckout('user-1', 'inv-1', 'plan-pro'),
      ).rejects.toThrow(ConflictException);
      // Fail closed before any provider call / local renewal state.
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('rejects a dynamic/overage invoice rather than attaching a smaller recurring charge', async () => {
      // Invoice total (99) exceeds the fixed fee (49): dynamic overage.
      invoiceFindFirst.mockResolvedValue(
        invoice({ planVersionId: PRO_PLAN.id, totalMicros: 99_000_000n }),
      );

      await expect(
        service.createSubscriptionCheckout('user-1', 'inv-1', 'plan-pro'),
      ).rejects.toThrow(ConflictException);
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('does not regress an already-active same-subscription mirror during recovery/persistence', async () => {
      const activeAccount = {
        ...ACCOUNT,
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_existing',
        stripeSubscriptionStatus: 'active',
      };
      accountFindUnique.mockResolvedValue(activeAccount);
      attemptFindFirst.mockResolvedValue(null);
      attemptCreate.mockResolvedValue(
        attempt({
          stripeChargeKind: 'fixed_fee',
        }),
      );
      sessionCreate.mockResolvedValue({
        id: 'cs_sub',
        url: 'https://checkout.stripe.com/c/pay/cs_sub',
        payment_intent: 'pi_sub',
        subscription: 'sub_existing',
      });

      const result = await service.createSubscriptionCheckout('user-1', 'inv-1', PRO_PLAN.id);

      expect(result.sessionId).toBe('cs_sub');
      expect(sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          mode: 'subscription',
          success_url: 'https://app.example.com/billing?checkout=success&success=1',
          cancel_url: 'https://app.example.com/billing?checkout=cancelled&canceled=1',
          subscription_data: expect.objectContaining({
            billing_cycle_anchor: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
            proration_behavior: 'none',
          }),
        }),
        expect.objectContaining({ idempotencyKey: 'subscription-checkout:att-1' }),
      );
      expect(accountUpdateMany).not.toHaveBeenCalled();
      expect(accountUpdate).not.toHaveBeenCalled();
    });
  });

  describe('bounded Checkout recovery', () => {
    function recoveryRow(overrides: Record<string, unknown> = {}) {
      return {
        ...attempt({
          stripeCheckoutSessionId: 'cs_recover',
          stripePaymentIntentId: 'pi_recover',
          checkoutUrl: null,
          checkoutRetryCount: 0,
          checkoutRetryOwnerId: 'worker-1',
          checkoutRetryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
          ...overrides,
        }),
        invoice: {
          ...invoice(),
          billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' },
        },
      };
    }

    it('rejects a retrieved session whose complete local identity does not match', async () => {
      const row = recoveryRow();
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover',
        url: 'https://stripe.test/recover',
        payment_intent: 'pi_other',
        subscription: null,
        mode: 'payment',
        amount_total: 4900,
        currency: 'usd',
        customer: 'cus_123',
        client_reference_id: 'inv-1',
        metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05' },
      });

      await service.recoverPendingCheckouts('worker-1');

      expect(sessionRetrieve).toHaveBeenCalledWith('cs_recover', { expand: ['subscription'] });
      expect(attemptUpdateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
        }),
      );
    });

    it('persists a fully proven session only while the recovery lease is active', async () => {
      const row = recoveryRow();
      attemptFindMany.mockResolvedValue([row]);
      // Post-lease re-read returns the row; the coverage gate's fixed-fee probe
      // returns null (a pending full attempt must not block its own recovery).
      attemptFindFirst.mockImplementation(gateAwareFindFirst(row));
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      // The transaction mock obtains the existing attempt from the latest
      // create-result slot; seed it without making recovery create a row.
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover',
        url: 'https://stripe.test/recover',
        payment_intent: 'pi_recover',
        subscription: null,
        mode: 'payment',
        amount_total: 4900,
        currency: 'usd',
        customer: 'cus_123',
        client_reference_id: 'inv-1',
        metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05' },
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 1, needsReview: 0, retryable: 0 });
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-1',
            status: 'pending',
            checkoutRetryOwnerId: 'worker-1',
            checkoutRetryLeaseExpiresAt: expect.objectContaining({ gt: expect.any(Date) }),
          }),
        }),
      );
    });

    it('recovers an expanded fixed-fee subscription session when payment_intent is null', async () => {
      const active = {
        ...ACCOUNT,
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_expanded',
        stripeSubscriptionStatus: 'active',
      };
      accountFindUnique.mockResolvedValue(active);
      const row = recoveryRow({
        stripeChargeKind: 'fixed_fee',
        stripeSubscriptionId: 'sub_expanded',
        stripePaymentIntentId: null,
      });
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });
      jest.spyOn(service as any, 'persistRecoveredCheckout').mockResolvedValue(undefined);
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover',
        url: 'https://stripe.test/recover',
        payment_intent: null,
        subscription: {
          id: 'sub_expanded',
          current_period_start: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
          current_period_end: Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000),
          billing_cycle_anchor: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
          extra: 'expanded',
        },
        mode: 'subscription',
        amount_total: 4900,
        currency: 'usd',
        customer: 'cus_123',
        client_reference_id: 'inv-1',
        metadata: {
          invoiceId: 'inv-1',
          attemptId: 'att-1',
          period: '2026-05',
          planVersionId: 'plan-1',
        },
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(1);
      expect(accountUpdateMany).not.toHaveBeenCalled();
    });

    it('does not recover a terminal or lease-lost attempt', async () => {
      const terminal = recoveryRow({ status: 'succeeded' });
      attemptFindMany.mockResolvedValue([terminal]);
      attemptUpdateMany.mockResolvedValue({ count: 0 });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0, retryable: 0 });
      expect(sessionRetrieve).not.toHaveBeenCalled();
    });

    it('does not create a new Checkout for a renewal attempt without a session', async () => {
      const renewal = recoveryRow({
        stripeCheckoutSessionId: null,
        stripeInvoiceId: 'in_renewal',
        stripeChargeKind: 'fixed_fee',
      });
      attemptFindMany.mockResolvedValue([renewal]);
      attemptFindFirst.mockResolvedValue(renewal); // post-lease re-read
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(0);
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { OR: [{ stripeInvoiceId: null }, { stripeCheckoutSessionId: { not: null } }] },
            ]),
          }),
        }),
      );
    });

    it('persists the newly created session id for a one-time no-session recovery', async () => {
      const row = recoveryRow({ stripeCheckoutSessionId: null, stripePaymentIntentId: null });
      attemptFindMany.mockResolvedValue([row]);
      // Post-lease re-read returns the row; the coverage gate's fixed-fee probe
      // returns null (a pending one-time attempt must not block its own
      // recovery persistence).
      attemptFindFirst.mockImplementation(gateAwareFindFirst(row));
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      accountFindUnique.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionCreate.mockResolvedValue({
        id: 'cs_new',
        url: 'https://stripe.test/new',
        payment_intent: 'pi_new',
        subscription: null,
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(1);
      // The freshly created one-time Checkout session for the recovered attempt
      // must carry the deterministic frontend return markers on the configured
      // server URLs while keeping the attempt-derived idempotency key.
      expect(sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          mode: 'payment',
          success_url: 'https://app.example.com/billing?checkout=success&success=1',
          cancel_url: 'https://app.example.com/billing?checkout=cancelled&canceled=1',
        }),
        { idempotencyKey: 'checkout:att-1' },
      );
      // The persistence CAS must carry the NEW session id, never the null the
      // attempt originally had — otherwise one-time recovery would keep
      // retrying with no local session identity.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: 'cs_new' }] },
            ]),
          }),
        }),
      );
    });

    it('persists the new session id and subscription for a fixed-fee no-session recovery', async () => {
      const row = recoveryRow({
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        stripeChargeKind: 'fixed_fee',
      });
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      accountFindUnique.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionCreate.mockResolvedValue({
        id: 'cs_new_sub',
        url: 'https://stripe.test/new',
        payment_intent: 'pi_new',
        subscription: 'sub_new',
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(1);
      // The freshly created subscription-mode Checkout session for the recovered
      // fixed-fee attempt must carry the deterministic frontend return markers
      // on the configured server URLs (subscription-checkout idempotency key).
      expect(sessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          mode: 'subscription',
          success_url: 'https://app.example.com/billing?checkout=success&success=1',
          cancel_url: 'https://app.example.com/billing?checkout=cancelled&canceled=1',
        }),
        { idempotencyKey: 'subscription-checkout:att-1' },
      );
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: 'cs_new_sub' }],
              },
            ]),
          }),
        }),
      );
    });

    it('skips recovery entirely when another rail already settled the invoice (USDC wins)', async () => {
      const row = {
        ...recoveryRow(),
        invoice: {
          ...invoice({
            settlementAttemptId: 'att-usdc',
            paidAt: new Date('2026-06-02T00:00:00.000Z'),
          }),
          billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' },
        },
      };
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read shows settled invoice
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0, retryable: 0 });
      expect(sessionRetrieve).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['void invoice', { status: 'void' }],
      ['paid invoice', { paidAt: new Date('2026-06-02T00:00:00.000Z') }],
      ['settled invoice', { settlementAttemptId: 'att-other' }],
      ['amount-mismatched invoice', { totalMicros: 99_000_000n }],
      [
        'dynamic overage invoice (fixed fee)',
        { totalMicros: 99_000_000n, monthlyFeeMicros: 49_000_000n },
      ],
    ])('makes zero Stripe calls for %s', async (_label, invoiceOverrides) => {
      const row = {
        ...recoveryRow(),
        invoice: {
          ...invoice(invoiceOverrides),
          billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' },
        },
      };
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.recoverPendingCheckouts('worker-1');

      expect(sessionRetrieve).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('does not overwrite settlement when the invoice is settled while provider work is in flight', async () => {
      const row = recoveryRow();
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read passes
      // By the time the final persistence transaction runs, another rail settled.
      invoiceFindFirst.mockResolvedValue(
        invoice({ settlementAttemptId: 'att-usdc', paidAt: new Date('2026-06-02T00:00:00.000Z') }),
      );
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover',
        url: 'https://stripe.test/recover',
        payment_intent: 'pi_recover',
        subscription: null,
        mode: 'payment',
        amount_total: 4900,
        currency: 'usd',
        customer: 'cus_123',
        client_reference_id: 'inv-1',
        metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05' },
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(0);
      expect(attemptUpdateMany).toHaveBeenCalled();
    });

    it('makes zero Stripe calls for currency mismatch on the attempt', async () => {
      const row = { ...recoveryRow(), currency: 'EUR', amountMicros: 49_000_000n };
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row);
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.recoverPendingCheckouts('worker-1');

      expect(sessionRetrieve).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('makes zero Stripe calls for a too-large (unsafe) amount', async () => {
      const row = { ...recoveryRow(), amountMicros: 900_719_925_474_099_300_000n }; // > MAX_SAFE cents
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row);
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      await service.recoverPendingCheckouts('worker-1');

      expect(sessionRetrieve).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('rejects a fixed-fee session whose billing_cycle_anchor does not match the invoice period', async () => {
      const row = {
        ...recoveryRow({
          stripeChargeKind: 'fixed_fee',
          stripeSubscriptionId: 'sub_anchor',
          stripePaymentIntentId: null,
        }),
        invoice: { ...invoice(), billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' } },
      };
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row);
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      jest.spyOn(service as any, 'persistRecoveredCheckout').mockResolvedValue(undefined);
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover',
        url: 'https://stripe.test/recover',
        payment_intent: null,
        subscription: {
          id: 'sub_anchor',
          current_period_start: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
          current_period_end: Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000),
          billing_cycle_anchor: Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000), // mismatched anchor
        },
        mode: 'subscription',
        amount_total: 4900,
        currency: 'usd',
        customer: 'cus_123',
        client_reference_id: 'inv-1',
        metadata: {
          invoiceId: 'inv-1',
          attemptId: 'att-1',
          period: '2026-05',
          planVersionId: 'plan-1',
        },
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(0);
      expect((service as any).persistRecoveredCheckout).not.toHaveBeenCalled();
    });

    it('counts a non-exhausted recovery failure as retryable while the row stays pending/retryable', async () => {
      const row = recoveryRow();
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionRetrieve.mockRejectedValue(new Error('stripe timeout'));

      const result = await service.recoverPendingCheckouts('worker-1');

      // The non-exhausted retry reschedule was persisted by THIS worker
      // (updateMany count 1): it is an explicit retryable failure, not a benign
      // miss — the row remains pending with a future backoff.
      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0, retryable: 1 });
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-1',
            status: 'pending',
            checkoutRetryOwnerId: 'worker-1',
            checkoutRetryLeaseExpiresAt: expect.objectContaining({ gt: expect.any(Date) }),
          }),
          data: expect.objectContaining({ checkoutNextRetryAt: expect.any(Date) }),
        }),
      );
    });

    it('counts an exhausted recovery transition as needsReview only when this worker owns the CAS', async () => {
      const row = recoveryRow({ checkoutRetryCount: 4 }); // 4 + 1 >= 5 → exhausted
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionRetrieve.mockRejectedValue(new Error('stripe timeout'));

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 1, retryable: 0 });
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            reviewReason: 'checkout_recovery_exhausted',
            checkoutNextRetryAt: null,
          }),
        }),
      );
    });

    it('never counts a lease/CAS-miss reschedule as a retryable failure (benign race)', async () => {
      const row = recoveryRow();
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      attemptUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // lease claim wins
        .mockResolvedValue({ count: 0 }); // reschedule CAS misses — another worker completed the attempt
      sessionRetrieve.mockRejectedValue(new Error('stripe timeout'));

      const result = await service.recoverPendingCheckouts('worker-1');

      // A CAS miss (lease lost / stale row / concurrent completion) is benign
      // and never counts as a retryable or needs_review failure.
      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0, retryable: 0 });
    });

    it('never counts an exhausted transition whose CAS misses as needsReview (benign race)', async () => {
      const row = recoveryRow({ checkoutRetryCount: 4 });
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      attemptUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // lease claim wins
        .mockResolvedValue({ count: 0 }); // exhaustion CAS misses — a concurrent processor owns the row
      sessionRetrieve.mockRejectedValue(new Error('stripe timeout'));

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0, retryable: 0 });
    });
  });

  describe('renewal overage (automatic remainder collection)', () => {
    // $49 fixed fee already allocated against a $109 finalized invoice → the
    // automatic overage must charge exactly the $60 remainder.
    const overageInvoice = (overrides: Record<string, unknown> = {}) =>
      invoice({ totalMicros: 109_000_000n, allocatedMicros: 49_000_000n, ...overrides });
    const renewalAccount = () => ({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
    const fixedFeeCoverage = {
      id: 'att-fixed',
      invoiceId: 'inv-1',
      method: 'stripe',
      stripeChargeKind: 'fixed_fee',
      status: 'succeeded',
      allocatedAt: new Date('2026-06-01T00:00:00.000Z'),
      amountMicros: 49_000_000n,
    };
    const overageAttempt = (overrides: Record<string, unknown> = {}) => ({
      id: 'att-overage',
      invoiceId: 'inv-1',
      method: 'stripe',
      status: 'pending',
      stripeChargeKind: 'overage',
      amountMicros: 60_000_000n,
      currency: 'USD',
      stripePaymentIntentId: null,
      checkoutRetryCount: 0,
      checkoutRetryOwnerId: null,
      checkoutRetryLeaseExpiresAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      ...overrides,
    });

    beforeEach(() => {
      // Differentiate the charge path's attempt lookups: the fixed-fee
      // coverage proof, the cross-rail active-USDC exclusion, and the latest
      // overage retry gate each query with a distinct where clause.
      attemptFindFirst.mockImplementation(({ where }: any) => {
        if (where?.stripeChargeKind === 'fixed_fee') return Promise.resolve(fixedFeeCoverage);
        return Promise.resolve(null);
      });
      // billingInvoice.findUnique (fresh frozen-invoice re-read) resolves to
      // the overage invoice; the remainder is 109 - 49 = 60.
      invoiceFindFirst.mockResolvedValue(overageInvoice());
      attemptCount.mockResolvedValue(0);
      attemptCreate.mockResolvedValue(overageAttempt());
      customerRetrieve.mockResolvedValue({
        id: 'cus_123',
        deleted: false,
        invoice_settings: { default_payment_method: 'pm_123' },
      });
      paymentMethodRetrieve.mockResolvedValue({ id: 'pm_123', customer: 'cus_123' });
      paymentIntentCreate.mockResolvedValue({
        id: 'pi_ov',
        status: 'succeeded',
        amount: 6000,
        currency: 'usd',
        customer: 'cus_123',
        metadata: {
          invoiceId: 'inv-1',
          attemptId: 'att-overage',
          period: '2026-05',
          chargeKind: 'overage',
        },
      });
    });

    it('charges exactly the remainder with a stable idempotency key and strict overage metadata', async () => {
      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('created');
      // The persisted attempt snapshot is exactly total - allocated.
      expect(attemptCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invoiceId: 'inv-1',
            method: 'stripe',
            status: 'pending',
            amountMicros: 60_000_000n,
            currency: 'USD',
            stripeChargeKind: 'overage',
          }),
        }),
      );
      // Off-session, confirmed, USD, default PM, stable idempotency key.
      expect(paymentIntentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 6000,
          currency: 'usd',
          customer: 'cus_123',
          payment_method: 'pm_123',
          confirm: true,
          off_session: true,
          metadata: expect.objectContaining({
            invoiceId: 'inv-1',
            attemptId: 'att-overage',
            period: '2026-05',
            chargeKind: 'overage',
          }),
        }),
        { idempotencyKey: 'overage-payment:att-overage' },
      );
      // The PaymentIntent id is persisted for webhook correlation.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-overage', status: 'pending' }),
          data: expect.objectContaining({ stripePaymentIntentId: 'pi_ov' }),
        }),
      );
    });

    it('fails closed when the customer has no provable default PaymentMethod (never guesses or charges)', async () => {
      customerRetrieve.mockResolvedValue({
        id: 'cus_123',
        deleted: false,
        invoice_settings: {},
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-overage', status: 'pending' }),
          data: expect.objectContaining({
            status: 'needs_review',
            reviewReason: 'missing_default_payment_method',
          }),
        }),
      );
    });

    it('fails closed when the account has no Stripe customer', async () => {
      const result = await service.chargeRenewalOverage(
        { ...ACCOUNT, stripeCustomerId: null },
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
      expect(customerRetrieve).not.toHaveBeenCalled();
    });

    it('skips without charging when there is no remainder or the invoice is paid', async () => {
      invoiceFindFirst
        .mockResolvedValueOnce(overageInvoice({ paidAt: new Date('2026-06-01T00:00:00.000Z') }))
        .mockResolvedValueOnce(
          overageInvoice({ totalMicros: 49_000_000n, allocatedMicros: 49_000_000n }),
        );
      await expect(
        service.chargeRenewalOverage(
          renewalAccount(),
          overageInvoice({ paidAt: new Date('2026-06-01T00:00:00.000Z') }),
          'worker-1',
        ),
      ).resolves.toBe('skipped');
      await expect(
        service.chargeRenewalOverage(
          renewalAccount(),
          overageInvoice({ totalMicros: 49_000_000n, allocatedMicros: 49_000_000n }),
          'worker-1',
        ),
      ).resolves.toBe('skipped');
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('skips when the invoice has no allocated fixed-fee coverage (manual invoice)', async () => {
      attemptFindFirst.mockResolvedValue(null);

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('skipped');
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('skips when a concurrent worker already owns the active Stripe slot', async () => {
      attemptCreate.mockRejectedValue(p2002());

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('skipped');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('enforces a bounded retry budget on repeated overage charges', async () => {
      attemptCount.mockResolvedValue(3); // already 3 prior overage attempts

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('keeps the attempt pending with the PaymentIntent id on an ambiguous provider error', async () => {
      paymentIntentCreate.mockRejectedValue(
        Object.assign(new Error('timeout'), {
          code: 'ETIMEDOUT',
          payment_intent: { id: 'pi_uncertain' },
        }),
      );

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('pending');
      // The PI id from the ambiguous response is preserved, never lost.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-overage', status: 'pending' }),
          data: expect.objectContaining({
            stripePaymentIntentId: 'pi_uncertain',
            failureCode: 'local_persistence_uncertain',
          }),
        }),
      );
    });

    it('marks the attempt failed on a definitive provider decline', async () => {
      paymentIntentCreate.mockRejectedValue(
        Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }),
      );

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('failed');
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-overage', status: 'pending' }),
          data: expect.objectContaining({ status: 'failed', failureCode: 'card_declined' }),
        }),
      );
    });

    it('rejects a returned PaymentIntent whose identity does not match the request', async () => {
      paymentIntentCreate.mockResolvedValue({
        id: 'pi_ov',
        amount: 9999, // wrong amount
        currency: 'usd',
        customer: 'cus_123',
        metadata: {
          invoiceId: 'inv-1',
          attemptId: 'att-overage',
          period: '2026-05',
          chargeKind: 'overage',
        },
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            reviewReason: 'payment_intent_identity_mismatch',
          }),
        }),
      );
    });

    it('recovery reuses the SAME attempt and idempotency key (never a second charge)', async () => {
      const pending = overageAttempt({ stripePaymentIntentId: null, checkoutRetryCount: 1 });
      attemptFindFirst.mockResolvedValue({
        ...pending,
        invoice: { ...overageInvoice(), billingAccount: renewalAccount() },
      });
      // The lease claim CAS wins; the provider call reuses the attempt id.
      attemptUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.recoverOverageCharge(pending as any, 'worker-1');

      expect(result).toBe('created');
      expect(paymentIntentCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 6000 }), {
        idempotencyKey: 'overage-payment:att-overage',
      });
      // No NEW attempt is inserted during recovery.
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('recovery skips when the PaymentIntent id is already persisted (webhook owns the outcome)', async () => {
      const pending = overageAttempt({ stripePaymentIntentId: 'pi_owned' });
      attemptFindFirst.mockResolvedValue({
        ...pending,
        invoice: { ...overageInvoice(), billingAccount: renewalAccount() },
      });

      const result = await service.recoverOverageCharge(pending as any, 'worker-1');

      expect(result).toBe('skipped');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('recovery respects checkoutNextRetryAt: a future backoff is never re-issued to Stripe', async () => {
      const pending = overageAttempt({
        stripePaymentIntentId: null,
        checkoutRetryCount: 1,
        checkoutNextRetryAt: new Date(Date.now() + 10 * 60 * 1000), // backoff still in the future
        checkoutRetryOwnerId: null,
        checkoutRetryLeaseExpiresAt: null,
      });
      attemptFindFirst.mockResolvedValue({
        ...pending,
        invoice: { ...overageInvoice(), billingAccount: renewalAccount() },
      });
      // The atomic claim CAS fails closed on the future backoff (count 0),
      // proving the guard — even though the lease is claimable.
      attemptUpdateMany.mockResolvedValue({ count: 0 });

      const result = await service.recoverOverageCharge(pending as any, 'worker-1');

      // The atomic claim CAS must fail closed on the future backoff even though
      // the 2-minute lease is already expired/claimable — no provider call.
      expect(result).toBe('skipped');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
      expect(attemptCreate).not.toHaveBeenCalled();
      // The claim updateMany carries the backoff guard.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-overage',
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
    });

    it('recovery re-issues the same idempotency key only AFTER the backoff has elapsed', async () => {
      const pending = overageAttempt({
        stripePaymentIntentId: null,
        checkoutRetryCount: 1,
        checkoutNextRetryAt: new Date(Date.now() - 1000), // backoff elapsed
        checkoutRetryOwnerId: null,
        checkoutRetryLeaseExpiresAt: null,
      });
      attemptFindFirst.mockResolvedValue({
        ...pending,
        invoice: { ...overageInvoice(), billingAccount: renewalAccount() },
      });
      attemptUpdateMany.mockResolvedValue({ count: 1 }); // lease claim wins

      const result = await service.recoverOverageCharge(pending as any, 'worker-1');

      expect(result).toBe('created');
      expect(paymentIntentCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 6000 }), {
        idempotencyKey: 'overage-payment:att-overage',
      });
      expect(attemptCreate).not.toHaveBeenCalled();
    });

    it('skips the overage charge while an ACTIVE USDC attempt exists (no cross-rail double collection)', async () => {
      attemptFindFirst.mockImplementation(({ where }: any) => {
        if (where?.stripeChargeKind === 'fixed_fee') return Promise.resolve(fixedFeeCoverage);
        if (where?.method === 'usdc') {
          return Promise.resolve({
            id: 'att-usdc-active',
            invoiceId: 'inv-1',
            method: 'usdc',
            status: 'confirming',
          });
        }
        return Promise.resolve(null);
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('skipped');
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('never marks a persisted-overage attempt failed when the PI id save fails (updateMany count 0)', async () => {
      // Stripe created AND confirmed the PaymentIntent, but the local id write
      // matched 0 rows and the reload could not prove the id. The SAME attempt
      // must stay pending with the PI id preserved — never failed, and never a
      // new attempt/new idempotency key.
      attemptUpdateMany.mockResolvedValue({ count: 0 });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('pending');
      expect(attemptCreate).toHaveBeenCalledTimes(1);
      // The PI id is preserved and the attempt stays pending with a bounded
      // retry lease (failureCode local_persistence_uncertain), not failed.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'att-overage', status: 'pending' }),
          data: expect.objectContaining({
            stripePaymentIntentId: 'pi_ov',
            failureCode: 'local_persistence_uncertain',
          }),
        }),
      );
      expect(attemptUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });

    it('keeps the same attempt pending (not failed) when the PI id persist throws an unknown DB error', async () => {
      paymentIntentCreate.mockResolvedValue({
        id: 'pi_ov',
        status: 'succeeded',
        amount: 6000,
        currency: 'usd',
        customer: 'cus_123',
        metadata: {
          invoiceId: 'inv-1',
          attemptId: 'att-overage',
          period: '2026-05',
          chargeKind: 'overage',
        },
      });
      attemptUpdateMany.mockImplementation(() => {
        throw new Error('database unavailable');
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('pending');
      expect(attemptCreate).toHaveBeenCalledTimes(1);
      // No failed transition is ever recorded for a possibly-succeeded charge.
      const allUpdates = attemptUpdateMany.mock.calls.map(
        ([a]) => (a as { data?: Record<string, unknown> })?.data,
      );
      expect(allUpdates.some((d) => d?.status === 'failed')).toBe(false);
    });

    it('marks requires_action (SCA) as needs_review instead of a forever-pending fake', async () => {
      paymentIntentCreate.mockResolvedValue({
        id: 'pi_sca',
        status: 'requires_action',
        amount: 6000,
        currency: 'usd',
        customer: 'cus_123',
        metadata: {
          invoiceId: 'inv-1',
          attemptId: 'att-overage',
          period: '2026-05',
          chargeKind: 'overage',
        },
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
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

    it('respects the retry backoff of a previously failed overage attempt', async () => {
      attemptFindFirst.mockImplementation(({ where }: any) => {
        if (where?.stripeChargeKind === 'fixed_fee') return Promise.resolve(fixedFeeCoverage);
        if (where?.stripeChargeKind === 'overage') {
          return Promise.resolve(
            overageAttempt({
              status: 'failed',
              stripePaymentIntentId: null,
              checkoutNextRetryAt: new Date(Date.now() + 10 * 60 * 1000), // future backoff
            }),
          );
        }
        return Promise.resolve(null);
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('skipped');
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('stops auto-retry after an operator-reviewed (needs_review) overage attempt', async () => {
      attemptFindFirst.mockImplementation(({ where }: any) => {
        if (where?.stripeChargeKind === 'fixed_fee') return Promise.resolve(fixedFeeCoverage);
        if (where?.stripeChargeKind === 'overage') {
          return Promise.resolve(
            overageAttempt({ status: 'needs_review', stripePaymentIntentId: null }),
          );
        }
        return Promise.resolve(null);
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(paymentIntentCreate).not.toHaveBeenCalled();
    });

    it('fails closed when the default PaymentMethod is not attached to this customer', async () => {
      paymentMethodRetrieve.mockResolvedValue({ id: 'pm_123', customer: 'cus_OTHER' });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            reviewReason: 'default_payment_method_customer_mismatch',
          }),
        }),
      );
    });

    it('fails closed on a DETACHED default PaymentMethod (customer null) — ownership must be exact', async () => {
      // A detached PaymentMethod (`customer: null`) cannot prove exact
      // ownership and must never be charged off-session.
      paymentMethodRetrieve.mockResolvedValue({ id: 'pm_detached', customer: null });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('needs_review');
      expect(paymentIntentCreate).not.toHaveBeenCalled();
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            reviewReason: 'default_payment_method_customer_mismatch',
          }),
        }),
      );
    });

    it('accepts an EXPANDED PaymentMethod whose customer object matches the account customer', async () => {
      // Stripe may return the PaymentMethod's customer as an expanded object;
      // the exact owner id must be resolved from it.
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_123',
        customer: { id: 'cus_123', object: 'customer' },
      });

      const result = await service.chargeRenewalOverage(
        renewalAccount(),
        overageInvoice(),
        'worker-1',
      );

      expect(result).toBe('created');
      expect(paymentIntentCreate).toHaveBeenCalledWith(
        expect.objectContaining({ payment_method: 'pm_123' }),
        { idempotencyKey: 'overage-payment:att-overage' },
      );
    });
  });
});

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
import { StripePaymentService } from './stripe-payment.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

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
  const attemptCreate = jest.fn();
  const attemptUpdate = jest.fn();
  const attemptUpdateMany = jest.fn();
  const planVersionFindUnique = jest.fn();
  const configGet = jest.fn();
  const customerCreate = jest.fn();
  const sessionCreate = jest.fn();
  const sessionRetrieve = jest.fn();

  const stripeMock = {
    customers: { create: customerCreate },
    checkout: { sessions: { create: sessionCreate, retrieve: sessionRetrieve } },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    accountUpdateMany.mockImplementation((args: { where: { id: string }; data: unknown }) => {
      accountUpdate({ where: { id: args.where.id }, data: args.data });
      return Promise.resolve({ count: 1 });
    });
    attemptUpdateMany.mockResolvedValue({ count: 1 });

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
                  updateMany: attemptUpdateMany.mockImplementation(({ data }: any) => {
                    if (attemptState) Object.assign(attemptState, data);
                    return Promise.resolve({ count: 1 });
                  }),
                },
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
          success_url: 'https://app.example.com/billing?checkout=success',
          cancel_url: 'https://app.example.com/billing?checkout=cancelled',
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
      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'att-1' }),
        data: expect.objectContaining({
          stripeCheckoutSessionId: 'cs_123',
          stripePaymentIntentId: 'pi_123',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
        }),
      }));
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
      // pending attempt is never reused as a Stripe checkout session.
      expect(attemptFindFirst).toHaveBeenNthCalledWith(
        1,
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
      attemptFindFirst.mockResolvedValue(
        attempt({
          stripeCheckoutSessionId: 'cs_old',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_old',
        }),
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
      attemptFindFirst.mockResolvedValue(
        attempt({
          stripeCheckoutSessionId: 'cs_winner',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_winner',
        }),
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
        data: expect.objectContaining({ status: 'pending', failureCode: 'local_persistence_uncertain' }),
      });
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
      attemptFindFirst.mockResolvedValue(
        attempt({
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
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
      attemptFindFirst.mockResolvedValue(stale);
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
      attemptFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
        attempt({
          id: 'att-bound',
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          [providerField]: providerField === 'checkoutUrl' ? 'https://stripe.test/session' : 'provider-id',
        }),
      );
      attemptCreate.mockRejectedValueOnce(p2002());

      await expect(service.createCheckoutSession('user-1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
      expect(attemptUpdateMany).not.toHaveBeenCalled();
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
  });

  describe('markAttemptUnknown identity fencing', () => {
    it('applies every null-or-same identity predicate in a single AND when both PI and subscription exist', async () => {
      await (service as any).markAttemptUnknown('att-1', {
        sessionId: 'cs_1', checkoutUrl: 'https://stripe.test/u',
        paymentIntentId: 'pi_1', subscriptionId: 'sub_1',
      });

      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
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
      }));
    });

    it('cannot rebind a conflicting payment intent when the subscription predicate is also present', async () => {
      await (service as any).markAttemptUnknown('att-1', {
        sessionId: 'cs_1', checkoutUrl: 'https://stripe.test/u',
        paymentIntentId: 'pi_1', subscriptionId: 'sub_1',
      });

      // A single AND means a DIFFERENT persisted PI (pi_other) can never match.
      const where = (attemptUpdateMany.mock.calls.at(-1)?.[0] as any).where;
      expect(where.AND).toContainEqual({ OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: 'pi_1' }] });
      expect(where.AND).toContainEqual({ OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: 'sub_1' }] });
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
      attemptCreate.mockResolvedValue(attempt({
        stripeChargeKind: 'fixed_fee',
      }));
      sessionCreate.mockResolvedValue({
        id: 'cs_sub',
        url: 'https://checkout.stripe.com/c/pay/cs_sub',
        payment_intent: 'pi_sub',
        subscription: 'sub_existing',
      });

      const result = await service.createSubscriptionCheckout('user-1', 'inv-1', PRO_PLAN.id);

      expect(result.sessionId).toBe('cs_sub');
      expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
        subscription_data: expect.objectContaining({
          billing_cycle_anchor: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
          proration_behavior: 'none',
        }),
      }), expect.any(Object));
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
        id: 'cs_recover', url: 'https://stripe.test/recover', payment_intent: 'pi_other',
        subscription: null, mode: 'payment', amount_total: 4900, currency: 'usd',
        customer: 'cus_123', client_reference_id: 'inv-1',
        metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05' },
      });

      await service.recoverPendingCheckouts('worker-1');

      expect(sessionRetrieve).toHaveBeenCalledWith('cs_recover', { expand: ['subscription'] });
      expect(attemptUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
        where: expect.objectContaining({ id: 'att-1', status: 'pending' }),
      }));
    });

    it('persists a fully proven session only while the recovery lease is active', async () => {
      const row = recoveryRow();
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      // The transaction mock obtains the existing attempt from the latest
      // create-result slot; seed it without making recovery create a row.
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover', url: 'https://stripe.test/recover', payment_intent: 'pi_recover',
        subscription: null, mode: 'payment', amount_total: 4900, currency: 'usd',
        customer: 'cus_123', client_reference_id: 'inv-1',
        metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05' },
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 1, needsReview: 0 });
      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: 'att-1', status: 'pending', checkoutRetryOwnerId: 'worker-1',
          checkoutRetryLeaseExpiresAt: expect.objectContaining({ gt: expect.any(Date) }),
        }),
      }));
    });

    it('recovers an expanded fixed-fee subscription session when payment_intent is null', async () => {
      const active = { ...ACCOUNT, stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_expanded', stripeSubscriptionStatus: 'active' };
      accountFindUnique.mockResolvedValue(active);
      const row = recoveryRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_expanded', stripePaymentIntentId: null });
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });
      jest.spyOn(service as any, 'persistRecoveredCheckout').mockResolvedValue(undefined);
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover', url: 'https://stripe.test/recover', payment_intent: null,
        subscription: {
          id: 'sub_expanded', current_period_start: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
          current_period_end: Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000),
          billing_cycle_anchor: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000), extra: 'expanded',
        }, mode: 'subscription', amount_total: 4900, currency: 'usd', customer: 'cus_123',
        client_reference_id: 'inv-1', metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05', planVersionId: 'plan-1' },
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

      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0 });
      expect(sessionRetrieve).not.toHaveBeenCalled();
    });

    it('does not create a new Checkout for a renewal attempt without a session', async () => {
      const renewal = recoveryRow({ stripeCheckoutSessionId: null, stripeInvoiceId: 'in_renewal', stripeChargeKind: 'fixed_fee' });
      attemptFindMany.mockResolvedValue([renewal]);
      attemptFindFirst.mockResolvedValue(renewal); // post-lease re-read
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(0);
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(attemptFindMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ stripeInvoiceId: null }, { stripeCheckoutSessionId: { not: null } }] },
          ]),
        }),
      }));
    });

    it('persists the newly created session id for a one-time no-session recovery', async () => {
      const row = recoveryRow({ stripeCheckoutSessionId: null, stripePaymentIntentId: null });
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      accountFindUnique.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionCreate.mockResolvedValue({
        id: 'cs_new', url: 'https://stripe.test/new', payment_intent: 'pi_new', subscription: null,
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(1);
      // The persistence CAS must carry the NEW session id, never the null the
      // attempt originally had — otherwise one-time recovery would keep
      // retrying with no local session identity.
      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: 'cs_new' }] },
          ]),
        }),
      }));
    });

    it('persists the new session id and subscription for a fixed-fee no-session recovery', async () => {
      const row = recoveryRow({ stripeCheckoutSessionId: null, stripePaymentIntentId: null, stripeChargeKind: 'fixed_fee' });
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read
      invoiceFindFirst.mockResolvedValue(invoice()); // persistence eligibility
      accountFindUnique.mockResolvedValue({ ...ACCOUNT, stripeCustomerId: 'cus_123' });
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionCreate.mockResolvedValue({
        id: 'cs_new_sub', url: 'https://stripe.test/new', payment_intent: 'pi_new', subscription: 'sub_new',
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(1);
      expect(attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: 'cs_new_sub' }] },
          ]),
        }),
      }));
    });

    it('skips recovery entirely when another rail already settled the invoice (USDC wins)', async () => {
      const row = {
        ...recoveryRow(),
        invoice: { ...invoice({ settlementAttemptId: 'att-usdc', paidAt: new Date('2026-06-02T00:00:00.000Z') }), billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' } },
      };
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row); // post-lease re-read shows settled invoice
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result).toEqual({ attempted: 1, recovered: 0, needsReview: 0 });
      expect(sessionRetrieve).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['void invoice', { status: 'void' }],
      ['paid invoice', { paidAt: new Date('2026-06-02T00:00:00.000Z') }],
      ['settled invoice', { settlementAttemptId: 'att-other' }],
      ['amount-mismatched invoice', { totalMicros: 99_000_000n }],
      ['dynamic overage invoice (fixed fee)', { totalMicros: 99_000_000n, monthlyFeeMicros: 49_000_000n }],
    ])('makes zero Stripe calls for %s', async (_label, invoiceOverrides) => {
      const row = {
        ...recoveryRow(),
        invoice: { ...invoice(invoiceOverrides), billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' } },
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
      invoiceFindFirst.mockResolvedValue(invoice({ settlementAttemptId: 'att-usdc', paidAt: new Date('2026-06-02T00:00:00.000Z') }));
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover', url: 'https://stripe.test/recover', payment_intent: 'pi_recover',
        subscription: null, mode: 'payment', amount_total: 4900, currency: 'usd',
        customer: 'cus_123', client_reference_id: 'inv-1',
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
      const row = { ...recoveryRow({ stripeChargeKind: 'fixed_fee', stripeSubscriptionId: 'sub_anchor', stripePaymentIntentId: null }), invoice: { ...invoice(), billingAccount: { ...ACCOUNT, stripeCustomerId: 'cus_123' } } };
      attemptFindMany.mockResolvedValue([row]);
      attemptFindFirst.mockResolvedValue(row);
      attemptCreate.mockResolvedValue(row);
      await attemptCreate({ data: row });
      attemptUpdateMany.mockResolvedValueOnce({ count: 1 }); // lease claim
      jest.spyOn(service as any, 'persistRecoveredCheckout').mockResolvedValue(undefined);
      sessionRetrieve.mockResolvedValue({
        id: 'cs_recover', url: 'https://stripe.test/recover', payment_intent: null,
        subscription: {
          id: 'sub_anchor', current_period_start: Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000),
          current_period_end: Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000),
          billing_cycle_anchor: Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000), // mismatched anchor
        }, mode: 'subscription', amount_total: 4900, currency: 'usd', customer: 'cus_123',
        client_reference_id: 'inv-1', metadata: { invoiceId: 'inv-1', attemptId: 'att-1', period: '2026-05', planVersionId: 'plan-1' },
      });

      const result = await service.recoverPendingCheckouts('worker-1');

      expect(result.recovered).toBe(0);
      expect((service as any).persistRecoveredCheckout).not.toHaveBeenCalled();
    });
  });
});

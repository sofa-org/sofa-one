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
  const userFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  const attemptFindFirst = jest.fn();
  const attemptCreate = jest.fn();
  const attemptUpdate = jest.fn();
  const attemptUpdateMany = jest.fn();
  const configGet = jest.fn();
  const customerCreate = jest.fn();
  const sessionCreate = jest.fn();

  const stripeMock = {
    customers: { create: customerCreate },
    checkout: { sessions: { create: sessionCreate } },
  };

  beforeEach(async () => {
    jest.resetAllMocks();

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
            billingAccount: { findUnique: accountFindUnique, update: accountUpdate },
            user: { findUnique: userFindUnique },
            billingInvoice: { findFirst: invoiceFindFirst },
            billingPaymentAttempt: {
              findFirst: attemptFindFirst,
              create: attemptCreate,
              update: attemptUpdate,
              updateMany: attemptUpdateMany,
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
      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: 'att-1' },
        data: {
          stripeCheckoutSessionId: 'cs_123',
          stripePaymentIntentId: 'pi_123',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
        },
      });
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

      // The failure update is a pending-only CAS, so a webhook-confirmed
      // success racing this failure can never regress the attempt.
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'pending' },
        data: expect.objectContaining({ status: 'failed' }),
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

      expect(attemptUpdate).toHaveBeenCalledWith({
        where: { id: 'att-stale' },
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
});

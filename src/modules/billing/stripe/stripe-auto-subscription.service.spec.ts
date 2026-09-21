import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../core/database/prisma.service';
import { STRIPE_CLIENT } from './stripe.constants';
import {
  AUTO_SUB_PM_NOT_REUSABLE_CODE,
  AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
  isPermanentPaymentMethodError,
  StripeAutoSubscriptionService,
} from './stripe-auto-subscription.service';
import { StripeSubscriptionSyncService } from './stripe-subscription-sync.service';

const ACCOUNT_ID = 'a1111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = 'b2222222-2222-4222-8222-222222222222';
const INVOICE_ID = 'c3333333-3333-4333-8333-333333333333';
const PLAN_ID = 'd4444444-4444-4444-8444-444444444444';
const USER_ID = 'e5555555-5555-4555-8555-555555555555';

const ACCOUNT = {
  id: ACCOUNT_ID,
  userId: USER_ID,
  stripeCustomerId: 'cus_123',
  stripeSubscriptionId: null as string | null,
  stripeSubscriptionStatus: null as string | null,
  currency: 'USD',
};

const PLAN_STARTER = {
  id: PLAN_ID,
  code: 'starter',
  name: 'Starter',
  monthlyFeeMicros: 49_000_000n,
};

const PLAN_FREE = {
  id: 'f6666666-6666-4666-8666-666666666666',
  code: 'free',
  name: 'Free',
  monthlyFeeMicros: 0n,
};

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    billingAccountId: ACCOUNT_ID,
    planVersionId: PLAN_ID,
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    periodEnd: new Date('2026-10-01T00:00:00.000Z'),
    purpose: 'usage_period',
    status: 'finalized',
    currency: 'USD',
    monthlyFeeMicros: 49_000_000n,
    outboundOverageMicros: 0n,
    apiOverageMicros: 0n,
    walletOverageMicros: 0n,
    totalMicros: 49_000_000n,
    allocatedMicros: 49_000_000n,
    paidAt: new Date('2026-09-18T12:00:00.000Z'),
    settlementAttemptId: ATTEMPT_ID,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    invoiceId: INVOICE_ID,
    method: 'stripe',
    status: 'succeeded',
    amountMicros: 49_000_000n,
    currency: 'USD',
    stripeChargeKind: 'full',
    stripePaymentIntentId: 'pi_123',
    ...overrides,
  };
}

function autoIntent(overrides: Record<string, unknown> = {}) {
  const effectivePeriodStart = new Date('2026-10-01T00:00:00.000Z');
  const effectivePeriodEnd = new Date('2026-11-01T00:00:00.000Z');
  const key = StripeAutoSubscriptionService.buildOperationIdempotencyKey({
    billingAccountId: ACCOUNT_ID,
    sourceAttemptId: ATTEMPT_ID,
    planVersionId: PLAN_ID,
    unitAmountCents: 4900,
    effectivePeriodStart,
  });
  return {
    id: 'g7777777-7777-4777-8777-777777777777',
    billingAccountId: ACCOUNT_ID,
    sourceInvoiceId: INVOICE_ID,
    sourceAttemptId: ATTEMPT_ID,
    planVersionId: PLAN_ID,
    stripeCustomerId: 'cus_123',
    stripePaymentMethodId: null as string | null,
    effectivePeriodStart,
    effectivePeriodEnd,
    unitAmountCents: 4900,
    currency: 'usd',
    status: 'pending',
    operationIdempotencyKey: key,
    frozenPayloadJson: {
      kind: 'create_subscription',
      unitAmountCents: 4900,
      currency: 'usd',
      billingCycleAnchorUnix: Math.floor(effectivePeriodStart.getTime() / 1000),
      planCode: 'starter',
    },
    stripeSubscriptionId: null,
    dispatchedAt: null as Date | null,
    paymentMethodSavedAt: null as Date | null,
    retryCount: 0,
    nextRetryAt: new Date(),
    leaseOwnerId: null as string | null,
    leaseExpiresAt: null as Date | null,
    lastErrorCode: null,
    lastErrorType: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('StripeAutoSubscriptionService', () => {
  let service: StripeAutoSubscriptionService;

  const planFindUnique = jest.fn();
  const autoFindUnique = jest.fn();
  const autoFindFirst = jest.fn();
  const autoFindMany = jest.fn();
  const autoCreate = jest.fn();
  const autoUpdateMany = jest.fn();
  const autoCount = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptFindMany = jest.fn();
  const accountFindUnique = jest.fn();
  const accountUpdateMany = jest.fn();
  const invoiceFindUnique = jest.fn();
  const tx = jest.fn();

  const paymentIntentRetrieve = jest.fn();
  const paymentMethodRetrieve = jest.fn();
  const paymentMethodAttach = jest.fn();
  const customerRetrieve = jest.fn();
  const customerUpdate = jest.fn();
  const productCreate = jest.fn();
  const subscriptionCreate = jest.fn();
  const subscriptionList = jest.fn();

  const stripeMock = {
    paymentIntents: { retrieve: paymentIntentRetrieve },
    paymentMethods: { retrieve: paymentMethodRetrieve, attach: paymentMethodAttach },
    customers: { retrieve: customerRetrieve, update: customerUpdate },
    products: { create: productCreate },
    subscriptions: { create: subscriptionCreate, list: subscriptionList },
  };

  const queryRaw = jest.fn();
  const planAssignmentFindFirst = jest.fn();
  const planAssignmentFindMany = jest.fn();
  const recoveryCursorFindUnique = jest.fn();
  const recoveryCursorUpsert = jest.fn();
  const enqueueFromPlanChangeInTx = jest.fn();
  const prismaMock = {
    billingPlanVersion: { findUnique: planFindUnique },
    billingAutoSubscriptionIntent: {
      findUnique: autoFindUnique,
      findFirst: autoFindFirst,
      findMany: autoFindMany,
      create: autoCreate,
      updateMany: autoUpdateMany,
      count: autoCount,
    },
    billingPaymentAttempt: {
      findUnique: attemptFindUnique,
      findMany: attemptFindMany,
    },
    billingInvoice: { findUnique: invoiceFindUnique },
    billingAccount: { findUnique: accountFindUnique, updateMany: accountUpdateMany },
    billingPlanChange: { findFirst: jest.fn().mockResolvedValue(null) },
    billingPlanAssignment: {
      findFirst: planAssignmentFindFirst,
      findMany: planAssignmentFindMany,
    },
    billingAutoSubRecoveryCursor: {
      findUnique: recoveryCursorFindUnique,
      upsert: recoveryCursorUpsert,
    },
    $transaction: tx,
    $queryRaw: queryRaw,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    autoUpdateMany.mockResolvedValue({ count: 1 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    tx.mockImplementation(async (fn: (client: typeof prismaMock) => Promise<unknown>) =>
      fn(prismaMock),
    );
    attemptFindMany.mockResolvedValue([]);
    autoFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([]);
    planAssignmentFindFirst.mockResolvedValue(null);
    planAssignmentFindMany.mockResolvedValue([]);
    recoveryCursorFindUnique.mockResolvedValue(null);
    recoveryCursorUpsert.mockResolvedValue({});
    enqueueFromPlanChangeInTx.mockResolvedValue({ intentId: 'sync-1', revision: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeAutoSubscriptionService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: STRIPE_CLIENT, useValue: stripeMock },
        {
          provide: StripeSubscriptionSyncService,
          useValue: { enqueueFromPlanChangeInTx },
        },
      ],
    }).compile();

    service = module.get(StripeAutoSubscriptionService);
  });

  describe('buildOperationIdempotencyKey', () => {
    it('produces a short deterministic key for real UUIDs (fits VARCHAR(160) + :p)', () => {
      const effectivePeriodStart = new Date('2026-10-01T00:00:00.000Z');
      const key = StripeAutoSubscriptionService.buildOperationIdempotencyKey({
        billingAccountId: ACCOUNT_ID,
        sourceAttemptId: ATTEMPT_ID,
        planVersionId: PLAN_ID,
        unitAmountCents: 4900,
        effectivePeriodStart,
      });
      expect(key).toMatch(/^as1_[0-9a-f]{64}$/);
      expect(key.length).toBe(3 + 1 + 64); // as1_ + 64 hex
      expect(`${key}:p`.length).toBeLessThanOrEqual(160);
      expect(`${key}:p`.length).toBeLessThanOrEqual(255); // Stripe limit

      const material = [
        'v1',
        ACCOUNT_ID,
        ATTEMPT_ID,
        PLAN_ID,
        '4900',
        effectivePeriodStart.toISOString(),
      ].join('|');
      expect(key).toBe(`as1_${createHash('sha256').update(material, 'utf8').digest('hex')}`);

      // Same inputs → same key (idempotent retries).
      const again = StripeAutoSubscriptionService.buildOperationIdempotencyKey({
        billingAccountId: ACCOUNT_ID,
        sourceAttemptId: ATTEMPT_ID,
        planVersionId: PLAN_ID,
        unitAmountCents: 4900,
        effectivePeriodStart,
      });
      expect(again).toBe(key);
    });
  });

  describe('isEligiblePaidInvoice', () => {
    it('accepts fixed monthly usage_period and plan_charge; rejects Free/dynamic', () => {
      expect(service.isEligiblePaidInvoice(invoice() as any, PLAN_STARTER as any)).toBe(true);
      expect(
        service.isEligiblePaidInvoice(
          invoice({ purpose: 'plan_charge', totalMicros: 25_000_000n }) as any,
          PLAN_STARTER as any,
        ),
      ).toBe(true);
      expect(
        service.isEligiblePaidInvoice(
          invoice({ monthlyFeeMicros: 0n, totalMicros: 0n }) as any,
          PLAN_FREE as any,
        ),
      ).toBe(false);
      expect(
        service.isEligiblePaidInvoice(
          invoice({ totalMicros: 99_000_000n, apiOverageMicros: 50_000_000n }) as any,
          PLAN_STARTER as any,
        ),
      ).toBe(false);
    });
  });

  describe('enqueueAfterPaidCardInTx', () => {
    const txClient = {
      billingPlanVersion: { findUnique: planFindUnique },
      billingAutoSubscriptionIntent: {
        findUnique: autoFindUnique,
        findFirst: autoFindFirst,
        create: autoCreate,
        updateMany: autoUpdateMany,
      },
      billingPlanChange: { findFirst: jest.fn().mockResolvedValue(null) },
      billingPlanAssignment: {
        findFirst: planAssignmentFindFirst,
        findMany: planAssignmentFindMany,
      },
    };

    beforeEach(() => {
      planAssignmentFindFirst.mockResolvedValue({
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        planVersion: PLAN_STARTER,
      });
      planAssignmentFindMany.mockResolvedValue([
        {
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          planVersion: PLAN_STARTER,
        },
      ]);
    });

    it('enqueues when attempt is succeeded and invoice has full paid settlement evidence', async () => {
      planFindUnique.mockResolvedValue(PLAN_STARTER);
      autoFindUnique.mockResolvedValue(null);
      autoFindFirst.mockResolvedValue(null);
      autoCreate.mockResolvedValue(autoIntent());
      const txWithPlanChange = {
        ...txClient,
        billingPlanChange: { findFirst: jest.fn().mockResolvedValue(null) },
      };

      const now = new Date('2026-09-18T15:00:00.000Z');
      const result = await service.enqueueAfterPaidCardInTx(txWithPlanChange as any, {
        account: ACCOUNT as any,
        invoice: invoice() as any,
        attempt: attempt() as any,
        now,
      });

      expect(result).toEqual({
        intentId: 'g7777777-7777-4777-8777-777777777777',
        enqueued: true,
      });
      const data = autoCreate.mock.calls[0][0].data;
      expect(data.operationIdempotencyKey).toMatch(/^as1_[0-9a-f]{64}$/);
      expect(data.effectivePeriodStart).toEqual(new Date('2026-10-01T00:00:00.000Z'));
      expect(data.sourceAttemptId).toBe(ATTEMPT_ID);
    });

    it('rejects stale pending attempt snapshots (must be succeeded)', async () => {
      const result = await service.enqueueAfterPaidCardInTx(txClient as any, {
        account: ACCOUNT as any,
        invoice: invoice() as any,
        attempt: attempt({ status: 'pending' }) as any,
      });
      expect(result).toBeNull();
      expect(autoCreate).not.toHaveBeenCalled();
    });

    it('rejects when invoice settlement evidence does not match the attempt', async () => {
      const result = await service.enqueueAfterPaidCardInTx(txClient as any, {
        account: ACCOUNT as any,
        invoice: invoice({
          settlementAttemptId: 'h8888888-8888-4888-8888-888888888888',
        }) as any,
        attempt: attempt() as any,
      });
      expect(result).toBeNull();
      expect(autoCreate).not.toHaveBeenCalled();
    });

    it('is idempotent on the same source attempt', async () => {
      planFindUnique.mockResolvedValue(PLAN_STARTER);
      autoFindUnique.mockResolvedValue(autoIntent());
      const result = await service.enqueueAfterPaidCardInTx(txClient as any, {
        account: ACCOUNT as any,
        invoice: invoice() as any,
        attempt: attempt() as any,
      });
      expect(result).toEqual({
        intentId: 'g7777777-7777-4777-8777-777777777777',
        enqueued: false,
      });
      expect(autoCreate).not.toHaveBeenCalled();
    });

    it('reuses a dispatched needs_review slot (does not create a second intent)', async () => {
      planFindUnique.mockResolvedValue(PLAN_STARTER);
      autoFindUnique.mockResolvedValue(null);
      autoFindFirst.mockResolvedValue(
        autoIntent({
          status: 'needs_review',
          dispatchedAt: new Date(),
          id: 'i9999999-9999-4999-8999-999999999999',
        }),
      );
      const result = await service.enqueueAfterPaidCardInTx(txClient as any, {
        account: ACCOUNT as any,
        invoice: invoice() as any,
        attempt: attempt() as any,
      });
      expect(result).toEqual({
        intentId: 'i9999999-9999-4999-8999-999999999999',
        enqueued: false,
      });
      expect(autoCreate).not.toHaveBeenCalled();
    });

    it('never enqueues for USDC or non-full charge kinds', async () => {
      expect(
        await service.enqueueAfterPaidCardInTx(txClient as any, {
          account: ACCOUNT as any,
          invoice: invoice() as any,
          attempt: attempt({ method: 'usdc', stripeChargeKind: null }) as any,
        }),
      ).toBeNull();
      expect(
        await service.enqueueAfterPaidCardInTx(txClient as any, {
          account: ACCOUNT as any,
          invoice: invoice() as any,
          attempt: attempt({ stripeChargeKind: 'fixed_fee' }) as any,
        }),
      ).toBeNull();
      expect(autoCreate).not.toHaveBeenCalled();
    });

    it('never enqueues when any stripeSubscriptionId is already bound', async () => {
      const result = await service.enqueueAfterPaidCardInTx(txClient as any, {
        account: {
          ...ACCOUNT,
          stripeSubscriptionId: 'sub_old',
          stripeSubscriptionStatus: 'canceled',
        } as any,
        invoice: invoice() as any,
        attempt: attempt() as any,
      });
      expect(result).toBeNull();
      expect(autoCreate).not.toHaveBeenCalled();
    });

    it('propagates P2002 without post-error queries (Postgres aborted-TX safe)', async () => {
      planFindUnique.mockResolvedValue(PLAN_STARTER);
      autoFindUnique.mockResolvedValue(null);
      autoFindFirst.mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
      autoCreate.mockRejectedValue(p2002);

      await expect(
        service.enqueueAfterPaidCardInTx(txClient as any, {
          account: ACCOUNT as any,
          invoice: invoice() as any,
          attempt: attempt() as any,
        }),
      ).rejects.toBe(p2002);
      // No recovery findUnique after the failed create.
      expect(autoFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('savePaymentMethodBestEffort', () => {
    it('attaches a Card PM and sets Customer default_payment_method under lease', async () => {
      const lease = 'lease-tok-1';
      autoFindUnique.mockResolvedValue(autoIntent({ status: 'in_flight', leaseOwnerId: lease }));
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_abc',
      });
      paymentMethodRetrieve.mockResolvedValue({ id: 'pm_abc', type: 'card', customer: null });
      paymentMethodAttach.mockResolvedValue({ id: 'pm_abc', customer: 'cus_123' });
      customerUpdate.mockResolvedValue({ id: 'cus_123' });
      customerRetrieve.mockResolvedValue({
        id: 'cus_123',
        invoice_settings: { default_payment_method: 'pm_abc' },
      });
      autoUpdateMany.mockResolvedValue({ count: 1 });

      await expect(service.savePaymentMethodBestEffort(autoIntent().id, lease)).resolves.toBe(true);
      expect(paymentMethodAttach).toHaveBeenCalledWith('pm_abc', { customer: 'cus_123' });
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ leaseOwnerId: lease }),
          data: expect.objectContaining({ stripePaymentMethodId: 'pm_abc' }),
        }),
      );
    });

    it('rejects unfenced / mismatched lease callers', async () => {
      autoFindUnique.mockResolvedValue(
        autoIntent({ status: 'in_flight', leaseOwnerId: 'owner-A' }),
      );
      await expect(service.savePaymentMethodBestEffort(autoIntent().id, 'owner-B')).resolves.toBe(
        false,
      );
      expect(paymentIntentRetrieve).not.toHaveBeenCalled();
    });

    it('fails closed when PaymentMethod type is not card', async () => {
      const lease = 'lease-tok-2';
      autoFindUnique.mockResolvedValue(autoIntent({ status: 'in_flight', leaseOwnerId: lease }));
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_link',
      });
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_link',
        type: 'link',
        customer: 'cus_123',
      });
      autoUpdateMany.mockResolvedValue({ count: 1 });

      await expect(service.savePaymentMethodBestEffort(autoIntent().id, lease)).resolves.toBe(
        false,
      );
      expect(paymentMethodAttach).not.toHaveBeenCalled();
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'payment_method_not_card',
          }),
        }),
      );
    });

    it('BILL-020: permanent detached/non-reusable PM becomes terminal_no_funds needs_review immediately', async () => {
      const lease = 'lease-tok-pm-perm';
      autoFindUnique.mockResolvedValue(
        autoIntent({
          status: 'in_flight',
          leaseOwnerId: lease,
          retryCount: 1,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      );
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_detached',
      });
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_detached',
        type: 'card',
        customer: null,
      });
      // Real installed Stripe SDK error shape (class type + rawType/raw.type).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Stripe = require('stripe') as typeof import('stripe');
      paymentMethodAttach.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message:
            'This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again.',
          code: 'resource_missing',
          param: 'payment_method',
          type: 'invalid_request_error',
        }),
      );
      autoUpdateMany.mockResolvedValue({ count: 1 });

      await expect(service.savePaymentMethodBestEffort(autoIntent().id, lease)).resolves.toBe(
        false,
      );
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            dispatchedAt: null,
            stripeSubscriptionId: null,
            leaseOwnerId: lease,
          }),
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
            lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          }),
        }),
      );
      // Must NOT schedule a generic pm_save_error retry.
      const retryWrite = autoUpdateMany.mock.calls.find(
        (c) => c[0]?.data?.lastErrorCode === 'pm_save_error',
      );
      expect(retryWrite).toBeUndefined();
    });

    it('BILL-020: retryable 429/5xx on PM attach stays pm_save_error uncertain (not terminal)', async () => {
      const lease = 'lease-tok-pm-429';
      autoFindUnique.mockResolvedValue(
        autoIntent({ status: 'in_flight', leaseOwnerId: lease, retryCount: 1 }),
      );
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_abc',
      });
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_abc',
        type: 'card',
        customer: null,
      });
      paymentMethodAttach.mockRejectedValue(
        Object.assign(new Error('rate limited'), { statusCode: 429, code: 'rate_limit' }),
      );
      autoUpdateMany.mockResolvedValue({ count: 1 });

      await expect(service.savePaymentMethodBestEffort(autoIntent().id, lease)).resolves.toBe(
        false,
      );
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastErrorCode: 'pm_save_error',
            lastErrorType: 'uncertain',
            nextRetryAt: expect.any(Date),
          }),
        }),
      );
    });

    it('BILL-020: unknown/ambiguous PM attach error stays uncertain (message alone never terminal)', async () => {
      const lease = 'lease-tok-pm-unknown';
      autoFindUnique.mockResolvedValue(
        autoIntent({ status: 'in_flight', leaseOwnerId: lease, retryCount: 1 }),
      );
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_abc',
      });
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_abc',
        type: 'card',
        customer: null,
      });
      // Message looks permanent but lacks a permanent provider code → not terminal.
      paymentMethodAttach.mockRejectedValue(
        Object.assign(new Error('This PaymentMethod may not be used again.'), {
          type: 'invalid_request_error',
        }),
      );
      autoUpdateMany.mockResolvedValue({ count: 1 });

      await expect(service.savePaymentMethodBestEffort(autoIntent().id, lease)).resolves.toBe(
        false,
      );
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastErrorCode: 'pm_save_error',
            lastErrorType: 'uncertain',
          }),
        }),
      );
      const terminalWrite = autoUpdateMany.mock.calls.find(
        (c) => c[0]?.data?.lastErrorType === AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
      );
      expect(terminalWrite).toBeUndefined();
    });

    it('BILL-020: already-dispatched intent refuses terminal CAS and stays uncertain', async () => {
      const lease = 'lease-tok-pm-dispatched';
      const dispatched = autoIntent({
        status: 'in_flight',
        leaseOwnerId: lease,
        retryCount: 1,
        dispatchedAt: new Date('2026-09-18T12:00:00.000Z'),
      });
      autoFindUnique.mockResolvedValue(dispatched);
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_dead',
      });
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_dead',
        type: 'card',
        customer: null,
      });
      // Real SDK permanent-shaped error still must not terminalize when dispatched.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Stripe = require('stripe') as typeof import('stripe');
      paymentMethodAttach.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message:
            'This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again.',
          code: 'resource_missing',
          param: 'payment_method',
          type: 'invalid_request_error',
        }),
      );
      // First write = terminal CAS (0 rows due to dispatched fence);
      // second = uncertain retry (1 row).
      autoUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

      await expect(service.savePaymentMethodBestEffort(autoIntent().id, lease)).resolves.toBe(
        false,
      );
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            dispatchedAt: null,
            stripeSubscriptionId: null,
          }),
          data: expect.objectContaining({
            lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          }),
        }),
      );
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastErrorCode: 'pm_save_error',
            lastErrorType: 'uncertain',
          }),
        }),
      );
    });
  });

  describe('isPermanentPaymentMethodError', () => {
    type RealStripeInvalidRequestError = {
      type: string;
      rawType: string;
      code?: string;
      param?: string;
      message: string;
      statusCode?: number;
      raw?: { type?: string; code?: string; param?: string; message?: string };
    };

    /** Real installed Stripe SDK constructor (not a hand-rolled plain Error). */
    function realStripeInvalidRequestError(opts: {
      message: string;
      code?: string;
      param?: string;
      statusCode?: number;
    }): RealStripeInvalidRequestError {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Stripe = require('stripe') as typeof import('stripe');
      return new Stripe.errors.StripeInvalidRequestError({
        message: opts.message,
        code: opts.code,
        param: opts.param,
        type: 'invalid_request_error',
        statusCode: opts.statusCode,
      }) as unknown as RealStripeInvalidRequestError;
    }

    it('classifies explicit permanent provider codes as permanent', () => {
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('not reusable'), {
            type: 'invalid_request_error',
            code: 'payment_method_unreusable',
          }),
        ),
      ).toBe(true);
      expect(
        isPermanentPaymentMethodError(
          Object.assign(
            new Error(
              'This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again.',
            ),
            {
              type: 'invalid_request_error',
              code: 'resource_missing',
              param: 'payment_method',
            },
          ),
        ),
      ).toBe(true);
    });

    it('BILL-020: classifies real StripeInvalidRequestError (rawType/raw.type) as permanent', () => {
      const err = realStripeInvalidRequestError({
        message:
          'This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again.',
        code: 'resource_missing',
        param: 'payment_method',
      });
      // Prove installed SDK shape: class-name type, API type on rawType/raw.type.
      expect(err.type).toBe('StripeInvalidRequestError');
      expect(err.rawType).toBe('invalid_request_error');
      expect(err.raw?.type).toBe('invalid_request_error');
      expect(err.code).toBe('resource_missing');
      expect(err.param).toBe('payment_method');
      expect(isPermanentPaymentMethodError(err)).toBe(true);
    });

    it('never terminalizes on message text alone or ambiguous codes', () => {
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('may not be used again'), {
            type: 'invalid_request_error',
          }),
        ),
      ).toBe(false);
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('was detached from a Customer'), {
            type: 'invalid_request_error',
            code: 'resource_missing',
            // wrong param — not PM-scoped
            param: 'customer',
          }),
        ),
      ).toBe(false);
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('something failed'), {
            type: 'invalid_request_error',
            code: 'parameter_invalid',
          }),
        ),
      ).toBe(false);
      // Real SDK error with wrong param must stay non-terminal.
      expect(
        isPermanentPaymentMethodError(
          realStripeInvalidRequestError({
            message: 'was detached from a Customer and may not be used again',
            code: 'resource_missing',
            param: 'customer',
          }),
        ),
      ).toBe(false);
      // Real SDK error missing allowlisted non-reusable wording stays non-terminal.
      expect(
        isPermanentPaymentMethodError(
          realStripeInvalidRequestError({
            message: 'No such payment_method: pm_missing',
            code: 'resource_missing',
            param: 'payment_method',
          }),
        ),
      ).toBe(false);
    });

    it('never treats 429/5xx/network infrastructure failures as permanent PM errors', () => {
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('rate limited'), { statusCode: 429 }),
        ),
      ).toBe(false);
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('server error'), { statusCode: 503 }),
        ),
      ).toBe(false);
      expect(
        isPermanentPaymentMethodError(
          Object.assign(new Error('may not be used again'), {
            statusCode: 500,
            code: 'payment_method_unreusable',
          }),
        ),
      ).toBe(false);
      // Real SDK rate-limit shaped status must stay non-terminal even with PM codes.
      expect(
        isPermanentPaymentMethodError(
          realStripeInvalidRequestError({
            message: 'may not be used again',
            code: 'payment_method_unreusable',
            statusCode: 429,
          }),
        ),
      ).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Stripe = require('stripe') as typeof import('stripe');
      const connectionErr = new Stripe.errors.StripeConnectionError({
        message: 'network down',
      });
      expect(isPermanentPaymentMethodError(connectionErr)).toBe(false);
    });
  });

  describe('processDue / lease fencing / retention', () => {
    /** Capture dynamic lease token from updateMany and echo it on findUnique. */
    function wireLeaseEcho(baseIntent: ReturnType<typeof autoIntent>) {
      let currentLease: string | null = null;
      autoUpdateMany.mockImplementation(async (args: { data?: any }) => {
        if (typeof args.data?.leaseOwnerId === 'string') {
          currentLease = args.data.leaseOwnerId;
        }
        return { count: 1 };
      });
      autoFindUnique.mockImplementation(async () => ({
        ...baseIntent,
        status: 'in_flight',
        leaseOwnerId: currentLease,
        stripePaymentMethodId: baseIntent.stripePaymentMethodId ?? 'pm_abc',
        paymentMethodSavedAt: baseIntent.paymentMethodSavedAt ?? new Date(),
        dispatchedAt: baseIntent.dispatchedAt,
      }));
      accountFindUnique.mockResolvedValue(ACCOUNT);
    }

    it('creates subscription with short stable key and binds provider period bounds only', async () => {
      const intent = autoIntent({
        stripePaymentMethodId: 'pm_abc',
        paymentMethodSavedAt: new Date(),
      });
      queryRaw.mockResolvedValue([]); // recovery no-op
      autoFindMany.mockResolvedValue([intent]);
      wireLeaseEcho(intent);

      productCreate.mockResolvedValue({ id: 'prod_1' });
      const anchor = Math.floor(intent.effectivePeriodStart.getTime() / 1000);
      // Mid-month create: item period is [create_time, anchor), not [anchor, next).
      const createTime = Math.floor(Date.parse('2026-09-18T15:00:00.000Z') / 1000);
      subscriptionCreate.mockResolvedValue({
        id: 'sub_new',
        status: 'active',
        customer: 'cus_123',
        billing_cycle_anchor: anchor,
        metadata: {
          autoSubscriptionIntentId: intent.id,
          billingAccountId: ACCOUNT_ID,
          sourceAttemptId: ATTEMPT_ID,
        },
        items: {
          data: [
            {
              id: 'si_1',
              current_period_start: createTime,
              current_period_end: anchor,
              price: {
                currency: 'usd',
                unit_amount: 4900,
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
        },
      });

      planAssignmentFindFirst.mockResolvedValue({
        planVersion: PLAN_STARTER,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      tx.mockImplementation(async (fn: (c: typeof prismaMock) => Promise<unknown>) =>
        fn(prismaMock),
      );

      const result = await service.processDue('worker-1', 10);
      expect(result.completed).toBe(1);
      expect(result.terminalNoFundsReview).toBe(0);
      expect(productCreate).toHaveBeenCalledWith(expect.any(Object), {
        idempotencyKey: `${intent.operationIdempotencyKey}:p`,
      });
      expect(subscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          default_payment_method: 'pm_abc',
          billing_cycle_anchor: anchor,
        }),
        { idempotencyKey: intent.operationIdempotencyKey },
      );
      // First bind uses real item bounds (create→anchor), not the future full month.
      expect(accountUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ stripeSubscriptionId: null }),
          data: expect.objectContaining({
            stripeSubscriptionId: 'sub_new',
            stripeSubscriptionPeriodStart: new Date(createTime * 1000),
            stripeSubscriptionPeriodEnd: new Date(anchor * 1000),
          }),
        }),
      );
      // Never writes webhook event-order fields.
      const bindData = accountUpdateMany.mock.calls[0][0].data;
      expect(bindData.stripeSubscriptionUpdatedAt).toBeUndefined();
      expect(bindData.stripeSubscriptionEventId).toBeUndefined();
      // Corrective sync enqueued with current paid target (not skipped).
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          billingAccountId: ACCOUNT_ID,
          defaultTargetPlanVersionId: PLAN_ID,
          sourcePlanChangeId: intent.id,
        }),
      );
    });

    it('does not overwrite webhook-owned mirror when same sub is already bound with intent proof', async () => {
      const intent = autoIntent({
        stripePaymentMethodId: 'pm_abc',
        paymentMethodSavedAt: new Date(),
      });
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      wireLeaseEcho(intent);
      accountFindUnique.mockResolvedValue({
        ...ACCOUNT,
        stripeSubscriptionId: 'sub_found',
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPeriodStart: new Date('2026-09-18T15:00:00.000Z'),
        stripeSubscriptionPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
        stripeSubscriptionUpdatedAt: new Date('2026-09-18T16:00:00.000Z'),
        stripeSubscriptionEventId: 'evt_webhook_newer',
      });
      const anchor = Math.floor(intent.effectivePeriodStart.getTime() / 1000);
      (stripeMock.subscriptions as any).retrieve = jest.fn().mockResolvedValue({
        id: 'sub_found',
        status: 'active',
        customer: 'cus_123',
        billing_cycle_anchor: anchor,
        metadata: {
          autoSubscriptionIntentId: intent.id,
          sourceAttemptId: ATTEMPT_ID,
          billingAccountId: ACCOUNT_ID,
        },
        items: {
          data: [
            {
              current_period_start: anchor,
              current_period_end: anchor + 86400 * 30,
              price: {
                currency: 'usd',
                unit_amount: 4900,
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
        },
      });
      tx.mockImplementation(async (fn: (c: typeof prismaMock) => Promise<unknown>) =>
        fn(prismaMock),
      );

      const result = await service.processDue('worker-1');
      expect(result.completed).toBe(1);
      expect(subscriptionCreate).not.toHaveBeenCalled();
      // Same-sub path: no mirror overwrite of webhook period/event fields.
      const bindCalls = accountUpdateMany.mock.calls.filter(
        (c) => c[0]?.data?.stripeSubscriptionId === 'sub_found',
      );
      // First bind only when null — already bound means zero first-bind writes.
      expect(
        bindCalls.every((c) => c[0]?.where?.stripeSubscriptionId === null) ||
          bindCalls.length === 0,
      ).toBe(true);
    });

    it('blocks create and needs_review when a terminal subscription binding exists', async () => {
      const intent = autoIntent();
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      wireLeaseEcho(intent);
      accountFindUnique.mockResolvedValue({
        ...ACCOUNT,
        stripeSubscriptionId: 'sub_canceled',
        stripeSubscriptionStatus: 'canceled',
      });

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(result.terminalNoFundsReview).toBe(0);
      expect(subscriptionCreate).not.toHaveBeenCalled();
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'terminal_subscription_binding',
          }),
        }),
      );
    });

    it('BILL-020: counts permanent PM failure as terminalNoFundsReview (not needsReview)', async () => {
      const intent = autoIntent({
        stripePaymentMethodId: null,
        paymentMethodSavedAt: null,
        dispatchedAt: null,
        stripeSubscriptionId: null,
      });
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      let currentLease: string | null = null;
      autoUpdateMany.mockImplementation(async (args: { data?: any }) => {
        if (typeof args.data?.leaseOwnerId === 'string') {
          currentLease = args.data.leaseOwnerId;
        }
        return { count: 1 };
      });
      // After PM permanent failure, intent is needs_review with terminal_no_funds.
      autoFindUnique.mockImplementation(async () => {
        if (
          autoUpdateMany.mock.calls.some(
            (c) => c[0]?.data?.lastErrorCode === AUTO_SUB_PM_NOT_REUSABLE_CODE,
          )
        ) {
          return {
            ...intent,
            status: 'needs_review',
            leaseOwnerId: currentLease,
            lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
            lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
            dispatchedAt: null,
            stripeSubscriptionId: null,
          };
        }
        return {
          ...intent,
          status: 'in_flight',
          leaseOwnerId: currentLease,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        };
      });
      accountFindUnique.mockResolvedValue(ACCOUNT);
      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
        customer: 'cus_123',
        payment_method: 'pm_dead',
      });
      paymentMethodRetrieve.mockResolvedValue({
        id: 'pm_dead',
        type: 'card',
        customer: null,
      });
      paymentMethodAttach.mockRejectedValue(
        Object.assign(
          new Error(
            'This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again.',
          ),
          {
            type: 'invalid_request_error',
            code: 'resource_missing',
            param: 'payment_method',
          },
        ),
      );

      const result = await service.processDue('worker-1');
      expect(result.terminalNoFundsReview).toBe(1);
      expect(result.needsReview).toBe(0);
      expect(result.retryable).toBe(0);
      expect(result.recoveryScanFailed).toBe(false);
      expect(subscriptionCreate).not.toHaveBeenCalled();
    });

    it('BILL-020: recovery scan infrastructure failure propagates recoveryScanFailed', async () => {
      queryRaw.mockRejectedValue(new Error('relation does not exist'));
      autoFindMany.mockResolvedValue([]);

      const result = await service.processDue('worker-1');
      expect(result.recoveryScanFailed).toBe(true);
      expect(result.attempted).toBe(0);
      expect(result.terminalNoFundsReview).toBe(0);
    });

    it('completes when live binding is proven owned by this intent', async () => {
      const intent = autoIntent({
        stripePaymentMethodId: 'pm_abc',
        paymentMethodSavedAt: new Date(),
      });
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      wireLeaseEcho(intent);
      accountFindUnique.mockResolvedValue({
        ...ACCOUNT,
        stripeSubscriptionId: 'sub_live',
        stripeSubscriptionStatus: 'active',
      });
      const anchor = Math.floor(intent.effectivePeriodStart.getTime() / 1000);
      (stripeMock.subscriptions as any).retrieve = jest.fn().mockResolvedValue({
        id: 'sub_live',
        status: 'active',
        customer: 'cus_123',
        billing_cycle_anchor: anchor,
        metadata: {
          autoSubscriptionIntentId: intent.id,
          sourceAttemptId: ATTEMPT_ID,
          billingAccountId: ACCOUNT_ID,
        },
        items: {
          data: [
            {
              current_period_start: anchor - 86400,
              current_period_end: anchor + 86400 * 20,
              price: {
                currency: 'usd',
                unit_amount: 4900,
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
        },
      });
      tx.mockImplementation(async (fn: (c: typeof prismaMock) => Promise<unknown>) =>
        fn(prismaMock),
      );

      const result = await service.processDue('worker-1');
      expect(result.completed).toBe(1);
      expect(subscriptionCreate).not.toHaveBeenCalled();
    });

    it('after idempotency retention window, looks up existing sub instead of blind create', async () => {
      const intent = autoIntent({
        dispatchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        stripePaymentMethodId: 'pm_abc',
        paymentMethodSavedAt: new Date(),
      });
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      wireLeaseEcho(intent);

      const anchor = Math.floor(intent.effectivePeriodStart.getTime() / 1000);
      const createTime = Math.floor(Date.parse('2026-09-18T15:00:00.000Z') / 1000);
      subscriptionList.mockResolvedValue({
        data: [
          {
            id: 'sub_found',
            status: 'active',
            customer: 'cus_123',
            billing_cycle_anchor: anchor,
            metadata: {
              autoSubscriptionIntentId: intent.id,
              billingAccountId: ACCOUNT_ID,
              sourceAttemptId: ATTEMPT_ID,
            },
            items: {
              data: [
                {
                  current_period_start: createTime,
                  current_period_end: anchor,
                  price: {
                    currency: 'usd',
                    unit_amount: 4900,
                    recurring: { interval: 'month', interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
      });

      const result = await service.processDue('worker-1');
      expect(result.completed).toBe(1);
      expect(subscriptionCreate).not.toHaveBeenCalled();
      expect(subscriptionList).toHaveBeenCalled();
      expect(accountUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ stripeSubscriptionId: null }),
          data: expect.objectContaining({ stripeSubscriptionId: 'sub_found' }),
        }),
      );
    });

    it('stale lease executor cannot clear a newer lease (fenced update count 0)', async () => {
      const intent = autoIntent({
        status: 'in_flight',
        leaseOwnerId: 'newer-token',
        retryCount: 2,
      });
      autoFindUnique.mockResolvedValue(intent);
      autoUpdateMany.mockResolvedValue({ count: 0 });

      attemptFindUnique.mockResolvedValue(attempt());
      paymentIntentRetrieve.mockRejectedValue(new Error('network'));

      await service.savePaymentMethodBestEffort(intent.id, 'stale-token');
      const mutating = autoUpdateMany.mock.calls.filter(
        (c) =>
          c[0]?.data?.status === 'needs_review' ||
          c[0]?.data?.lastErrorCode === 'pm_save_error' ||
          c[0]?.data?.nextRetryAt,
      );
      expect(mutating).toHaveLength(0);
    });
  });

  describe('recoverMissingPaidIntents', () => {
    it('enqueues only NOT EXISTS missing-intent candidates and advances durable cursor', async () => {
      queryRaw.mockResolvedValue([
        { id: ATTEMPT_ID, succeeded_at: new Date('2026-09-02T00:00:00.000Z') },
      ]);
      recoveryCursorFindUnique.mockResolvedValue(null);
      autoFindUnique.mockResolvedValue(null);
      planFindUnique.mockResolvedValue(PLAN_STARTER);
      accountFindUnique.mockResolvedValue(ACCOUNT);
      invoiceFindUnique.mockResolvedValue(invoice());
      attemptFindUnique.mockResolvedValue(attempt());
      autoFindFirst.mockResolvedValue(null);
      autoCreate.mockResolvedValue(autoIntent());
      // Paid Starter assignment currently active (expires at next month start).
      planAssignmentFindFirst.mockResolvedValue({
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        planVersion: PLAN_STARTER,
      });
      planAssignmentFindMany.mockResolvedValue([
        { planVersion: PLAN_STARTER, periodStart: new Date('2026-09-01T00:00:00.000Z') },
      ]);
      (prismaMock.billingPlanChange.findFirst as jest.Mock).mockResolvedValue(null);
      tx.mockImplementation(async (fn: (client: typeof prismaMock) => Promise<unknown>) =>
        fn(prismaMock),
      );

      const result = await service.recoverMissingPaidIntents('worker-1', 10);
      expect(result.enqueued).toBe(1);
      expect(queryRaw).toHaveBeenCalled();
      expect(autoCreate).toHaveBeenCalled();
      expect(recoveryCursorUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            cursorAttemptId: ATTEMPT_ID,
          }),
        }),
      );
    });

    it('advances cursor on empty batch after prior cursor (cross-tick fairness reset)', async () => {
      recoveryCursorFindUnique.mockResolvedValue({
        id: 'default',
        cursorSucceededAt: new Date('2026-09-01T00:00:00.000Z'),
        cursorAttemptId: ATTEMPT_ID,
      });
      queryRaw.mockResolvedValue([]);
      const result = await service.recoverMissingPaidIntents('worker-1', 10);
      expect(result).toEqual({ scanned: 0, enqueued: 0, skipped: 0 });
      expect(recoveryCursorUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            cursorSucceededAt: null,
            cursorAttemptId: null,
          }),
        }),
      );
    });
  });

  describe('resolveRenewalTargetPlan — first Card upgrade over Free default', () => {
    it('prefers current paid Starter assignment over older Free even when expiresAt=next month', async () => {
      const txClient = {
        billingPlanVersion: { findUnique: planFindUnique },
        billingAutoSubscriptionIntent: {
          findUnique: autoFindUnique,
          findFirst: autoFindFirst,
          create: autoCreate,
          updateMany: autoUpdateMany,
        },
        billingPlanChange: { findFirst: jest.fn().mockResolvedValue(null) },
        billingPlanAssignment: {
          findFirst: planAssignmentFindFirst,
          findMany: planAssignmentFindMany,
        },
      };
      autoFindUnique.mockResolvedValue(null);
      autoFindFirst.mockResolvedValue(null);
      // Current at now: Starter expires exactly at next month start.
      planAssignmentFindFirst.mockResolvedValue({
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        planVersion: PLAN_STARTER,
      });
      planAssignmentFindMany.mockResolvedValue([
        {
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          planVersion: PLAN_STARTER,
        },
        {
          periodStart: new Date('2026-01-01T00:00:00.000Z'),
          planVersion: PLAN_FREE,
        },
      ]);
      autoCreate.mockResolvedValue(autoIntent());

      const result = await service.enqueueAfterPaidCardInTx(txClient as any, {
        account: ACCOUNT as any,
        invoice: invoice() as any,
        attempt: attempt() as any,
        now: new Date('2026-09-18T12:00:00.000Z'),
      });
      expect(result?.enqueued).toBe(true);
      expect(autoCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: PLAN_ID,
            unitAmountCents: 4900,
          }),
        }),
      );
    });
  });

  describe('retargetPendingAutoIntentInTx', () => {
    it('parks never-dispatched pending intent as Free supersede (recoverable)', async () => {
      const txClient = {
        billingAutoSubscriptionIntent: {
          findFirst: autoFindFirst,
          updateMany: autoUpdateMany,
        },
        billingPlanVersion: { findUnique: planFindUnique },
      };
      autoFindFirst
        .mockResolvedValueOnce(autoIntent({ status: 'pending', dispatchedAt: null }))
        .mockResolvedValueOnce(null); // no other blocking
      planFindUnique.mockResolvedValue(PLAN_FREE);
      autoUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.retargetPendingAutoIntentInTx(txClient as any, {
        billingAccountId: ACCOUNT_ID,
        targetPlanVersionId: PLAN_FREE.id,
        sourcePlanChangeId: 'chg-1',
      });
      expect(result).toBeNull();
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'superseded',
            lastErrorCode: 'scheduled_free_no_subscription',
          }),
        }),
      );
    });

    it('revives Free-superseded intent with rebuilt next-month anchor (cross-month)', async () => {
      // Old Free supersede carried an October anchor; revive in mid-October → November.
      const freeSuperseded = autoIntent({
        status: 'superseded',
        dispatchedAt: null,
        lastErrorCode: 'scheduled_free_no_subscription',
        effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
        effectivePeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
      });
      const growth = {
        id: 'd4444444-4444-4444-8444-444444444499',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 99_000_000n,
      };
      const txClient = {
        billingAutoSubscriptionIntent: {
          findFirst: autoFindFirst,
          updateMany: autoUpdateMany,
        },
        billingPlanVersion: { findUnique: planFindUnique },
      };
      autoFindFirst
        .mockResolvedValueOnce(null) // no pending
        .mockResolvedValueOnce(freeSuperseded) // free supersede
        .mockResolvedValueOnce(null); // no other blocking
      planFindUnique.mockResolvedValue(growth);
      autoUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.retargetPendingAutoIntentInTx(txClient as any, {
        billingAccountId: ACCOUNT_ID,
        targetPlanVersionId: growth.id,
        sourcePlanChangeId: 'chg-revive',
        now: new Date('2026-10-15T12:00:00.000Z'),
      });
      expect(result?.intentId).toBe(freeSuperseded.id);
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending',
            planVersionId: growth.id,
            unitAmountCents: 9900,
            effectivePeriodStart: new Date('2026-11-01T00:00:00.000Z'),
            effectivePeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
            lastErrorCode: null,
            retryCount: 0,
          }),
        }),
      );
    });

    it('does not revive Free-superseded when another blocking intent occupies the account', async () => {
      const freeSuperseded = autoIntent({
        id: 'g7777777-7777-4777-8777-777777777777',
        status: 'superseded',
        dispatchedAt: null,
        lastErrorCode: 'scheduled_free_no_subscription',
      });
      const txClient = {
        billingAutoSubscriptionIntent: {
          findFirst: autoFindFirst,
          updateMany: autoUpdateMany,
        },
        billingPlanVersion: { findUnique: planFindUnique },
      };
      autoFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(freeSuperseded)
        .mockResolvedValueOnce({ id: 'blocking-in-flight' }); // other blocking
      planFindUnique.mockResolvedValue(PLAN_STARTER);

      const result = await service.retargetPendingAutoIntentInTx(txClient as any, {
        billingAccountId: ACCOUNT_ID,
        targetPlanVersionId: PLAN_ID,
        sourcePlanChangeId: 'chg-block',
      });
      expect(result).toBeNull();
      expect(autoUpdateMany).not.toHaveBeenCalled();
    });

    it('in-place retargets never-dispatched pending intent to a new paid plan', async () => {
      const growth = {
        id: 'd4444444-4444-4444-8444-444444444499',
        code: 'growth',
        name: 'Growth',
        monthlyFeeMicros: 99_000_000n,
      };
      const txClient = {
        billingAutoSubscriptionIntent: {
          findFirst: autoFindFirst,
          updateMany: autoUpdateMany,
        },
        billingPlanVersion: { findUnique: planFindUnique },
      };
      autoFindFirst
        .mockResolvedValueOnce(autoIntent({ status: 'pending', dispatchedAt: null }))
        .mockResolvedValueOnce(null); // no other blocking
      planFindUnique.mockResolvedValue(growth);
      autoUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.retargetPendingAutoIntentInTx(txClient as any, {
        billingAccountId: ACCOUNT_ID,
        targetPlanVersionId: growth.id,
        sourcePlanChangeId: 'chg-2',
        now: new Date('2026-09-18T12:00:00.000Z'),
      });
      expect(result?.intentId).toBe(autoIntent().id);
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: growth.id,
            unitAmountCents: 9900,
            effectivePeriodStart: new Date('2026-10-01T00:00:00.000Z'),
            operationIdempotencyKey: expect.stringMatching(/^as1_[0-9a-f]{64}$/),
          }),
        }),
      );
    });

    it('no-ops when intent was already dispatched', async () => {
      const txClient = {
        billingAutoSubscriptionIntent: {
          findFirst: autoFindFirst,
          updateMany: autoUpdateMany,
        },
        billingPlanVersion: { findUnique: planFindUnique },
      };
      autoFindFirst.mockResolvedValue(null);

      const result = await service.retargetPendingAutoIntentInTx(txClient as any, {
        billingAccountId: ACCOUNT_ID,
        targetPlanVersionId: PLAN_ID,
        sourcePlanChangeId: 'chg-3',
      });
      expect(result).toBeNull();
      expect(autoUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('webhook-first bound subscription ownership', () => {
    it('completes intent when live binding metadata proves this auto-intent owns the sub', async () => {
      const intent = autoIntent({
        stripePaymentMethodId: 'pm_abc',
        paymentMethodSavedAt: new Date(),
      });
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      let currentLease: string | null = null;
      autoUpdateMany.mockImplementation(async (args: { data?: any }) => {
        if (typeof args.data?.leaseOwnerId === 'string') currentLease = args.data.leaseOwnerId;
        return { count: 1 };
      });
      autoFindUnique.mockImplementation(async () => ({
        ...intent,
        status: 'in_flight',
        leaseOwnerId: currentLease,
        stripePaymentMethodId: 'pm_abc',
        paymentMethodSavedAt: new Date(),
      }));
      accountFindUnique.mockResolvedValue({
        ...ACCOUNT,
        stripeSubscriptionId: 'sub_webhook_first',
        stripeSubscriptionStatus: 'active',
      });
      const anchor = Math.floor(intent.effectivePeriodStart.getTime() / 1000);
      const createTime = Math.floor(Date.parse('2026-09-18T15:00:00.000Z') / 1000);
      (stripeMock.subscriptions as any).retrieve = jest.fn().mockResolvedValue({
        id: 'sub_webhook_first',
        status: 'active',
        customer: 'cus_123',
        billing_cycle_anchor: anchor,
        metadata: {
          autoSubscriptionIntentId: intent.id,
          sourceAttemptId: ATTEMPT_ID,
          billingAccountId: ACCOUNT_ID,
        },
        items: {
          data: [
            {
              current_period_start: createTime,
              current_period_end: anchor + 30 * 24 * 3600, // advanced past first anchor
              price: {
                currency: 'usd',
                unit_amount: 4900,
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
        },
      });
      (prismaMock.billingPlanChange.findFirst as jest.Mock).mockResolvedValue(null);
      planAssignmentFindFirst.mockResolvedValue({ planVersion: PLAN_STARTER });
      tx.mockImplementation(async (fn: (c: typeof prismaMock) => Promise<unknown>) =>
        fn(prismaMock),
      );

      const result = await service.processDue('worker-1');
      expect(result.completed).toBe(1);
      expect(subscriptionCreate).not.toHaveBeenCalled();
      expect((stripeMock.subscriptions as any).retrieve).toHaveBeenCalledWith(
        'sub_webhook_first',
        expect.any(Object),
      );
    });

    it('needs_review when live binding is a foreign subscription', async () => {
      const intent = autoIntent();
      queryRaw.mockResolvedValue([]);
      autoFindMany.mockResolvedValue([intent]);
      let currentLease: string | null = null;
      autoUpdateMany.mockImplementation(async (args: { data?: any }) => {
        if (typeof args.data?.leaseOwnerId === 'string') currentLease = args.data.leaseOwnerId;
        return { count: 1 };
      });
      autoFindUnique.mockImplementation(async () => ({
        ...intent,
        status: 'in_flight',
        leaseOwnerId: currentLease,
      }));
      accountFindUnique.mockResolvedValue({
        ...ACCOUNT,
        stripeSubscriptionId: 'sub_other',
        stripeSubscriptionStatus: 'active',
      });
      (stripeMock.subscriptions as any).retrieve = jest.fn().mockResolvedValue({
        id: 'sub_other',
        status: 'active',
        customer: 'cus_123',
        metadata: { autoSubscriptionIntentId: 'someone-else' },
        items: {
          data: [
            {
              price: {
                currency: 'usd',
                unit_amount: 4900,
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
        },
      });

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(subscriptionCreate).not.toHaveBeenCalled();
      expect(autoUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'existing_foreign_subscription',
          }),
        }),
      );
    });
  });
});

/**
 * Lightweight webhook→enqueue contract: succeeded re-read + paid evidence.
 * Full StripeWebhookService suite stays independent; this documents the
 * integration seam the webhook must satisfy after pending→succeeded CAS.
 */
describe('webhook enqueue contract (pending→succeeded)', () => {
  it('requires re-read succeeded attempt + matching settlementAttemptId', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeAutoSubscriptionService,
        {
          provide: PrismaService,
          useValue: {
            billingPlanVersion: { findUnique: jest.fn().mockResolvedValue(PLAN_STARTER) },
            billingAutoSubscriptionIntent: {
              findUnique: jest.fn().mockResolvedValue(null),
              findFirst: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockResolvedValue(autoIntent()),
            },
            billingPlanChange: { findFirst: jest.fn().mockResolvedValue(null) },
          },
        },
        { provide: STRIPE_CLIENT, useValue: null },
      ],
    }).compile();
    const svc = module.get(StripeAutoSubscriptionService);
    const tx = {
      billingPlanVersion: { findUnique: jest.fn().mockResolvedValue(PLAN_STARTER) },
      billingAutoSubscriptionIntent: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(autoIntent()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      billingPlanChange: { findFirst: jest.fn().mockResolvedValue(null) },
      billingPlanAssignment: {
        findFirst: jest.fn().mockResolvedValue({
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          planVersion: PLAN_STARTER,
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            periodStart: new Date('2026-09-01T00:00:00.000Z'),
            planVersion: PLAN_STARTER,
          },
        ]),
      },
    };

    // Simulates webhook passing the PRE-CAS pending snapshot — must not enqueue.
    const pendingSnap = attempt({ status: 'pending' });
    expect(
      await svc.enqueueAfterPaidCardInTx(tx as any, {
        account: ACCOUNT as any,
        invoice: invoice() as any,
        attempt: pendingSnap as any,
      }),
    ).toBeNull();

    // Simulates webhook re-read after CAS + paid invoice evidence — enqueues.
    const ok = await svc.enqueueAfterPaidCardInTx(tx as any, {
      account: ACCOUNT as any,
      invoice: invoice() as any,
      attempt: attempt({ status: 'succeeded' }) as any,
    });
    expect(ok?.enqueued).toBe(true);
  });
});

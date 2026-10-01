import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../core/database/prisma.service';
import { STRIPE_CLIENT } from './stripe.constants';
import { StripeSubscriptionSyncService } from './stripe-subscription-sync.service';

const ACCOUNT = {
  id: 'acc-1',
  userId: 'user-1',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  stripeSubscriptionPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
  stripeSubscriptionPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
};

const STARTER = {
  id: 'plan-starter',
  code: 'starter',
  name: 'Starter',
  monthlyFeeMicros: 49_000_000n,
};

const FREE = {
  id: 'plan-free',
  code: 'free',
  name: 'Free',
  monthlyFeeMicros: 0n,
};

function licensedSub(overrides: Record<string, unknown> = {}) {
  const periodStartSec = Math.floor(ACCOUNT.stripeSubscriptionPeriodStart.getTime() / 1000);
  const periodEndSec = Math.floor(ACCOUNT.stripeSubscriptionPeriodEnd.getTime() / 1000);
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    trial_end: null,
    schedule: null,
    pending_update: null,
    billing_cycle_anchor: periodStartSec,
    items: {
      data: [
        {
          id: 'si_1',
          quantity: 1,
          current_period_start: periodStartSec,
          current_period_end: periodEndSec,
          price: {
            id: 'price_old',
            currency: 'usd',
            type: 'recurring',
            unit_amount: 4900,
            product: 'prod_1',
            recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('StripeSubscriptionSyncService', () => {
  let service: StripeSubscriptionSyncService;

  const accountFindUnique = jest.fn();
  const planChangeFindFirst = jest.fn();
  const planVersionFindUnique = jest.fn();
  const intentUpdateMany = jest.fn();
  const intentFindFirst = jest.fn();
  const intentCreate = jest.fn();
  const intentFindMany = jest.fn();
  const intentFindUnique = jest.fn();
  const transaction = jest.fn();
  const executeRaw = jest.fn();

  const stripeRetrieve = jest.fn();
  const stripeUpdate = jest.fn();
  const stripe = {
    subscriptions: { retrieve: stripeRetrieve, update: stripeUpdate },
  };

  const tx = {
    billingAccount: { findUnique: accountFindUnique },
    billingPlanChange: { findFirst: planChangeFindFirst },
    billingPlanVersion: { findUnique: planVersionFindUnique },
    billingSubscriptionSyncIntent: {
      updateMany: intentUpdateMany,
      findFirst: intentFindFirst,
      create: intentCreate,
    },
  } as any;

  beforeEach(async () => {
    jest.resetAllMocks();
    transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      fn({ $executeRaw: executeRaw }),
    );
    executeRaw.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeSubscriptionSyncService,
        {
          provide: PrismaService,
          useValue: {
            billingAccount: { findUnique: accountFindUnique },
            billingPlanVersion: { findUnique: planVersionFindUnique },
            billingSubscriptionSyncIntent: {
              updateMany: intentUpdateMany,
              findFirst: intentFindFirst,
              findMany: intentFindMany,
              findUnique: intentFindUnique,
              create: intentCreate,
              count: jest.fn().mockResolvedValue(0),
            },
            $transaction: transaction,
          },
        },
        { provide: STRIPE_CLIENT, useValue: stripe },
      ],
    }).compile();
    service = module.get(StripeSubscriptionSyncService);
  });

  describe('enqueueFromPlanChangeInTx', () => {
    it('no-ops when account has no Stripe subscription', async () => {
      accountFindUnique.mockResolvedValue({ id: 'acc-1', stripeSubscriptionId: null });
      const result = await service.enqueueFromPlanChangeInTx(tx, {
        billingAccountId: 'acc-1',
        sourcePlanChangeId: 'chg-1',
        defaultTargetPlanVersionId: STARTER.id,
      });
      expect(result).toBeNull();
      expect(intentCreate).not.toHaveBeenCalled();
    });

    it('enqueues update_item for paid upgrade target (USDC or Stripe paid path)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planChangeFindFirst.mockResolvedValue(null);
      planVersionFindUnique.mockResolvedValue(STARTER);
      intentUpdateMany.mockResolvedValue({ count: 0 });
      intentFindFirst.mockResolvedValue(null);
      intentCreate.mockResolvedValue({ id: 'sync-1', revision: 1 });

      const result = await service.enqueueFromPlanChangeInTx(tx, {
        billingAccountId: 'acc-1',
        sourcePlanChangeId: 'chg-up',
        defaultTargetPlanVersionId: STARTER.id,
        now: new Date('2026-08-16T00:00:00.000Z'),
      });

      expect(result).toEqual({ intentId: 'sync-1', revision: 1 });
      // ACCOUNT period is Aug→Sep: expected validates current window; effective
      // is the next renewal month Sep→Oct.
      expect(intentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'update_item',
            status: 'pending',
            targetUnitAmountCents: 4900,
            stripeSubscriptionId: 'sub_1',
            targetPlanVersionId: STARTER.id,
            expectedPeriodStart: ACCOUNT.stripeSubscriptionPeriodStart,
            expectedPeriodEnd: ACCOUNT.stripeSubscriptionPeriodEnd,
            effectivePeriodStart: new Date('2026-09-01T00:00:00.000Z'),
            effectivePeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
            operationIdempotencyKey: expect.stringContaining('sub-sync:acc-1:r1:update_item'),
            frozenPayloadJson: expect.objectContaining({
              expectedPeriodStart: '2026-08-01T00:00:00.000Z',
              expectedPeriodEnd: '2026-09-01T00:00:00.000Z',
              effectivePeriodStart: '2026-09-01T00:00:00.000Z',
              effectivePeriodEnd: '2026-10-01T00:00:00.000Z',
            }),
          }),
        }),
      );
    });

    it('scheduled Free wins over upgrade default for next renewal (cancel_at_period_end)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planChangeFindFirst.mockResolvedValue({
        toPlanVersion: FREE,
        toPlanVersionId: FREE.id,
      });
      intentUpdateMany.mockResolvedValue({ count: 0 });
      intentFindFirst.mockResolvedValue({ revision: 2 });
      intentCreate.mockResolvedValue({ id: 'sync-3', revision: 3 });

      await service.enqueueFromPlanChangeInTx(tx, {
        billingAccountId: 'acc-1',
        sourcePlanChangeId: 'chg-up',
        defaultTargetPlanVersionId: STARTER.id,
        now: new Date('2026-08-16T00:00:00.000Z'),
      });

      expect(intentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'cancel_at_period_end',
            targetPlanVersionId: null,
            targetUnitAmountCents: null,
            revision: 3,
          }),
        }),
      );
    });

    it('supersedes only never-dispatched pending intents (not in_flight/uncertain)', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planChangeFindFirst.mockResolvedValue(null);
      planVersionFindUnique.mockResolvedValue(STARTER);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindFirst.mockResolvedValue({ revision: 1 });
      intentCreate.mockResolvedValue({ id: 'sync-2', revision: 2 });

      await service.enqueueFromPlanChangeInTx(tx, {
        billingAccountId: 'acc-1',
        sourcePlanChangeId: 'chg-2',
        defaultTargetPlanVersionId: STARTER.id,
      });

      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'pending',
            dispatchedAt: null,
          }),
          data: expect.objectContaining({ status: 'superseded' }),
        }),
      );
    });

    it('enqueues a newer pending revision while an older in_flight/uncertain remains', async () => {
      accountFindUnique.mockResolvedValue(ACCOUNT);
      planChangeFindFirst.mockResolvedValue(null);
      planVersionFindUnique.mockResolvedValue(STARTER);
      // Supersede only never-dispatched pending (in_flight r1 untouched).
      intentUpdateMany.mockResolvedValue({ count: 0 });
      intentFindFirst.mockResolvedValue({ revision: 1 });
      intentCreate.mockResolvedValue({ id: 'sync-2', revision: 2 });

      const result = await service.enqueueFromPlanChangeInTx(tx, {
        billingAccountId: 'acc-1',
        sourcePlanChangeId: 'chg-2',
        defaultTargetPlanVersionId: STARTER.id,
        now: new Date('2026-08-16T00:00:00.000Z'),
      });

      expect(result).toEqual({ intentId: 'sync-2', revision: 2 });
      expect(intentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            revision: 2,
            status: 'pending',
            frozenPayloadJson: expect.objectContaining({
              stripeSubscriptionItemId: null,
              stripeProductId: null,
              targetUnitAmountCents: 4900,
            }),
          }),
        }),
      );
      // Must not attempt to mark in_flight rows superseded.
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pending', dispatchedAt: null }),
        }),
      );
    });
  });

  describe('processDue', () => {
    const pendingIntent = {
      id: 'sync-1',
      billingAccountId: 'acc-1',
      revision: 1,
      kind: 'update_item',
      status: 'pending',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      stripeSubscriptionItemId: null,
      targetPlanVersionId: STARTER.id,
      targetUnitAmountCents: 4900,
      targetCurrency: 'usd',
      expectedPeriodStart: ACCOUNT.stripeSubscriptionPeriodStart,
      expectedPeriodEnd: ACCOUNT.stripeSubscriptionPeriodEnd,
      operationIdempotencyKey: 'sub-sync:acc-1:r1:update_item:plan-starter:4900',
      frozenPayloadJson: { kind: 'update_item', targetUnitAmountCents: 4900 },
      dispatchedAt: null,
      retryCount: 0,
      nextRetryAt: new Date(),
      leaseOwnerId: null,
      leaseExpiresAt: null,
    };

    const frozenBase = {
      kind: 'update_item',
      targetUnitAmountCents: 4900,
      targetCurrency: 'usd',
      interval: 'month',
      intervalCount: 1,
      quantity: 1,
      stripeSubscriptionItemId: null as string | null,
      stripeProductId: null as string | null,
    };

    const updatedSub = () =>
      licensedSub({
        items: {
          data: [
            {
              id: 'si_1',
              quantity: 1,
              current_period_start: Math.floor(
                ACCOUNT.stripeSubscriptionPeriodStart.getTime() / 1000,
              ),
              current_period_end: Math.floor(
                ACCOUNT.stripeSubscriptionPeriodEnd.getTime() / 1000,
              ),
              price: {
                id: 'price_new',
                currency: 'usd',
                type: 'recurring',
                unit_amount: 4900,
                product: 'prod_1',
                recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
              },
            },
          ],
        },
      });

    it('updates existing item by id with no proration and no anchor reset', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null); // no older unresolved
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(licensedSub());
      stripeUpdate.mockResolvedValue(updatedSub());

      const result = await service.processDue('worker-1', 10);

      expect(result.synced).toBe(1);
      expect(stripeUpdate).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          proration_behavior: 'none',
          billing_cycle_anchor: 'unchanged',
          cancel_at_period_end: false,
          items: [
            expect.objectContaining({
              id: 'si_1',
              quantity: 1,
              price_data: expect.objectContaining({
                unit_amount: 4900,
                product: 'prod_1',
                recurring: { interval: 'month', interval_count: 1 },
              }),
            }),
          ],
        }),
        { idempotencyKey: pendingIntent.operationIdempotencyKey },
      );
      const itemsArg = stripeUpdate.mock.calls[0][1].items;
      expect(itemsArg).toHaveLength(1);
      expect(itemsArg[0].id).toBe('si_1');
      // Seals item+product into frozen payload before provider call.
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stripeSubscriptionItemId: 'si_1',
            frozenPayloadJson: expect.objectContaining({
              stripeSubscriptionItemId: 'si_1',
              stripeProductId: 'prod_1',
            }),
          }),
        }),
      );
    });

    it('sets cancel_at_period_end for Free without zero-price item', async () => {
      const cancelIntent = {
        ...pendingIntent,
        kind: 'cancel_at_period_end',
        targetPlanVersionId: null,
        targetUnitAmountCents: null,
        operationIdempotencyKey: 'sub-sync:acc-1:r1:cancel_at_period_end:plan-free:0',
        frozenPayloadJson: { kind: 'cancel_at_period_end', stripeSubscriptionItemId: null },
      };
      intentFindMany.mockResolvedValue([cancelIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...cancelIntent,
        status: 'in_flight',
        retryCount: 1,
      });
      stripeRetrieve.mockResolvedValue(licensedSub());
      stripeUpdate.mockResolvedValue(
        licensedSub({
          cancel_at_period_end: true,
          items: {
            data: [
              {
                ...licensedSub().items.data[0],
                current_period_end: Math.floor(
                  ACCOUNT.stripeSubscriptionPeriodEnd.getTime() / 1000,
                ),
              },
            ],
          },
        }),
      );

      const result = await service.processDue('worker-1');

      expect(result.synced).toBe(1);
      expect(stripeUpdate).toHaveBeenCalledWith(
        'sub_1',
        { cancel_at_period_end: true },
        { idempotencyKey: cancelIntent.operationIdempotencyKey },
      );
    });

    it('marks needs_review on unsupported multi-item shape', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          items: {
            data: [
              licensedSub().items.data[0],
              { ...licensedSub().items.data[0], id: 'si_2' },
            ],
          },
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(stripeUpdate).not.toHaveBeenCalled();
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'unsupported_item_count',
          }),
        }),
      );
    });

    it('keeps in_flight/uncertain on provider timeout (does not drop to pending)', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        dispatchedAt: new Date(),
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(licensedSub());
      stripeUpdate.mockRejectedValue(new Error('timeout'));

      const result = await service.processDue('worker-1');
      expect(result.retryable).toBe(1);
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'in_flight',
            lastErrorType: 'uncertain',
          }),
        }),
      );
    });

    it('does not claim synced when completion CAS loses ownership', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // lease
        .mockResolvedValueOnce({ count: 1 }) // freeze item/product seal
        .mockResolvedValueOnce({ count: 0 }); // completion CAS lost
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
        dispatchedAt: new Date(),
      });
      stripeRetrieve.mockResolvedValue(licensedSub());
      stripeUpdate.mockResolvedValue(updatedSub());

      const result = await service.processDue('worker-1');
      expect(result.synced).toBe(0);
    });

    it('surfaces outstanding work when Stripe is not configured', async () => {
      const module2 = await Test.createTestingModule({
        providers: [
          StripeSubscriptionSyncService,
          {
            provide: PrismaService,
            useValue: {
              billingSubscriptionSyncIntent: {
                count: jest.fn().mockResolvedValue(2),
                updateMany: intentUpdateMany,
                findMany: intentFindMany,
              },
              $transaction: transaction,
            },
          },
          { provide: STRIPE_CLIENT, useValue: null },
        ],
      }).compile();
      const bare = module2.get(StripeSubscriptionSyncService);
      intentUpdateMany.mockResolvedValue({ count: 2 });
      const result = await bare.processDue('worker-1');
      expect(result.retryable).toBe(2);
      expect(result.attempted).toBe(2);
    });

    it('does not dispatch a newer pending while an older unresolved revision exists', async () => {
      const newerPending = {
        ...pendingIntent,
        id: 'sync-2',
        revision: 2,
        operationIdempotencyKey: 'sub-sync:acc-1:r2:update_item:plan-starter:4900',
      };
      intentFindMany.mockResolvedValue([newerPending]);
      // Older r1 still in_flight/uncertain
      intentFindFirst.mockResolvedValue({ id: 'sync-1', revision: 1 });

      const result = await service.processDue('worker-1');
      expect(result.synced).toBe(0);
      expect(result.attempted).toBe(1);
      expect(stripeRetrieve).not.toHaveBeenCalled();
      expect(stripeUpdate).not.toHaveBeenCalled();
      // Must not lease the newer row.
      expect(intentUpdateMany).not.toHaveBeenCalled();
    });

    it('retries uncertain in_flight with the exact frozen item/product payload', async () => {
      const frozenRetry = {
        ...frozenBase,
        stripeSubscriptionItemId: 'si_1',
        stripeProductId: 'prod_frozen',
        targetUnitAmountCents: 4900,
        targetCurrency: 'usd',
      };
      const inFlight = {
        ...pendingIntent,
        status: 'in_flight',
        dispatchedAt: new Date('2026-08-16T01:00:00.000Z'),
        stripeSubscriptionItemId: 'si_1',
        retryCount: 2,
        leaseExpiresAt: new Date(0), // expired lease → retryable
        frozenPayloadJson: frozenRetry,
      };
      intentFindMany.mockResolvedValue([inFlight]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...inFlight,
        status: 'in_flight',
        leaseOwnerId: 'worker-1',
        retryCount: 3,
      });
      // Retrieve returns a *different* product — retry must ignore it.
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          items: {
            data: [
              {
                ...licensedSub().items.data[0],
                price: {
                  ...licensedSub().items.data[0].price,
                  product: 'prod_mutated_live',
                },
              },
            ],
          },
        }),
      );
      stripeUpdate.mockResolvedValue(updatedSub());

      const result = await service.processDue('worker-1');
      expect(result.synced).toBe(1);
      expect(stripeUpdate).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          items: [
            expect.objectContaining({
              id: 'si_1',
              price_data: expect.objectContaining({
                product: 'prod_frozen',
                unit_amount: 4900,
                recurring: { interval: 'month', interval_count: 1 },
              }),
            }),
          ],
        }),
        { idempotencyKey: inFlight.operationIdempotencyKey },
      );
    });

    it('marks needs_review when item current_period_start !== expectedPeriodStart', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      const wrongStart = Math.floor(ACCOUNT.stripeSubscriptionPeriodStart.getTime() / 1000) + 86400;
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          billing_cycle_anchor: wrongStart,
          items: {
            data: [
              {
                ...licensedSub().items.data[0],
                current_period_start: wrongStart,
              },
            ],
          },
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(stripeUpdate).not.toHaveBeenCalled();
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'period_start_mismatch',
          }),
        }),
      );
    });

    it('marks needs_review when billing_cycle_anchor !== expectedPeriodStart', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          billing_cycle_anchor:
            Math.floor(ACCOUNT.stripeSubscriptionPeriodStart.getTime() / 1000) + 3600,
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(stripeUpdate).not.toHaveBeenCalled();
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'billing_cycle_anchor_mismatch',
          }),
        }),
      );
    });

    it('marks needs_review when item period bounds are missing', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          items: {
            data: [
              {
                id: 'si_1',
                quantity: 1,
                // missing current_period_start / current_period_end
                price: licensedSub().items.data[0].price,
              },
            ],
          },
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(stripeUpdate).not.toHaveBeenCalled();
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'item_period_bounds_missing',
          }),
        }),
      );
    });

    it('marks needs_review on quarterly (interval_count !== 1) shape', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          items: {
            data: [
              {
                ...licensedSub().items.data[0],
                price: {
                  ...licensedSub().items.data[0].price,
                  recurring: { interval: 'month', interval_count: 3, usage_type: 'licensed' },
                },
              },
            ],
          },
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(stripeUpdate).not.toHaveBeenCalled();
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'interval_count_not_1',
          }),
        }),
      );
    });

    it('marks needs_review when subscription has a pending_update', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(
        licensedSub({
          pending_update: { subscription_items: [{ id: 'si_1' }] },
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(stripeUpdate).not.toHaveBeenCalled();
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'subscription_pending_update',
          }),
        }),
      );
    });

    it('marks needs_review when post-update response amount mismatches frozen payload', async () => {
      intentFindMany.mockResolvedValue([pendingIntent]);
      intentFindFirst.mockResolvedValue(null);
      intentUpdateMany.mockResolvedValue({ count: 1 });
      intentFindUnique.mockResolvedValue({
        ...pendingIntent,
        status: 'in_flight',
        retryCount: 1,
        frozenPayloadJson: { ...frozenBase },
      });
      stripeRetrieve.mockResolvedValue(licensedSub());
      stripeUpdate.mockResolvedValue(
        licensedSub({
          items: {
            data: [
              {
                ...licensedSub().items.data[0],
                price: {
                  ...licensedSub().items.data[0].price,
                  id: 'price_wrong',
                  unit_amount: 9900, // not frozen 4900
                },
              },
            ],
          },
        }),
      );

      const result = await service.processDue('worker-1');
      expect(result.needsReview).toBe(1);
      expect(result.synced).toBe(0);
      expect(intentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'needs_review',
            lastErrorCode: 'response_amount_mismatch',
          }),
        }),
      );
    });
  });
});

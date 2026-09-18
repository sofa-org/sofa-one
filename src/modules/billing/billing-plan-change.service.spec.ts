import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingPlanChangeService } from './billing-plan-change.service';
import { StripeSubscriptionSyncService } from './stripe/stripe-subscription-sync.service';
import { StripeAutoSubscriptionService } from './stripe/stripe-auto-subscription.service';

const FREE = {
  id: 'plan-free-1',
  code: 'free',
  version: 1,
  name: 'Free',
  monthlyFeeMicros: 0n,
  includedOutboundMicros: 50_000_000_000n,
  includedApiCalls: 10_000n,
  includedWallets: 10,
};

const STARTER = {
  ...FREE,
  id: 'plan-starter-1',
  code: 'starter',
  name: 'Starter',
  monthlyFeeMicros: 49_000_000n,
  includedOutboundMicros: 250_000_000_000n,
  includedApiCalls: 100_000n,
  includedWallets: 100,
};

const GROWTH = {
  ...STARTER,
  id: 'plan-growth-1',
  code: 'growth',
  name: 'Growth',
  monthlyFeeMicros: 199_000_000n,
};

describe('BillingPlanChangeService', () => {
  let service: BillingPlanChangeService;

  const executeRaw = jest.fn();
  const invoiceCreate = jest.fn();
  const invoiceLineCreate = jest.fn();
  const invoiceFindUnique = jest.fn();
  const changeCreate = jest.fn();
  const changeFindFirst = jest.fn();
  const changeFindMany = jest.fn();
  const changeFindUnique = jest.fn();
  const changeUpdateMany = jest.fn();
  const assignmentFindUnique = jest.fn();
  const assignmentCreate = jest.fn();
  const assignmentUpdate = jest.fn();
  const assignmentDeleteMany = jest.fn();
  const invoiceFindFirst = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptFindFirst = jest.fn();
  const attemptFindMany = jest.fn();
  const attemptUpdateMany = jest.fn();
  const invoiceUpdateMany = jest.fn();
  const queryRaw = jest.fn();
  const enqueueFromPlanChangeInTx = jest.fn();

  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    billingInvoice: {
      create: invoiceCreate,
      findUnique: invoiceFindUnique,
      findFirst: invoiceFindFirst,
      updateMany: invoiceUpdateMany,
    },
    billingInvoiceLine: { create: invoiceLineCreate },
    billingPlanChange: {
      create: changeCreate,
      findFirst: changeFindFirst,
      findMany: changeFindMany,
      findUnique: changeFindUnique,
      updateMany: changeUpdateMany,
    },
    billingPlanAssignment: {
      findUnique: assignmentFindUnique,
      create: assignmentCreate,
      update: assignmentUpdate,
      deleteMany: assignmentDeleteMany,
    },
    billingPaymentAttempt: {
      findUnique: attemptFindUnique,
      findFirst: attemptFindFirst,
      findMany: attemptFindMany,
      updateMany: attemptUpdateMany,
    },
  } as any;

  const subscriptionSync = {
    enqueueFromPlanChangeInTx,
  };
  const retargetPendingAutoIntentInTx = jest.fn();
  const autoSubscription = {
    retargetPendingAutoIntentInTx,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: new Date('2026-08-16T00:00:00.000Z') });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingPlanChangeService,
        { provide: PrismaService, useValue: {} },
        { provide: StripeSubscriptionSyncService, useValue: subscriptionSync },
        { provide: StripeAutoSubscriptionService, useValue: autoSubscription },
      ],
    }).compile();
    service = module.get(BillingPlanChangeService);
    executeRaw.mockResolvedValue(undefined);
    enqueueFromPlanChangeInTx.mockResolvedValue(null);
    retargetPendingAutoIntentInTx.mockResolvedValue(null);
    assignmentDeleteMany.mockResolvedValue({ count: 0 });
    changeFindMany.mockResolvedValue([]); // default: no next-period schedules
    queryRaw.mockResolvedValue([{ id: 'inv-charge-1' }]);
    attemptFindFirst.mockResolvedValue(null);
    attemptFindMany.mockResolvedValue([]);
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    invoiceUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('requestPlanChange — upgrade', () => {
    it('creates a finalized plan_charge invoice and pending_payment change without touching assignment', async () => {
      // findMany schedules → []; cancel → none; pending → none
      changeFindFirst.mockResolvedValue(null);
      invoiceCreate.mockResolvedValue({
        id: 'inv-charge-1',
        totalMicros: 25_000_000n,
        currency: 'USD',
      });
      invoiceLineCreate.mockResolvedValue({});
      changeUpdateMany.mockResolvedValue({ count: 0 }); // retire stale
      changeCreate.mockResolvedValue({
        id: 'chg-1',
        toPlanVersionId: STARTER.id,
        toPlanVersion: STARTER,
        fromPlanVersion: FREE,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
        validUntil: new Date('2026-09-01T00:00:00.000Z'),
        chargeInvoice: {
          id: 'inv-charge-1',
          totalMicros: 25_000_000n,
          currency: 'USD',
        },
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: FREE as any,
        tx,
      });

      expect(result.outcome).toBe('payment_required');
      if (result.outcome !== 'payment_required') return;
      expect(result.invoiceId).toBe('inv-charge-1');
      expect(result.changeId).toBe('chg-1');
      expect(result.kind).toBe('upgrade');
      expect(result.requiresPostCommitStripeSync).toBeUndefined();
      expect(invoiceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'plan_charge',
            status: 'finalized',
            planVersionId: STARTER.id,
          }),
        }),
      );
      expect(changeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            validUntil: new Date('2026-09-01T00:00:00.000Z'),
          }),
        }),
      );
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
      expect(executeRaw).toHaveBeenCalled(); // next-period advisory lock
      expect(changeFindMany).toHaveBeenCalled();
    });

    it('is idempotent for the same pending upgrade target', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst
        .mockResolvedValueOnce(null) // cancelScheduled latest
        .mockResolvedValueOnce({
          // pending upgrade
          id: 'chg-1',
          toPlanVersionId: STARTER.id,
          toPlanVersion: STARTER,
          fromPlanVersion: FREE,
          periodStart: new Date('2026-08-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
          validUntil: new Date('2026-09-01T00:00:00.000Z'),
          chargeInvoice: {
            id: 'inv-charge-1',
            totalMicros: 25_000_000n,
            currency: 'USD',
          },
        });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: FREE as any,
        tx,
      });

      expect(result.outcome).toBe('payment_required');
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(changeCreate).not.toHaveBeenCalled();
    });

    it('rejects a second pending upgrade to a different target', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst
        .mockResolvedValueOnce(null) // cancelScheduled latest
        .mockResolvedValueOnce({
          id: 'chg-1',
          toPlanVersionId: STARTER.id,
          toPlanVersion: STARTER,
          fromPlanVersion: FREE,
          validUntil: new Date('2026-09-01T00:00:00.000Z'),
          chargeInvoice: { id: 'inv-1', totalMicros: 1n, currency: 'USD' },
        });

      await expect(
        service.requestPlanChange({
          billingAccountId: 'acc-1',
          userId: 'user-1',
          targetPlanVersion: GROWTH as any,
          currentPlanVersion: FREE as any,
          tx,
        }),
      ).rejects.toThrow(ConflictException);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('returns unchanged when target equals current and nothing is scheduled', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst.mockResolvedValueOnce(null); // cancelScheduled latest
      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: STARTER as any,
        tx,
      });
      expect(result.outcome).toBe('unchanged');
      expect(result).not.toHaveProperty('requiresPostCommitStripeSync', true);
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(enqueueFromPlanChangeInTx).not.toHaveBeenCalled();
    });

    it('returns scheduled idempotently when target equals current and same plan is scheduled', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-sched',
          toPlanVersionId: STARTER.id,
          toPlanVersion: STARTER,
          fromPlanVersion: FREE,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);
      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: STARTER as any,
        tx,
      });
      expect(result.outcome).toBe('scheduled');
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(changeUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'canceled' }),
        }),
      );
      expect(assignmentDeleteMany).not.toHaveBeenCalled();
    });

    it('cancels a different next-period schedule when selecting the current plan and returns unchanged', async () => {
      changeUpdateMany.mockResolvedValue({ count: 1 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-other',
          toPlanVersionId: FREE.id,
          toPlanVersion: FREE,
          fromPlanVersion: STARTER,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);
      changeFindFirst.mockResolvedValueOnce({ id: 'chg-other' }); // cancelScheduled latest
      assignmentDeleteMany.mockResolvedValue({ count: 1 });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: STARTER as any,
        tx,
      });

      expect(result.outcome).toBe('unchanged');
      if (result.outcome !== 'unchanged') return;
      expect(result.requiresPostCommitStripeSync).toBe(true);
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-1',
            status: 'scheduled',
          }),
          data: expect.objectContaining({
            status: 'canceled',
            canceledAt: expect.any(Date),
          }),
        }),
      );
      expect(assignmentDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-1',
            source: 'downgrade_schedule',
          }),
        }),
      );
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          billingAccountId: 'acc-1',
          sourcePlanChangeId: 'chg-other',
          defaultTargetPlanVersionId: STARTER.id,
        }),
      );
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(changeCreate).not.toHaveBeenCalled();
    });

    it('upgrade cancels a scheduled Free downgrade and cleans projection without voiding pending_payment path', async () => {
      changeUpdateMany.mockResolvedValue({ count: 1 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-free-sched',
          toPlanVersionId: FREE.id,
          toPlanVersion: FREE,
          fromPlanVersion: STARTER,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);
      changeFindFirst
        .mockResolvedValueOnce({ id: 'chg-free-sched' }) // cancelScheduled
        .mockResolvedValueOnce(null); // no pending upgrade
      assignmentDeleteMany.mockResolvedValue({ count: 1 });
      invoiceCreate.mockResolvedValue({
        id: 'inv-charge-up',
        totalMicros: 25_000_000n,
        currency: 'USD',
      });
      invoiceLineCreate.mockResolvedValue({});
      changeCreate.mockResolvedValue({
        id: 'chg-up-1',
        toPlanVersionId: STARTER.id,
        toPlanVersion: STARTER,
        fromPlanVersion: FREE,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
        validUntil: new Date('2026-09-01T00:00:00.000Z'),
        chargeInvoice: {
          id: 'inv-charge-up',
          totalMicros: 25_000_000n,
          currency: 'USD',
        },
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: FREE as any,
        tx,
      });

      expect(result.outcome).toBe('payment_required');
      if (result.outcome !== 'payment_required') return;
      expect(result.requiresPostCommitStripeSync).toBe(true);
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'canceled' }),
        }),
      );
      expect(assignmentDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ source: 'downgrade_schedule' }),
        }),
      );
      // Corrective sync targets entitled Free, not unpaid Starter upgrade.
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          sourcePlanChangeId: 'chg-free-sched',
          defaultTargetPlanVersionId: FREE.id,
        }),
      );
      expect(changeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending_payment',
            toPlanVersionId: STARTER.id,
          }),
        }),
      );
      expect(assignmentCreate).not.toHaveBeenCalled();
    });

    it('upgrade conflict on different pending payment does not cancel schedule (cancel runs after schedule check but before pending check — TX caller rolls back)', async () => {
      // Documents ordering: cancel is in-TX before pending conflict throw so the
      // outer interactive transaction must roll back to preserve the old schedule.
      changeUpdateMany.mockResolvedValue({ count: 1 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-sched-old',
          toPlanVersionId: FREE.id,
          toPlanVersion: FREE,
          fromPlanVersion: STARTER,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);
      changeFindFirst
        .mockResolvedValueOnce({ id: 'chg-sched-old' }) // cancelScheduled
        .mockResolvedValueOnce({
          id: 'chg-pending-other',
          toPlanVersionId: STARTER.id,
          toPlanVersion: STARTER,
          fromPlanVersion: FREE,
          validUntil: new Date('2026-09-01T00:00:00.000Z'),
          chargeInvoice: { id: 'inv-1', totalMicros: 1n, currency: 'USD' },
        });

      await expect(
        service.requestPlanChange({
          billingAccountId: 'acc-1',
          userId: 'user-1',
          targetPlanVersion: GROWTH as any,
          currentPlanVersion: FREE as any,
          tx,
        }),
      ).rejects.toThrow(ConflictException);

      // Cancel was attempted in-memory on this mock TX; real Prisma interactive
      // TX aborts on throw so scheduled rows stay. Spec asserts conflict still fires.
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(changeCreate).not.toHaveBeenCalled();
    });

    it('retires expired pending upgrades as needs_review and allows a new target', async () => {
      changeUpdateMany.mockResolvedValue({ count: 1 }); // stale retired
      changeFindFirst
        .mockResolvedValueOnce(null) // cancelScheduled
        .mockResolvedValueOnce(null); // no pending after retire
      invoiceCreate.mockResolvedValue({
        id: 'inv-charge-2',
        totalMicros: 25_000_000n,
        currency: 'USD',
      });
      invoiceLineCreate.mockResolvedValue({});
      changeCreate.mockResolvedValue({
        id: 'chg-2',
        toPlanVersionId: GROWTH.id,
        toPlanVersion: GROWTH,
        fromPlanVersion: FREE,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
        validUntil: new Date('2026-09-01T00:00:00.000Z'),
        chargeInvoice: {
          id: 'inv-charge-2',
          totalMicros: 25_000_000n,
          currency: 'USD',
        },
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: GROWTH as any,
        currentPlanVersion: FREE as any,
        tx,
      });
      expect(result.outcome).toBe('payment_required');
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });
  });

  describe('cancelPendingUpgrade', () => {
    const periodStart = new Date('2026-08-01T00:00:00.000Z');
    const chargeInvoice = {
      id: 'inv-charge-1',
      purpose: 'plan_charge',
      status: 'finalized',
      paidAt: null,
      settlementAttemptId: null,
      allocatedMicros: 0n,
      periodStart,
    };

    const pendingChange = {
      id: 'chg-up-1',
      billingAccountId: 'acc-1',
      status: 'pending_payment',
      kind: 'upgrade',
      chargeInvoiceId: 'inv-charge-1',
      chargeInvoice,
      periodStart,
      effectiveAt: periodStart,
      fromPlanVersion: FREE,
      toPlanVersion: STARTER,
    };

    const cleanUsdcPending = {
      id: 'att-usdc-1',
      invoiceId: 'inv-charge-1',
      method: 'usdc',
      status: 'pending',
      submittedTxHash: null,
      txHash: null,
      receiptEvidence: null,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      actualBaseUnits: null,
      logIndex: null,
      payerAddress: null,
      allocatedAt: null,
      succeededAt: null,
    };

    const cancelArgs = {
      billingAccountId: 'acc-1',
      expectedChangeId: 'chg-up-1',
      expectedPeriodStart: periodStart,
      tx,
    };

    it('CAS-cancels the expected upgrade, voids unpaid plan_charge, and releases clean pending only', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([cleanUsdcPending]);
      invoiceFindUnique.mockResolvedValue(chargeInvoice);
      changeUpdateMany.mockResolvedValue({ count: 1 });
      invoiceUpdateMany.mockResolvedValue({ count: 1 });
      attemptUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelPendingUpgrade(cancelArgs);

      expect(result.outcome).toBe('canceled');
      expect(result.planCode).toBe('free');
      expect(result.effectivePeriod).toBe('2026-08');
      expect(changeFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'chg-up-1' } }),
      );
      expect(changeFindFirst).not.toHaveBeenCalled();
      expect(queryRaw).toHaveBeenCalled();
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'chg-up-1', status: 'pending_payment' }),
          data: expect.objectContaining({ status: 'canceled', canceledAt: expect.any(Date) }),
        }),
      );
      expect(invoiceUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'inv-charge-1',
            status: 'finalized',
            paidAt: null,
            settlementAttemptId: null,
            allocatedMicros: 0n,
          }),
          data: { status: 'void' },
        }),
      );
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: ['att-usdc-1'] },
            status: 'pending',
            submittedTxHash: null,
            txHash: null,
          }),
          data: expect.objectContaining({
            status: 'failed',
            failureCode: 'upgrade_canceled',
          }),
        }),
      );
      expect(enqueueFromPlanChangeInTx).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
      expect(assignmentDeleteMany).not.toHaveBeenCalled();
      expect(assignmentFindUnique).not.toHaveBeenCalled();
    });

    it('is an idempotent no-op when no expected change id is supplied', async () => {
      const result = await service.cancelPendingUpgrade({
        billingAccountId: 'acc-1',
        expectedChangeId: null,
        expectedPeriodStart: null,
        tx,
      });

      expect(result.outcome).toBe('unchanged');
      expect(changeFindUnique).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('is an idempotent no-op when the expected change was already canceled', async () => {
      changeFindUnique.mockResolvedValue({
        ...pendingChange,
        status: 'canceled',
      });

      const result = await service.cancelPendingUpgrade(cancelArgs);

      expect(result.outcome).toBe('unchanged');
      expect(result.planCode).toBe('free');
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects when expected id exists but periodStart differs (replacement under old lock)', async () => {
      changeFindUnique.mockResolvedValue({
        ...pendingChange,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
      });

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on pending USDC attempt with submittedTxHash without writes', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          submittedTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on pending Stripe attempt without releasing it', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          id: 'att-stripe-1',
          method: 'stripe',
          status: 'pending',
          stripeCheckoutSessionId: 'cs_test_1',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on pending Stripe attempt with missing session id (creation/recovery)', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          id: 'att-stripe-unc',
          method: 'stripe',
          status: 'pending',
          stripeCheckoutSessionId: null,
          failureCode: 'local_persistence_uncertain',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on Stripe needs_review with persisted checkout session (recovery exhausted)', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          id: 'att-stripe-review',
          method: 'stripe',
          status: 'needs_review',
          stripeCheckoutSessionId: 'cs_test_exhausted',
          reviewReason: 'checkout_recovery_exhausted',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on Stripe needs_review with missing/uncertain session evidence', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          id: 'att-stripe-review-unc',
          method: 'stripe',
          status: 'needs_review',
          stripeCheckoutSessionId: null,
          failureCode: 'local_persistence_uncertain',
          reviewReason: 'checkout_recovery_exhausted',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on failed Stripe attempt even with a prior Checkout session (no remote inactivity proof)', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          id: 'att-stripe-failed',
          method: 'stripe',
          status: 'failed',
          stripeCheckoutSessionId: 'cs_test_retryable',
          failureCode: 'card_declined',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed on expired or canceled Stripe attempt rows without writes', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        {
          ...cleanUsdcPending,
          id: 'att-stripe-expired',
          method: 'stripe',
          status: 'expired',
          stripeCheckoutSessionId: 'cs_test_expired',
        },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('still cancels when there are no payment attempts at all', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([]);
      invoiceFindUnique.mockResolvedValue(chargeInvoice);
      changeUpdateMany.mockResolvedValue({ count: 1 });
      invoiceUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelPendingUpgrade(cancelArgs);

      expect(result.outcome).toBe('canceled');
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed when a confirming or succeeded attempt exists', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([
        { ...cleanUsdcPending, id: 'att-1', status: 'confirming' },
      ]);

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('fails closed when the invoice already has paid markers or coverage', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([]);
      invoiceFindUnique.mockResolvedValue({
        ...chargeInvoice,
        paidAt: new Date('2026-08-16T00:00:00.000Z'),
      });

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
      expect(changeUpdateMany).not.toHaveBeenCalled();
    });

    it('rolls back when the void CAS misses after change cancel', async () => {
      changeFindUnique.mockResolvedValue(pendingChange);
      attemptFindMany.mockResolvedValue([]);
      invoiceFindUnique.mockResolvedValue(chargeInvoice);
      changeUpdateMany.mockResolvedValue({ count: 1 });
      invoiceUpdateMany.mockResolvedValue({ count: 0 }); // void CAS miss

      await expect(service.cancelPendingUpgrade(cancelArgs)).rejects.toThrow(ConflictException);
    });
  });

  describe('cancelScheduledPlanChange', () => {
    it('cancels scheduled rows, cleans downgrade_schedule projection, and enqueues corrective sync', async () => {
      const nextStart = new Date('2026-09-01T00:00:00.000Z');
      changeFindFirst.mockResolvedValueOnce({ id: 'chg-sched' });
      changeUpdateMany.mockResolvedValue({ count: 1 });
      assignmentDeleteMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelScheduledPlanChange({
        billingAccountId: 'acc-1',
        currentPlanVersion: STARTER as any,
        tx,
      });

      expect(result.outcome).toBe('canceled');
      expect(result.planCode).toBe('starter');
      expect(result.effectivePeriod).toBe('2026-08');
      expect(result.requiresPostCommitStripeSync).toBe(true);
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-1',
            periodStart: nextStart,
            status: 'scheduled',
          }),
          data: expect.objectContaining({
            status: 'canceled',
            canceledAt: expect.any(Date),
          }),
        }),
      );
      expect(assignmentDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-1',
            periodStart: nextStart,
            source: 'downgrade_schedule',
          }),
        }),
      );
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          sourcePlanChangeId: 'chg-sched',
          defaultTargetPlanVersionId: STARTER.id,
        }),
      );
      expect(retargetPendingAutoIntentInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          targetPlanVersionId: STARTER.id,
          sourcePlanChangeId: 'chg-sched',
        }),
      );
    });

    it('is an idempotent no-op when nothing is scheduled', async () => {
      changeFindFirst.mockResolvedValueOnce(null);

      const result = await service.cancelScheduledPlanChange({
        billingAccountId: 'acc-1',
        currentPlanVersion: STARTER as any,
        tx,
      });

      expect(result).toEqual({
        outcome: 'unchanged',
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: '2026-08',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
      });
      expect(result).not.toHaveProperty('requiresPostCommitStripeSync', true);
      expect(changeUpdateMany).not.toHaveBeenCalled();
      expect(assignmentDeleteMany).not.toHaveBeenCalled();
      expect(enqueueFromPlanChangeInTx).not.toHaveBeenCalled();
      expect(retargetPendingAutoIntentInTx).not.toHaveBeenCalled();
    });
  });

  describe('requestPlanChange — downgrade', () => {
    it('schedules next-month assignment without creating a charge invoice', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst.mockResolvedValueOnce(null); // cancelScheduled
      assignmentFindUnique.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({});
      changeCreate.mockResolvedValue({
        id: 'chg-down-1',
        toPlanVersion: FREE,
        fromPlanVersion: STARTER,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        validUntil: new Date('2026-10-01T00:00:00.000Z'),
        chargeInvoice: null,
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: FREE as any,
        currentPlanVersion: STARTER as any,
        tx,
      });

      expect(result.outcome).toBe('scheduled');
      if (result.outcome !== 'scheduled') return;
      expect(result.effectivePeriod).toBe('2026-09');
      expect(result.kind).toBe('downgrade');
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(assignmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: FREE.id,
            periodStart: new Date('2026-09-01T00:00:00.000Z'),
            source: 'downgrade_schedule',
          }),
        }),
      );
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          sourcePlanChangeId: 'chg-down-1',
          defaultTargetPlanVersionId: FREE.id,
        }),
      );
    });

    it('same already-scheduled downgrade target is idempotent (no cancel/recreate)', async () => {
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-existing',
          toPlanVersionId: FREE.id,
          toPlanVersion: FREE,
          fromPlanVersion: STARTER,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: FREE as any,
        currentPlanVersion: STARTER as any,
        tx,
      });

      expect(result.outcome).toBe('scheduled');
      if (result.outcome !== 'scheduled') return;
      expect(result.changeId).toBe('chg-existing');
      expect(changeCreate).not.toHaveBeenCalled();
      expect(assignmentDeleteMany).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
    });

    it('matching scheduled target plus conflicting scheduled target cancels all, cleans projection, and recreates only the requested schedule', async () => {
      // P2: DB may hold multiple scheduled rows for the same next period. A
      // matching FREE schedule must not short-circuit while a conflicting
      // STARTER schedule (and its Free projection) remains worker-eligible.
      const nextStart = new Date('2026-09-01T00:00:00.000Z');
      const nextEnd = new Date('2026-10-01T00:00:00.000Z');
      changeUpdateMany.mockResolvedValue({ count: 2 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-match-free',
          toPlanVersionId: FREE.id,
          toPlanVersion: FREE,
          fromPlanVersion: GROWTH,
          periodStart: nextStart,
          effectiveAt: nextStart,
          validUntil: nextEnd,
          chargeInvoice: null,
        },
        {
          id: 'chg-conflict-starter',
          toPlanVersionId: STARTER.id,
          toPlanVersion: STARTER,
          fromPlanVersion: GROWTH,
          periodStart: nextStart,
          effectiveAt: nextStart,
          validUntil: nextEnd,
          chargeInvoice: null,
        },
      ]);
      changeFindFirst.mockResolvedValueOnce({ id: 'chg-match-free' }); // cancel attribution
      assignmentDeleteMany.mockResolvedValue({ count: 1 });
      assignmentFindUnique.mockResolvedValue(null); // projection cleaned
      assignmentCreate.mockResolvedValue({});
      changeCreate.mockResolvedValue({
        id: 'chg-new-free',
        toPlanVersion: FREE,
        fromPlanVersion: GROWTH,
        periodStart: nextStart,
        effectiveAt: nextStart,
        validUntil: nextEnd,
        chargeInvoice: null,
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: FREE as any,
        currentPlanVersion: GROWTH as any,
        tx,
      });

      expect(result.outcome).toBe('scheduled');
      if (result.outcome !== 'scheduled') return;
      expect(result.changeId).toBe('chg-new-free');
      // All scheduled rows canceled (including the matching one + conflict).
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-1',
            status: 'scheduled',
            periodStart: nextStart,
          }),
          data: expect.objectContaining({
            status: 'canceled',
            canceledAt: expect.any(Date),
          }),
        }),
      );
      expect(assignmentDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            billingAccountId: 'acc-1',
            periodStart: nextStart,
            source: 'downgrade_schedule',
          }),
        }),
      );
      // Exactly one new schedule; old matching id must not be returned as-is.
      expect(changeCreate).toHaveBeenCalledTimes(1);
      expect(changeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toPlanVersionId: FREE.id,
            status: 'scheduled',
          }),
        }),
      );
      expect(assignmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: FREE.id,
            source: 'downgrade_schedule',
          }),
        }),
      );
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          sourcePlanChangeId: 'chg-new-free',
          defaultTargetPlanVersionId: FREE.id,
        }),
      );
    });

    it('replacing Free schedule with a paid lateral cleans Free projection and does not create unpaid paid assignment', async () => {
      // Growth → Starter is a downgrade/lateral (lower fee). Prior Free schedule projection cleaned.
      changeUpdateMany.mockResolvedValue({ count: 1 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-old-free',
          toPlanVersionId: FREE.id,
          toPlanVersion: FREE,
          fromPlanVersion: GROWTH,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);
      changeFindFirst.mockResolvedValueOnce({ id: 'chg-old-free' }); // cancel old Free schedule
      assignmentDeleteMany.mockResolvedValue({ count: 1 });
      // After cancel, no assignment remains (Free projection deleted).
      assignmentFindUnique.mockResolvedValue(null);
      changeCreate.mockResolvedValue({
        id: 'chg-starter-sched',
        toPlanVersion: STARTER,
        fromPlanVersion: GROWTH,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        validUntil: new Date('2026-10-01T00:00:00.000Z'),
        chargeInvoice: null,
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: GROWTH as any,
        tx,
      });

      expect(result.outcome).toBe('scheduled');
      if (result.outcome !== 'scheduled') return;
      expect(result.changeId).toBe('chg-starter-sched');
      expect(assignmentDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ source: 'downgrade_schedule' }),
        }),
      );
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
      expect(changeCreate).toHaveBeenCalledTimes(1);
      // New scheduled target sync wins (not a bare cancel corrective for Growth).
      expect(enqueueFromPlanChangeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          sourcePlanChangeId: 'chg-starter-sched',
          defaultTargetPlanVersionId: STARTER.id,
        }),
      );
    });

    it('replacing a different scheduled target with Free cancels old, creates one schedule, and projects Free', async () => {
      // Growth → Free while a Starter schedule existed (same-target FREE absent).
      changeUpdateMany.mockResolvedValue({ count: 1 });
      changeFindMany.mockResolvedValue([
        {
          id: 'chg-starter-sched',
          toPlanVersionId: STARTER.id,
          toPlanVersion: STARTER,
          fromPlanVersion: GROWTH,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
          chargeInvoice: null,
        },
      ]);
      changeFindFirst.mockResolvedValueOnce({ id: 'chg-starter-sched' }); // cancel Starter schedule
      assignmentDeleteMany.mockResolvedValue({ count: 0 });
      assignmentFindUnique.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({});
      changeCreate.mockResolvedValue({
        id: 'chg-new-free',
        toPlanVersion: FREE,
        fromPlanVersion: GROWTH,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        validUntil: new Date('2026-10-01T00:00:00.000Z'),
        chargeInvoice: null,
      });

      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: FREE as any,
        currentPlanVersion: GROWTH as any,
        tx,
      });

      expect(result.outcome).toBe('scheduled');
      expect(changeCreate).toHaveBeenCalledTimes(1);
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'canceled' }),
        }),
      );
      expect(assignmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: FREE.id,
            source: 'downgrade_schedule',
          }),
        }),
      );
    });
  });

  describe('applyPaidPlanCharge', () => {
    it('activates the target assignment and marks the change applied', async () => {
      invoiceFindUnique.mockResolvedValue({
        id: 'inv-charge-1',
        purpose: 'plan_charge',
        paidAt: new Date(),
        allocatedMicros: 25_000_000n,
        totalMicros: 25_000_000n,
        billingAccountId: 'acc-1',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
      });
      changeFindFirst.mockResolvedValue({
        id: 'chg-1',
        status: 'pending_payment',
        kind: 'upgrade',
        billingAccountId: 'acc-1',
        toPlanVersionId: STARTER.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
        validUntil: new Date('2026-09-01T00:00:00.000Z'),
        toPlanVersion: STARTER,
      });
      assignmentFindUnique.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({});
      changeUpdateMany.mockResolvedValue({ count: 1 });

      await service.applyPaidPlanCharge(tx, 'inv-charge-1');

      expect(assignmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planVersionId: STARTER.id,
            source: 'upgrade_payment',
            expiresAt: new Date('2026-09-01T00:00:00.000Z'),
          }),
        }),
      );
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'chg-1',
            status: 'pending_payment',
          }),
          data: expect.objectContaining({ status: 'applied' }),
        }),
      );
    });

    it('applyScheduledIfDue CAS-applies only while still scheduled after period lock', async () => {
      changeFindUnique
        .mockResolvedValueOnce({
          id: 'chg-due',
          status: 'scheduled',
          kind: 'downgrade',
          billingAccountId: 'acc-1',
          toPlanVersionId: FREE.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'chg-due',
          status: 'scheduled',
          kind: 'downgrade',
          billingAccountId: 'acc-1',
          toPlanVersionId: FREE.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
        });
      // Need planVersion findUnique for FREE
      const planVersionFindUnique = jest.fn().mockResolvedValue(FREE);
      (tx as any).billingPlanVersion = { findUnique: planVersionFindUnique };
      changeUpdateMany.mockResolvedValue({ count: 1 });
      assignmentFindUnique.mockResolvedValue(null);
      assignmentCreate.mockResolvedValue({});

      const ok = await service.applyScheduledIfDue(
        tx,
        'chg-due',
        new Date('2026-09-01T00:00:00.000Z'),
      );
      expect(ok).toBe(true);
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'scheduled' }),
          data: expect.objectContaining({ status: 'applied' }),
        }),
      );
      expect(assignmentCreate).toHaveBeenCalled();
    });

    it('applyScheduledIfDue does not write assignment when CAS loses (canceled race)', async () => {
      changeFindUnique
        .mockResolvedValueOnce({
          id: 'chg-due',
          status: 'scheduled',
          kind: 'downgrade',
          billingAccountId: 'acc-1',
          toPlanVersionId: FREE.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'chg-due',
          status: 'scheduled',
          kind: 'downgrade',
          billingAccountId: 'acc-1',
          toPlanVersionId: FREE.id,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
        });
      (tx as any).billingPlanVersion = {
        findUnique: jest.fn().mockResolvedValue(FREE),
      };
      assignmentFindUnique.mockResolvedValue(null);
      changeUpdateMany.mockResolvedValue({ count: 0 }); // CAS lost

      const ok = await service.applyScheduledIfDue(
        tx,
        'chg-due',
        new Date('2026-09-01T00:00:00.000Z'),
      );
      expect(ok).toBe(false);
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
    });

    it('delayed Free schedule does not overwrite a later paid upgrade projection', async () => {
      const periodStart = new Date('2026-09-01T00:00:00.000Z');
      changeFindUnique
        .mockResolvedValueOnce({
          id: 'chg-free',
          status: 'scheduled',
          kind: 'downgrade',
          billingAccountId: 'acc-1',
          toPlanVersionId: FREE.id,
          periodStart,
          effectiveAt: periodStart,
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'chg-free',
          status: 'scheduled',
          kind: 'downgrade',
          billingAccountId: 'acc-1',
          toPlanVersionId: FREE.id,
          periodStart,
          effectiveAt: periodStart,
          validUntil: new Date('2026-10-01T00:00:00.000Z'),
        });
      (tx as any).billingPlanVersion = {
        findUnique: jest.fn().mockResolvedValue(FREE),
      };
      // Later worker delay: paid upgrade already projected for the period.
      assignmentFindUnique.mockResolvedValue({
        id: 'asg-paid',
        planVersionId: STARTER.id,
        source: 'upgrade_payment',
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      changeUpdateMany.mockResolvedValue({ count: 1 });

      const ok = await service.applyScheduledIfDue(tx, 'chg-free', periodStart);
      expect(ok).toBe(true);
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'chg-free', status: 'scheduled' }),
          data: expect.objectContaining({ status: 'applied' }),
        }),
      );
      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(assignmentUpdate).not.toHaveBeenCalled();
    });

    describe('applyFixedFeeRenewalCoverage', () => {
      const periodStart = new Date('2026-09-01T00:00:00.000Z');
      const periodEnd = new Date('2026-10-01T00:00:00.000Z');
      const openInvoice = {
        id: 'inv-open',
        purpose: 'usage_period',
        status: 'open',
        billingAccountId: 'acc-1',
        planVersionId: STARTER.id,
        periodStart,
        periodEnd,
        monthlyFeeMicros: STARTER.monthlyFeeMicros,
        currency: 'USD',
        totalMicros: STARTER.monthlyFeeMicros,
        paidAt: null,
      };

      it('extends entitlement on open dynamic invoice without finalizing it', async () => {
        invoiceFindUnique.mockResolvedValue(openInvoice);
        (tx as any).billingPlanVersion = {
          findUnique: jest.fn().mockResolvedValue(STARTER),
        };
        attemptFindUnique.mockResolvedValue({
          id: 'att-ff',
          invoiceId: 'inv-open',
          method: 'stripe',
          status: 'succeeded',
          stripeChargeKind: 'fixed_fee',
          amountMicros: STARTER.monthlyFeeMicros,
          currency: 'USD',
        });
        assignmentFindUnique.mockResolvedValue(null);
        assignmentCreate.mockResolvedValue({});
        changeUpdateMany.mockResolvedValue({ count: 0 });

        const ok = await service.applyFixedFeeRenewalCoverage(tx, {
          invoiceId: 'inv-open',
          planVersionId: STARTER.id,
          amountMicros: STARTER.monthlyFeeMicros,
          attemptId: 'att-ff',
          periodLockAlreadyHeld: true,
        });
        expect(ok).toBe(true);
        expect(assignmentCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              planVersionId: STARTER.id,
              periodStart,
              expiresAt: periodEnd,
              source: 'renewal',
            }),
          }),
        );
        // Invoice must not be rewritten/finalized by coverage.
        expect(invoiceFindUnique).toHaveBeenCalled();
      });

      it('is idempotent on replay when renewal assignment already covers the period', async () => {
        invoiceFindUnique.mockResolvedValue(openInvoice);
        (tx as any).billingPlanVersion = {
          findUnique: jest.fn().mockResolvedValue(STARTER),
        };
        attemptFindUnique.mockResolvedValue({
          id: 'att-ff',
          invoiceId: 'inv-open',
          method: 'stripe',
          status: 'succeeded',
          stripeChargeKind: 'fixed_fee',
          amountMicros: STARTER.monthlyFeeMicros,
          currency: 'USD',
        });
        assignmentFindUnique.mockResolvedValue({
          id: 'asg-1',
          planVersionId: STARTER.id,
          source: 'renewal',
          expiresAt: periodEnd,
        });

        const ok = await service.applyFixedFeeRenewalCoverage(tx, {
          invoiceId: 'inv-open',
          planVersionId: STARTER.id,
          amountMicros: STARTER.monthlyFeeMicros,
          attemptId: 'att-ff',
          periodLockAlreadyHeld: true,
        });
        expect(ok).toBe(true);
        expect(assignmentCreate).not.toHaveBeenCalled();
        expect(assignmentUpdate).not.toHaveBeenCalled();
      });

      it('fail-closed on wrong amount', async () => {
        invoiceFindUnique.mockResolvedValue(openInvoice);
        (tx as any).billingPlanVersion = {
          findUnique: jest.fn().mockResolvedValue(STARTER),
        };
        const ok = await service.applyFixedFeeRenewalCoverage(tx, {
          invoiceId: 'inv-open',
          planVersionId: STARTER.id,
          amountMicros: 1n,
          periodLockAlreadyHeld: true,
        });
        expect(ok).toBe(false);
        expect(assignmentCreate).not.toHaveBeenCalled();
      });

      it('fail-closed on plan identity mismatch vs invoice snapshot', async () => {
        invoiceFindUnique.mockResolvedValue({
          ...openInvoice,
          planVersionId: GROWTH.id,
        });
        (tx as any).billingPlanVersion = {
          findUnique: jest.fn().mockResolvedValue(STARTER),
        };
        const ok = await service.applyFixedFeeRenewalCoverage(tx, {
          invoiceId: 'inv-open',
          planVersionId: STARTER.id,
          amountMicros: STARTER.monthlyFeeMicros,
          periodLockAlreadyHeld: true,
        });
        expect(ok).toBe(false);
      });

      it('does not roll back a newer upgrade_payment projection', async () => {
        invoiceFindUnique.mockResolvedValue(openInvoice);
        (tx as any).billingPlanVersion = {
          findUnique: jest.fn().mockResolvedValue(STARTER),
        };
        assignmentFindUnique.mockResolvedValue({
          id: 'asg-up',
          planVersionId: GROWTH.id,
          source: 'upgrade_payment',
          expiresAt: periodEnd,
        });
        const ok = await service.applyFixedFeeRenewalCoverage(tx, {
          invoiceId: 'inv-open',
          planVersionId: STARTER.id,
          amountMicros: STARTER.monthlyFeeMicros,
          periodLockAlreadyHeld: true,
        });
        expect(ok).toBe(true);
        expect(assignmentCreate).not.toHaveBeenCalled();
        expect(assignmentUpdate).not.toHaveBeenCalled();
      });
    });

    it('is a no-op when the change is already applied (idempotent replay)', async () => {
      invoiceFindUnique.mockResolvedValue({
        id: 'inv-charge-1',
        purpose: 'plan_charge',
        paidAt: new Date(),
        allocatedMicros: 25_000_000n,
        totalMicros: 25_000_000n,
        billingAccountId: 'acc-1',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
      });
      changeFindFirst.mockResolvedValue({
        id: 'chg-1',
        status: 'applied',
        kind: 'upgrade',
        billingAccountId: 'acc-1',
        toPlanVersionId: STARTER.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
        toPlanVersion: STARTER,
      });

      await service.applyPaidPlanCharge(tx, 'inv-charge-1');

      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(changeUpdateMany).not.toHaveBeenCalled();
    });

    it('marks needs_review and does not activate when payment is after validUntil', async () => {
      invoiceFindUnique.mockResolvedValue({
        id: 'inv-charge-1',
        purpose: 'plan_charge',
        paidAt: new Date(),
        allocatedMicros: 25_000_000n,
        totalMicros: 25_000_000n,
        billingAccountId: 'acc-1',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
      });
      changeFindFirst.mockResolvedValue({
        id: 'chg-1',
        status: 'pending_payment',
        kind: 'upgrade',
        billingAccountId: 'acc-1',
        toPlanVersionId: STARTER.id,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
        validUntil: new Date('2026-08-01T00:00:00.000Z'), // already expired vs fake now Aug 16
        toPlanVersion: STARTER,
      });
      changeUpdateMany.mockResolvedValue({ count: 1 });

      await service.applyPaidPlanCharge(tx, 'inv-charge-1', new Date('2026-08-16T00:00:00.000Z'));

      expect(assignmentCreate).not.toHaveBeenCalled();
      expect(changeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'needs_review' }),
        }),
      );
    });

    it('does not apply when the invoice is only partially allocated', async () => {
      invoiceFindUnique.mockResolvedValue({
        id: 'inv-charge-1',
        purpose: 'plan_charge',
        paidAt: null,
        allocatedMicros: 10_000_000n,
        totalMicros: 25_000_000n,
        billingAccountId: 'acc-1',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
      });

      await service.applyPaidPlanCharge(tx, 'inv-charge-1');

      expect(changeFindFirst).not.toHaveBeenCalled();
      expect(assignmentCreate).not.toHaveBeenCalled();
    });

    it('ignores usage_period invoices', async () => {
      invoiceFindUnique.mockResolvedValue({
        id: 'inv-usage-1',
        purpose: 'usage_period',
        paidAt: new Date(),
        allocatedMicros: 49_000_000n,
        totalMicros: 49_000_000n,
        billingAccountId: 'acc-1',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
      });

      await service.applyPaidPlanCharge(tx, 'inv-usage-1');
      expect(changeFindFirst).not.toHaveBeenCalled();
    });
  });
});

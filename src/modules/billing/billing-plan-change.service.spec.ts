import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingPlanChangeService } from './billing-plan-change.service';

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
  const changeFindUnique = jest.fn();
  const changeUpdateMany = jest.fn();
  const assignmentFindUnique = jest.fn();
  const assignmentCreate = jest.fn();
  const assignmentUpdate = jest.fn();
  const invoiceFindFirst = jest.fn();
  const attemptFindUnique = jest.fn();

  const tx = {
    $executeRaw: executeRaw,
    billingInvoice: {
      create: invoiceCreate,
      findUnique: invoiceFindUnique,
      findFirst: invoiceFindFirst,
    },
    billingInvoiceLine: { create: invoiceLineCreate },
    billingPlanChange: {
      create: changeCreate,
      findFirst: changeFindFirst,
      findUnique: changeFindUnique,
      updateMany: changeUpdateMany,
    },
    billingPlanAssignment: {
      findUnique: assignmentFindUnique,
      create: assignmentCreate,
      update: assignmentUpdate,
    },
    billingPaymentAttempt: {
      findUnique: attemptFindUnique,
    },
  } as any;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: new Date('2026-08-16T00:00:00.000Z') });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingPlanChangeService,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    service = module.get(BillingPlanChangeService);
    executeRaw.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('requestPlanChange — upgrade', () => {
    it('creates a finalized plan_charge invoice and pending_payment change without touching assignment', async () => {
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
    });

    it('is idempotent for the same pending upgrade target', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst.mockResolvedValue({
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
      changeFindFirst.mockResolvedValue({
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
      changeFindFirst.mockResolvedValue(null);
      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: STARTER as any,
        tx,
      });
      expect(result.outcome).toBe('unchanged');
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('returns scheduled idempotently when target equals current and same plan is scheduled', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst.mockResolvedValue({
        id: 'chg-sched',
        toPlanVersionId: STARTER.id,
        toPlanVersion: STARTER,
        fromPlanVersion: FREE,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        validUntil: new Date('2026-10-01T00:00:00.000Z'),
        chargeInvoice: null,
      });
      const result = await service.requestPlanChange({
        billingAccountId: 'acc-1',
        userId: 'user-1',
        targetPlanVersion: STARTER as any,
        currentPlanVersion: STARTER as any,
        tx,
      });
      expect(result.outcome).toBe('scheduled');
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('conflicts when current plan matches request but a different plan is already scheduled', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst.mockResolvedValue({
        id: 'chg-other',
        toPlanVersionId: FREE.id,
        toPlanVersion: FREE,
        fromPlanVersion: STARTER,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        validUntil: new Date('2026-10-01T00:00:00.000Z'),
        chargeInvoice: null,
      });
      await expect(
        service.requestPlanChange({
          billingAccountId: 'acc-1',
          userId: 'user-1',
          targetPlanVersion: STARTER as any,
          currentPlanVersion: STARTER as any,
          tx,
        }),
      ).rejects.toThrow(/different plan is already scheduled/i);
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    it('retires expired pending upgrades as needs_review and allows a new target', async () => {
      changeUpdateMany.mockResolvedValue({ count: 1 }); // stale retired
      changeFindFirst
        .mockResolvedValueOnce(null) // after retire, no active pending
        .mockResolvedValueOnce(null);
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

  describe('requestPlanChange — downgrade', () => {
    it('schedules next-month assignment without creating a charge invoice', async () => {
      changeUpdateMany.mockResolvedValue({ count: 0 });
      changeFindFirst.mockResolvedValue(null);
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

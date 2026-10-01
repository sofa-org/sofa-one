import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { BillingPaymentMethod, Prisma } from '@prisma/client';
import { BillingPlanChangeService } from './billing-plan-change.service';
import { acquireBillingPeriodAdvisoryLock } from './billing-period-lock';

type Tx = Prisma.TransactionClient;
type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;
type InvoiceRow = Prisma.BillingInvoiceGetPayload<Record<string, never>>;

/** The payment rail that produced a confirmed settlement. */
export type SettlementRail = BillingPaymentMethod;

/** Minimal reference to a confirmed payment attempt being settled. */
export interface SettlementAttemptRef {
  id: string;
  invoiceId: string;
  method: SettlementRail;
}

export interface SettlementResult {
  /**
   * True only when this call newly allocated the attempt's coverage toward the
   * invoice (the attempt was not previously allocated). False for a duplicate
   * replay of the same attempt, for a competing rail that lost the race to an
   * existing settlement, and for any attempt/invoice that fails the
   * settlement preconditions (see below).
   */
  allocated: boolean;

  /**
   * True when the invoice is fully covered after this operation
   * (allocatedMicros >= totalMicros and the paid markers are set). This is the
   * "invoice paid" signal callers must use instead of the attempt amount.
   */
  paid: boolean;

  /** True when THIS attempt owns the invoice's settlement pointer. */
  paidByThisAttempt: boolean;

  /**
   * True when the attempt had already been allocated (an idempotent replay of
   * the same succeeded attempt). No state was changed. This lets callers
   * distinguish a replay from a genuinely unallocated success whose invoice
   * was already paid by a different rail (a duplicate that needs review).
   */
  replayed: boolean;

  /** Coverage newly allocated by this call in microdollars (0 when none). */
  allocatedMicros: bigint;
}

const NO_OP: SettlementResult = {
  allocated: false,
  paid: false,
  paidByThisAttempt: false,
  replayed: false,
  allocatedMicros: 0n,
};

/**
 * Shared atomic invoice-settlement / coverage-allocation boundary.
 *
 * Lock order (uniform — Gate 1 attempt 3):
 *   1. period advisory lock (from soft-read invoice period; no row locks yet)
 *   2. attempt FOR UPDATE
 *   3. invoice FOR UPDATE
 *
 * Callers must not hold attempt/invoice locks before calling settleInvoice.
 * Stripe webhook acquires the same period key first, then settleInvoice
 * re-enters it. Coverage-first allocation + CAS semantics unchanged.
 */
@Injectable()
export class InvoiceSettlementService {
  constructor(
    @Optional() private readonly planChangeService?: BillingPlanChangeService,
  ) {}

  async settleInvoice(tx: Tx, attempt: SettlementAttemptRef): Promise<SettlementResult> {
    // Soft-read period identity WITHOUT row locks.
    const invoiceMeta = await tx.billingInvoice.findUnique({
      where: { id: attempt.invoiceId },
      select: { id: true, billingAccountId: true, periodStart: true },
    });
    if (!invoiceMeta) return NO_OP;

    // 1. Period advisory BEFORE any attempt/invoice row lock.
    await acquireBillingPeriodAdvisoryLock(
      tx,
      invoiceMeta.billingAccountId,
      invoiceMeta.periodStart,
    );

    // 2–3. Row locks attempt → invoice.
    const lockedAttempt = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_payment_attempts" WHERE "id" = ${attempt.id} FOR UPDATE`;
    if (lockedAttempt.length === 0) return NO_OP;

    const lockedInvoice = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_invoices" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`;
    if (lockedInvoice.length === 0) return NO_OP;

    const [attemptRow, invoice] = await Promise.all([
      tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } }),
      tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } }),
    ]);

    if (!attemptRow || !invoice) return NO_OP;
    if (!this.isAllocatable(attemptRow, invoice, attempt)) return NO_OP;

    // The attempt's coverage was already counted: an idempotent replay.
    if (attemptRow.allocatedAt != null) {
      const paid = invoice.paidAt !== null;
      if (paid) {
        await this.maybeActivateAfterPaid(tx, invoice);
      }
      return {
        ...NO_OP,
        paid,
        paidByThisAttempt: invoice.settlementAttemptId === attempt.id,
        replayed: true,
      };
    }

    if (invoice.paidAt !== null || invoice.settlementAttemptId !== null) {
      return {
        ...NO_OP,
        paid: true,
        paidByThisAttempt: invoice.settlementAttemptId === attempt.id,
      };
    }

    const covered = invoice.allocatedMicros ?? 0n;
    const total = invoice.totalMicros;
    const remaining = total - covered;
    if (remaining <= 0n) return NO_OP;

    const amount = attemptRow.amountMicros;
    if (amount <= 0n) return NO_OP;
    const coverage = amount < remaining ? amount : remaining;
    const nowCovered = covered + coverage;
    const reachesTotal = nowCovered >= total;

    const claimed = await tx.billingPaymentAttempt.updateMany({
      where: {
        id: attempt.id,
        invoiceId: attempt.invoiceId,
        method: attempt.method,
        status: 'succeeded',
        allocatedAt: null,
      },
      data: { allocatedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        'Stripe settlement CAS lost: coverage allocation marker could not be claimed',
      );
    }

    const result = await tx.billingInvoice.updateMany({
      where: {
        id: attempt.invoiceId,
        status: 'finalized',
        paidAt: null,
        settlementAttemptId: null,
        allocatedMicros: covered,
      },
      data: { allocatedMicros: { increment: coverage } },
    });
    if (result.count !== 1) {
      throw new ConflictException(
        'Stripe settlement CAS lost: invoice coverage could not be incremented',
      );
    }

    if (!reachesTotal) {
      return {
        allocated: true,
        paid: false,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: coverage,
      };
    }

    const paid = await tx.billingInvoice.updateMany({
      where: {
        id: attempt.invoiceId,
        status: 'finalized',
        paidAt: null,
        settlementAttemptId: null,
        allocatedMicros: nowCovered,
      },
      data: {
        paidAt: new Date(),
        paidVia: attempt.method,
        settlementAttemptId: attempt.id,
      },
    });
    if (paid.count !== 1) {
      throw new ConflictException(
        'Stripe settlement CAS lost: invoice paid markers could not be set',
      );
    }

    const paidInvoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
    if (paidInvoice) {
      await this.maybeActivateAfterPaid(tx, paidInvoice);
    }

    return {
      allocated: true,
      paid: true,
      paidByThisAttempt: true,
      replayed: false,
      allocatedMicros: coverage,
    };
  }

  /**
   * Post-paid activation under the settlement period lock (already held).
   * Plan-change helpers must not re-acquire the period lock after row locks.
   */
  private async maybeActivateAfterPaid(tx: Tx, invoice: InvoiceRow): Promise<void> {
    if (invoice.paidAt == null) return;
    if ((invoice.allocatedMicros ?? 0n) < invoice.totalMicros) return;
    if (!this.planChangeService) {
      if (invoice.purpose === 'plan_charge') {
        throw new ConflictException(
          'Plan change service is required to activate a paid plan_charge invoice',
        );
      }
      throw new ConflictException(
        'Plan change service is required to extend entitlements after payment',
      );
    }
    const opts = { periodLockAlreadyHeld: true as const };
    if (invoice.purpose === 'plan_charge') {
      await this.planChangeService.applyPaidPlanCharge(tx, invoice.id, new Date(), opts);
      return;
    }
    if (invoice.purpose === 'usage_period') {
      await this.planChangeService.extendEntitlementForPaidUsageInvoice(
        tx,
        invoice.id,
        new Date(),
        opts,
      );
    }
  }

  private isAllocatable(
    attemptRow: PaymentAttemptRow,
    invoice: InvoiceRow,
    ref: SettlementAttemptRef,
  ): boolean {
    if (attemptRow.invoiceId !== ref.invoiceId) return false;
    if (attemptRow.method !== ref.method) return false;
    if (attemptRow.status !== 'succeeded') return false;
    if (invoice.status !== 'finalized') return false;
    if (attemptRow.currency !== invoice.currency) return false;
    return true;
  }
}

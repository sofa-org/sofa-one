import { Injectable } from '@nestjs/common';
import { BillingPaymentMethod, Prisma } from '@prisma/client';

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
   * True only when this call performed the first settlement of the invoice.
   * False for a duplicate replay of the same attempt, for a competing rail
   * that lost the race to an existing settlement, and for any attempt/invoice
   * that fails the settlement preconditions (see below).
   */
  settled: boolean;
}

/**
 * Shared atomic invoice-settlement boundary (Phase 3B foundation).
 *
 * Concurrency isolation uses stable PostgreSQL row locks (`SELECT ... FOR
 * UPDATE`) inside the caller's interactive transaction, not just a pre-read:
 *   * Lock order is always attempt → invoice, matching the Stripe webhook's
 *     natural attempt-then-invoice order, so concurrent settlements and
 *     webhook transitions can never deadlock.
 *   * The locks make the reads below stable under Read Committed — no
 *     concurrent transaction can modify the attempt or the invoice between the
 *     read and the settlement commit — so a stale read cannot drive a
 *     settlement decision.
 *
 * Settlement preconditions are verified on the locked rows:
 *   * the attempt exists, belongs to the referenced invoice, and its `method`
 *     matches the rail that is settling;
 *   * the attempt is `succeeded` (only a confirmed payment can settle);
 *   * the invoice is `finalized`, unpaid, and its total/currency exactly match
 *     the attempt's amount/currency.
 *
 * The final state transition is an atomic first-rail-wins CAS: `paidAt`,
 * `paidVia`, and the unique `settlementAttemptId` pointer are set together in
 * one conditional `updateMany` guarded by `paidAt IS NULL AND
 * settlementAttemptId IS NULL` AND every critical predicate re-checked against
 * a fresh snapshot (invoice finalized/unpaid, exact amount/currency, and a
 * succeeded attempt with the referenced id/method). Even if a stale read
 * somehow slipped through, the CAS cannot settle an ineligible invoice, and at
 * most one concurrent settlement can ever match.
 *
 * A precondition failure is a no-op (`settled: false`) — never a throw — so a
 * legitimate payment fact already recorded on the attempt is never rolled back
 * and Stripe/USDC delivery is never turned into a retry loop. Replays of the
 * same attempt are idempotent no-ops, and a competing rail can never overwrite
 * an existing settlement. Invoice accounting status is never changed here, and
 * inbound payments never write to the Transaction or usage ledger.
 *
 * The method takes the interactive transaction client so callers (Stripe
 * webhook now, USDC confirmation later) settle inside their own atomic
 * transaction.
 */
@Injectable()
export class InvoiceSettlementService {
  async settleInvoice(tx: Tx, attempt: SettlementAttemptRef): Promise<SettlementResult> {
    // Stable row locks (attempt → invoice). See class docs for the ordering
    // rationale and deadlock-freedom argument.
    const lockedAttempt = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_payment_attempts" WHERE "id" = ${attempt.id} FOR UPDATE`;
    if (lockedAttempt.length === 0) return { settled: false };

    const lockedInvoice = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_invoices" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`;
    if (lockedInvoice.length === 0) return { settled: false };

    const [attemptRow, invoice] = await Promise.all([
      tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } }),
      tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } }),
    ]);

    if (!attemptRow || !invoice) return { settled: false };
    if (!this.isSettlable(attemptRow, invoice, attempt)) {
      return { settled: false };
    }

    // Atomic first-rail-wins CAS. The guarded update re-verifies every critical
    // predicate against a fresh snapshot, so a stale read can never settle an
    // ineligible invoice and at most one concurrent settlement can match.
    const result = await tx.billingInvoice.updateMany({
      where: {
        id: attempt.invoiceId,
        status: 'finalized',
        paidAt: null,
        settlementAttemptId: null,
        totalMicros: attemptRow.amountMicros,
        currency: attemptRow.currency,
        paymentAttempts: {
          some: {
            id: attempt.id,
            method: attempt.method,
            status: 'succeeded',
          },
        },
      },
      data: {
        paidAt: new Date(),
        paidVia: attempt.method,
        settlementAttemptId: attempt.id,
      },
    });
    return { settled: result.count > 0 };
  }

  private isSettlable(
    attemptRow: PaymentAttemptRow,
    invoice: InvoiceRow,
    ref: SettlementAttemptRef,
  ): boolean {
    if (attemptRow.invoiceId !== ref.invoiceId) return false;
    if (attemptRow.method !== ref.method) return false;
    if (attemptRow.status !== 'succeeded') return false;
    if (invoice.status !== 'finalized') return false;
    if (invoice.paidAt !== null) return false;
    if (attemptRow.amountMicros !== invoice.totalMicros) return false;
    if (attemptRow.currency !== invoice.currency) return false;
    return true;
  }
}

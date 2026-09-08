import { ConflictException, Injectable } from '@nestjs/common';
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
 * A `BillingInvoice` remains the single local accounting fact. A confirmed
 * payment attempt (Stripe or USDC) allocates coverage toward
 * `invoice.allocatedMicros`, never more than the remaining unpaid balance, and
 * the invoice is marked paid only when the cumulative allocation reaches
 * `totalMicros`. This supports the renewal-overage flow: a succeeded fixed-fee
 * renewal allocates only the fixed fee against a dynamic invoice (partial
 * coverage, invoice still unpaid), and the later overage attempt tops the
 * invoice up to `paid`.
 *
 * Concurrency isolation uses stable PostgreSQL row locks (`SELECT ... FOR
 * UPDATE`) inside the caller's interactive transaction, not just a pre-read:
 *   * Lock order is always attempt → invoice, matching the Stripe webhook's
 *     natural attempt-then-invoice order, so concurrent settlements and
 *     webhook transitions can never deadlock.
 *   * The locks make the reads below stable under Read Committed — no
 *     concurrent transaction can modify the attempt or the invoice between the
 *     read and the allocation commit — so a stale read cannot drive an
 *     allocation decision.
 *
 * Preconditions verified on the locked rows:
 *   * the attempt exists, belongs to the referenced invoice, and its `method`
 *     matches the rail that is settling;
 *   * the attempt is `succeeded` (only a confirmed payment can allocate);
 *   * the invoice is `finalized`, unpaid, and the attempt/invoice currency
 *     match;
 *   * the attempt was not already allocated (a second allocation of the same
 *     attempt is an idempotent no-op via the `allocatedAt` marker).
 *
 * The state transition is an atomic CAS: the attempt's `allocatedAt` marker
 * (guarded by `allocatedAt IS NULL`), the invoice's `allocatedMicros` increment
 * (guarded by the observed allocated value and `paidAt IS NULL AND
 * settlementAttemptId IS NULL`), and the `paidAt`/`paidVia`/`settlementAttemptId`
 * paid markers are set in one transaction. The attempt marker and the invoice
 * coverage/paid markers are therefore ALWAYS consistent: any coverage/paid-marker
 * CAS that fails to match is a genuine anomaly (the rows are already locked, so
 * a lost CAS cannot be a benign race) and is surfaced as a thrown
 * `ConflictException`. Because every caller runs inside its own interactive
 * transaction, the throw rolls the whole transaction back — the caller's own
 * writes (e.g. the webhook's pending→succeeded CAS) are rolled back too, and no
 * half-committed allocation state (attempt allocated but invoice not incremented,
 * or invoice incremented but paid markers missing) can ever be committed.
 *
 * A precondition failure (attempt not succeeded, invoice not finalized, wrong
 * currency, already-paid invoice, zero remaining balance, or a replay of an
 * attempt whose `allocatedAt` was already set under the lock) is a no-op — never
 * a throw — so a legitimate payment fact already recorded on the attempt is
 * never rolled back and Stripe/USDC delivery is never turned into a retry loop.
 * Replays of the same attempt are idempotent no-ops (`replayed: true`); a CAS
 * failure is never mislabeled as a successful replay. Invoice accounting status
 * is never changed here, and inbound payments never write to the Transaction or
 * usage ledger.
 *
 * The method takes the interactive transaction client so callers (Stripe
 * webhook, USDC confirmation, and the post-finalization renewal catch-up)
 * settle inside their own atomic transaction.
 */
@Injectable()
export class InvoiceSettlementService {
  async settleInvoice(tx: Tx, attempt: SettlementAttemptRef): Promise<SettlementResult> {
    // Stable row locks (attempt → invoice). See class docs for the ordering
    // rationale and deadlock-freedom argument.
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

    // The attempt's coverage was already counted: an idempotent replay. The
    // allocation is never applied twice, even when the invoice was later paid
    // by a different rail. (This is a genuine replay observed under the lock —
    // never a CAS-failure fallback.)
    if (attemptRow.allocatedAt != null) {
      return {
        ...NO_OP,
        paid: invoice.paidAt !== null,
        paidByThisAttempt: invoice.settlementAttemptId === attempt.id,
        replayed: true,
      };
    }

    // The invoice is already fully paid: this attempt cannot add coverage.
    // Report the paid state so callers can distinguish a competing-rail win
    // from a precondition failure.
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
    // Nothing left to allocate (fully covered but markers not yet set is a
    // data anomaly the caller must review — never a fabricated allocation).
    if (remaining <= 0n) return NO_OP;

    const amount = attemptRow.amountMicros;
    if (amount <= 0n) return NO_OP;
    // A successful attempt allocates at most the remaining balance — never
    // more, so cumulative coverage can never exceed totalMicros.
    const coverage = amount < remaining ? amount : remaining;
    const nowCovered = covered + coverage;
    const reachesTotal = nowCovered >= total;

    // Mark the attempt allocated exactly once (CAS on `allocatedAt IS NULL`).
    // The rows are already locked, so a lost CAS here is a genuine anomaly that
    // must roll back the whole caller transaction — never a silent replay.
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

    // Increment the invoice coverage. The CAS re-verifies the observed
    // allocated value and the unpaid/unsettled markers against a fresh
    // snapshot. A lost CAS aborts the whole transaction (both the attempt
    // marker and every caller write roll back) — a stale read can never
    // double-count, over-allocate, or leave the attempt marker orphaned.
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

    // Coverage reached the frozen total: mark the invoice paid atomically. A
    // lost paid-marker CAS aborts the whole transaction so the coverage
    // increment and the paid markers can never diverge.
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
    return {
      allocated: true,
      paid: true,
      paidByThisAttempt: true,
      replayed: false,
      allocatedMicros: coverage,
    };
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

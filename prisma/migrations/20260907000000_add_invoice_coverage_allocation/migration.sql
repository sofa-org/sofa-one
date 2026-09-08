-- Renewal overage coverage (auto-collect the excess after a fixed-fee renewal).
--
-- BillingInvoice.allocatedMicros is the cumulative confirmed coverage already
-- allocated to a finalized invoice. A succeeded fixed-fee renewal attempt is
-- allocated against the frozen total at finalization (partial coverage), and
-- the overage remainder is then collected automatically. The invoice is only
-- marked paid (paidAt/paidVia/settlementAttemptId) once allocatedMicros
-- reaches totalMicros, so a smaller fixed recurring charge can never falsely
-- pay a dynamic invoice while its overage is still separately collectable.
--
-- BillingPaymentAttempt.allocatedAt records that an attempt's coverage was
-- already counted, making a second allocation of the same attempt an
-- idempotent no-op and proving fixed-fee allocation to the overage worker.

-- AlterTable
ALTER TABLE "billing_invoices" ADD COLUMN "allocated_micros" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "billing_payment_attempts" ADD COLUMN "allocated_at" TIMESTAMPTZ;

-- Historical backfill (safety, by payment fact): invoices that were already
-- paid before this migration used the old first-rail-wins settlement, where a
-- single succeeded attempt covered the ENTIRE frozen total. Their coverage is
-- therefore the full totalMicros — never a silent 0 that would make a paid
-- invoice look underfunded. Unpaid invoices keep allocated_micros = 0 (no
-- coverage allocated yet under the new model). Attempt-level allocatedAt is
-- intentionally NOT backfilled: the settleInvoice boundary already treats a
-- paid invoice as a no-op before any allocation, so a historical replay can
-- never double-allocate.
UPDATE "billing_invoices"
SET "allocated_micros" = "total_micros"
WHERE "paid_at" IS NOT NULL;

-- Cross-rail active-payment reservation (partial, migration-only like the
-- sibling per-method index; Prisma cannot express partial indexes — do NOT let
-- `prisma migrate dev` drop it): at most ONE active (`pending`/`confirming`)
-- payment attempt may exist per invoice across ALL rails (USDC, Stripe
-- full/fixed_fee/overage). This is the DB-level guarantee that a confirming
-- USDC transfer and an off-session Stripe overage PaymentIntent — or any other
-- two active rails — can never be live on the same invoice at the same time,
-- preventing a quote/checkout/overage race from double-charging. Services
-- preflight before creating and treat the resulting P2002 as a fail-closed
-- Conflict/skip; the same rail's own active attempt is reused, never blocked.
--
-- Succeeded (already-covered) attempts are intentionally NOT in the predicate,
-- so an allocated fixed-fee renewal never blocks the later remainder overage.
--
-- Existing-data safety: before the index can be built, any pre-existing invoice
-- that already has MORE than one active attempt (allowed by the old
-- per-method-only index) must be reconciled conservatively. The earliest active
-- attempt per invoice is kept; every later one is surfaced for operator review
-- (fail-closed) so no live payment is silently dropped and the index can be
-- created without a race window.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY invoice_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM "billing_payment_attempts"
  WHERE "status" IN ('pending', 'confirming')
)
UPDATE "billing_payment_attempts" a
SET "status" = 'needs_review',
    "review_reason" = 'unified_active_reservation_conflict'
FROM ranked r
WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX "billing_payment_attempts_one_active_payment_per_invoice_idx"
ON "billing_payment_attempts"("invoice_id")
WHERE "status" IN ('pending', 'confirming');
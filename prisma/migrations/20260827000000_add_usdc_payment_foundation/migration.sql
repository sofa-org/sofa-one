-- Phase 3B foundation: dual-rail payment attempts (Stripe + USDC) and atomic
-- invoice settlement.
--
-- Semantics:
--   * billing_payment_attempts gains a `method` rail column; every existing
--     row is backfilled to 'stripe' via the column default. The status enum is
--     extended with confirming/expired/needs_review/reorged for the USDC
--     confirmation lifecycle (Stripe's pending/succeeded/failed are unchanged).
--   * USDC quote/evidence columns are nullable and only populated for
--     method='usdc' rows. They use precise PostgreSQL types (BIGINT for base
--     units/block numbers, TIMESTAMPTZ for expiry/last-checked, JSONB for a
--     safe receipt-evidence subset). No full sensitive payloads are stored.
--   * billing_invoices gains paid_via (the rail that settled the invoice) and
--     settlement_attempt_id (unique pointer to the winning attempt). Existing
--     paid invoices are backfilled to paid_via='stripe' and their earliest
--     succeeded attempt; paid_at is never modified.
--   * The partial unique index is replaced: one pending attempt per
--     (invoice_id, method) instead of per invoice, so Stripe and USDC pending
--     attempts can coexist. Like its predecessor, this partial index is not
--     representable in schema.prisma and must not be dropped by `prisma
--     migrate dev` drift detection.

-- CreateEnum
CREATE TYPE "BillingPaymentMethod" AS ENUM ('stripe', 'usdc');

-- AlterEnum (extend status; new values are not used in this migration)
ALTER TYPE "BillingPaymentAttemptStatus" ADD VALUE 'confirming';
ALTER TYPE "BillingPaymentAttemptStatus" ADD VALUE 'expired';
ALTER TYPE "BillingPaymentAttemptStatus" ADD VALUE 'needs_review';
ALTER TYPE "BillingPaymentAttemptStatus" ADD VALUE 'reorged';

-- AlterTable: billing_payment_attempts
ALTER TABLE "billing_payment_attempts" ADD COLUMN "method" "BillingPaymentMethod" NOT NULL DEFAULT 'stripe';
ALTER TABLE "billing_payment_attempts" ADD COLUMN "chain_id" BIGINT;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "token_address" VARCHAR(42);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "treasury_address" VARCHAR(42);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "token_decimals" INTEGER;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "expected_base_units" BIGINT;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "quote_expires_at" TIMESTAMPTZ;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "price_source" VARCHAR(40);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "tx_hash" VARCHAR(66);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "log_index" INTEGER;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "payer_address" VARCHAR(42);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "actual_base_units" BIGINT;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "block_number" BIGINT;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "block_hash" VARCHAR(66);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "block_timestamp" BIGINT;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "receipt_evidence" JSONB;
ALTER TABLE "billing_payment_attempts" ADD COLUMN "review_reason" VARCHAR(255);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "last_checked_at" TIMESTAMPTZ;

-- AlterTable: billing_invoices
ALTER TABLE "billing_invoices" ADD COLUMN "paid_via" "BillingPaymentMethod";
ALTER TABLE "billing_invoices" ADD COLUMN "settlement_attempt_id" UUID;

-- Backfill existing data: paid invoices are Stripe-settled, pointing at their
-- earliest succeeded attempt. paid_at semantics are preserved exactly.
UPDATE "billing_invoices" SET "paid_via" = 'stripe' WHERE "paid_at" IS NOT NULL;

UPDATE "billing_invoices" AS inv
SET "settlement_attempt_id" = (
    SELECT pa."id"
    FROM "billing_payment_attempts" AS pa
    WHERE pa."invoice_id" = inv."id" AND pa."status" = 'succeeded'
    ORDER BY pa."succeeded_at" ASC NULLS LAST, pa."created_at" ASC
    LIMIT 1
)
WHERE inv."paid_at" IS NOT NULL;

-- DropIndex (old partial: one pending attempt per invoice)
DROP INDEX "billing_payment_attempts_one_pending_per_invoice_idx";

-- CreateIndex (partial: one pending attempt per invoice + method)
CREATE UNIQUE INDEX "billing_payment_attempts_one_pending_per_invoice_method_idx"
ON "billing_payment_attempts"("invoice_id", "method")
WHERE "status" = 'pending';

-- CreateIndex (per-method pending lookups)
CREATE INDEX "billing_payment_attempts_invoice_id_method_status_idx"
ON "billing_payment_attempts"("invoice_id", "method", "status");

-- CreateIndex (settlement pointer)
CREATE UNIQUE INDEX "billing_invoices_settlement_attempt_id_key"
ON "billing_invoices"("settlement_attempt_id");

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_settlement_attempt_id_fkey"
FOREIGN KEY ("settlement_attempt_id") REFERENCES "billing_payment_attempts"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
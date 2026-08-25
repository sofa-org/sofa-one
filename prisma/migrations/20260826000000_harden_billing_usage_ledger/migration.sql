-- Commercial Billing Phase 1A: evolve BillingUsageEvent into an evidence-backed,
-- auditable, append-only usage ledger, and add minimal reconciliation-run persistence.
--
-- Semantics (Oracle-approved):
--   * user-level BillingAccount is unchanged (no Organization/Team/Stripe).
--   * No second ledger: the existing billing_usage_events table is extended.
--   * Legacy/caller-supplied rows are explicitly marked, never auto-treated as
--     receipt-confirmed (status = 'unverified', source_type = 'legacy_import').
--   * Append-only is enforced by model/API semantics: posted entries are not
--     updated/deleted; corrections use reversal/adjustment entries; unknown or
--     unpriced usage is quarantined. UTC period_start continues to exist.
--   * Outbound (outbound_volume) entries must reference a Transaction unless they
--     are reversals or legacy imports (DB CHECK constraint).

-- CreateEnum
CREATE TYPE "BillingUsageEventStatus" AS ENUM ('unverified', 'posted', 'quarantined', 'reversed');

-- CreateEnum
CREATE TYPE "BillingUsageEntryType" AS ENUM ('usage', 'reversal', 'adjustment');

-- CreateEnum
CREATE TYPE "BillingUsageSourceType" AS ENUM ('legacy_import', 'api_request', 'openfort_receipt', 'reconciliation', 'manual_adjustment');

-- A single successful receipt may contain multiple wallet-originated USDC/USDT
-- Transfer logs. Canonical receipt identity is therefore (account, receipt_ref,
-- receipt_log_index), not (account, receipt_ref). Drop the previous partial
-- unique index before adding the receipt_log_index column and the new index.
DROP INDEX IF EXISTS "billing_usage_events_billing_account_id_receipt_ref_key";

-- AlterTable
ALTER TABLE "billing_usage_events"
    ADD COLUMN "entry_type" "BillingUsageEntryType" NOT NULL DEFAULT 'usage',
    ADD COLUMN "source_type" "BillingUsageSourceType" NOT NULL DEFAULT 'api_request',
    ADD COLUMN "status" "BillingUsageEventStatus" NOT NULL DEFAULT 'unverified',
    ADD COLUMN "base_unit_amount" BIGINT,
    ADD COLUMN "asset_id" VARCHAR(255),
    ADD COLUMN "asset_decimals" INTEGER,
    ADD COLUMN "unit_price_micros" BIGINT,
    ADD COLUMN "price_source" VARCHAR(40),
    ADD COLUMN "chain_id" BIGINT,
    ADD COLUMN "wallet_address" VARCHAR(42),
    ADD COLUMN "tx_hash" VARCHAR(66),
    ADD COLUMN "receipt_ref" VARCHAR(255),
    ADD COLUMN "receipt_log_index" INTEGER,
    ADD COLUMN "receipt_block_number" BIGINT,
    ADD COLUMN "receipt_block_hash" VARCHAR(66),
    ADD COLUMN "receipt_block_timestamp" BIGINT,
    ADD COLUMN "receipt_status" VARCHAR(20),
    ADD COLUMN "receipt_data" JSONB,
    ADD COLUMN "plan_version_id" UUID,
    ADD COLUMN "reconciliation_run_id" UUID,
    ADD COLUMN "reconciled_at" TIMESTAMPTZ,
    ADD COLUMN "reversal_of_id" UUID,
    ADD COLUMN "adjustment_of_id" UUID;

-- Backfill: every pre-existing row is legacy caller-supplied input. It is NOT
-- receipt-confirmed (status stays 'unverified' via the column default) and is
-- explicitly tagged as legacy so it is never treated as server-verified evidence.
UPDATE "billing_usage_events" SET "source_type" = 'legacy_import' WHERE "source_type" = 'api_request';

-- Enforce outbound transaction association at the DB level for new rows:
-- an outbound_volume entry must reference a Transaction unless it is a reversal
-- or a legacy import. Existing legacy rows satisfy the constraint via the
-- source_type exemption, so the constraint validates without a NOT VALID step.
ALTER TABLE "billing_usage_events"
    ADD CONSTRAINT "billing_usage_events_outbound_transaction_check"
    CHECK (
        "metric" <> 'outbound_volume'
        OR "entry_type" = 'reversal'
        OR "source_type" = 'legacy_import'
        OR "transaction_id" IS NOT NULL
    );

-- CreateTable
CREATE TABLE "billing_reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "run_type" VARCHAR(40) NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ,
    "source" VARCHAR(80),
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "summary" JSONB,
    "error_details" VARCHAR(500),

    CONSTRAINT "billing_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- Canonical receipt identity: at most one usage event per (account, receipt_ref,
-- receipt_log_index). A single receipt may carry multiple Transfer logs, so the
-- log index disambiguates them. Partial index so NULL receipt_ref rows
-- (api_call / legacy) are not constrained. sourceKey remains globally unique.
CREATE UNIQUE INDEX "billing_usage_events_billing_account_id_receipt_ref_receipt_log_index_key"
    ON "billing_usage_events"("billing_account_id", "receipt_ref", "receipt_log_index")
    WHERE "receipt_ref" IS NOT NULL;

-- CreateIndex
CREATE INDEX "billing_usage_events_billing_account_id_status_period_start_idx"
    ON "billing_usage_events"("billing_account_id", "status", "period_start");

-- CreateIndex
CREATE INDEX "billing_usage_events_reconciliation_run_id_idx"
    ON "billing_usage_events"("reconciliation_run_id");

-- CreateIndex
CREATE INDEX "billing_usage_events_reversal_of_id_idx"
    ON "billing_usage_events"("reversal_of_id");

-- CreateIndex
CREATE INDEX "billing_usage_events_adjustment_of_id_idx"
    ON "billing_usage_events"("adjustment_of_id");

-- CreateIndex
CREATE INDEX "billing_usage_events_plan_version_id_idx"
    ON "billing_usage_events"("plan_version_id");

-- CreateIndex
CREATE INDEX "billing_reconciliation_runs_status_started_at_idx"
    ON "billing_reconciliation_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "billing_reconciliation_runs_period_start_period_end_idx"
    ON "billing_reconciliation_runs"("period_start", "period_end");

-- AddForeignKey
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_plan_version_id_fkey"
    FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_reconciliation_run_id_fkey"
    FOREIGN KEY ("reconciliation_run_id") REFERENCES "billing_reconciliation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_reversal_of_id_fkey"
    FOREIGN KEY ("reversal_of_id") REFERENCES "billing_usage_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_adjustment_of_id_fkey"
    FOREIGN KEY ("adjustment_of_id") REFERENCES "billing_usage_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

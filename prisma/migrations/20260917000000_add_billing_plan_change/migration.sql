-- Payment-aware plan-change vertical slice.
--
-- - BillingInvoice.purpose distinguishes monthly usage_period invoices from
--   independent plan_charge upgrade invoices (multiple plan_charge rows may
--   share an account+period).
-- - The full unique (billing_account_id, period_start) is replaced by a partial
--   unique index limited to purpose = 'usage_period'.
-- - BillingPlanChange tracks upgrade (pending_payment → applied on full settle)
--   and downgrade (scheduled → applied at next UTC month boundary).
-- - BillingPlanAssignment gains optional expires_at/source so unpaid renewals
--   fall back to Free at the period boundary without a grace window.

-- CreateEnum
CREATE TYPE "BillingInvoicePurpose" AS ENUM ('usage_period', 'plan_charge');
CREATE TYPE "BillingPlanChangeKind" AS ENUM ('upgrade', 'downgrade');
CREATE TYPE "BillingPlanChangeStatus" AS ENUM (
  'pending_payment',
  'scheduled',
  'applied',
  'canceled',
  'needs_review'
);

-- AlterTable: invoice purpose (all existing rows are usage_period)
ALTER TABLE "billing_invoices"
  ADD COLUMN "purpose" "BillingInvoicePurpose" NOT NULL DEFAULT 'usage_period';

-- Drop the full unique so plan_charge can share a period with usage_period.
-- The original billing foundation created a STANDALONE UNIQUE INDEX (not a
-- table CONSTRAINT); DROP CONSTRAINT is a no-op against that index.
DROP INDEX IF EXISTS "billing_invoices_billing_account_id_period_start_key";
-- Belt-and-suspenders for environments that may have promoted it to a constraint.
ALTER TABLE "billing_invoices"
  DROP CONSTRAINT IF EXISTS "billing_invoices_billing_account_id_period_start_key";

-- At most one usage_period invoice per account+period. Multiple plan_charge
-- invoices may share the same (account, period_start).
CREATE UNIQUE INDEX "billing_invoices_one_usage_period_per_account_period_idx"
  ON "billing_invoices" ("billing_account_id", "period_start")
  WHERE "purpose" = 'usage_period';

CREATE INDEX "billing_invoices_billing_account_id_purpose_period_start_idx"
  ON "billing_invoices" ("billing_account_id", "purpose", "period_start");

-- AlterTable: assignment validity
ALTER TABLE "billing_plan_assignments"
  ADD COLUMN "expires_at" TIMESTAMPTZ,
  ADD COLUMN "source" VARCHAR(40);

-- CreateTable: plan changes
CREATE TABLE "billing_plan_changes" (
  "id" UUID NOT NULL,
  "billing_account_id" UUID NOT NULL,
  "from_plan_version_id" UUID NOT NULL,
  "to_plan_version_id" UUID NOT NULL,
  "kind" "BillingPlanChangeKind" NOT NULL,
  "status" "BillingPlanChangeStatus" NOT NULL,
  "effective_at" TIMESTAMPTZ NOT NULL,
  "period_start" TIMESTAMPTZ NOT NULL,
  -- Server-derived exclusive end of the change's payable/activatable window
  -- (UTC month end for upgrades). After this instant a pending change is stale.
  "valid_until" TIMESTAMPTZ NOT NULL,
  "charge_invoice_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMPTZ,
  "canceled_at" TIMESTAMPTZ,

  CONSTRAINT "billing_plan_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_plan_changes_charge_invoice_id_key"
  ON "billing_plan_changes" ("charge_invoice_id");

CREATE INDEX "billing_plan_changes_billing_account_id_status_idx"
  ON "billing_plan_changes" ("billing_account_id", "status");

CREATE INDEX "billing_plan_changes_billing_account_id_period_start_idx"
  ON "billing_plan_changes" ("billing_account_id", "period_start");

CREATE INDEX "billing_plan_changes_to_plan_version_id_idx"
  ON "billing_plan_changes" ("to_plan_version_id");

-- At most one pending_payment upgrade charge per account (MVP concurrency gate).
CREATE UNIQUE INDEX "billing_plan_changes_one_pending_payment_per_account_idx"
  ON "billing_plan_changes" ("billing_account_id")
  WHERE "status" = 'pending_payment';

ALTER TABLE "billing_plan_changes"
  ADD CONSTRAINT "billing_plan_changes_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_plan_changes"
  ADD CONSTRAINT "billing_plan_changes_from_plan_version_id_fkey"
  FOREIGN KEY ("from_plan_version_id") REFERENCES "billing_plan_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_plan_changes"
  ADD CONSTRAINT "billing_plan_changes_to_plan_version_id_fkey"
  FOREIGN KEY ("to_plan_version_id") REFERENCES "billing_plan_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_plan_changes"
  ADD CONSTRAINT "billing_plan_changes_charge_invoice_id_fkey"
  FOREIGN KEY ("charge_invoice_id") REFERENCES "billing_invoices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

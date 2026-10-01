-- CreateEnum
CREATE TYPE "BillingUsageMetric" AS ENUM ('outbound_volume', 'api_call');

-- CreateEnum
CREATE TYPE "BillingInvoiceStatus" AS ENUM ('open', 'finalized', 'needs_review', 'void');

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(255),
    "monthly_fee_micros" BIGINT,
    "included_outbound_micros" BIGINT,
    "included_api_calls" BIGINT,
    "included_wallets" INTEGER,
    "included_team_members" INTEGER,
    "api_overage_rate_micros" BIGINT NOT NULL DEFAULT 0,
    "wallet_overage_rate_micros" BIGINT NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan_tiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_version_id" UUID NOT NULL,
    "lower_bound_micros" BIGINT NOT NULL,
    "upper_bound_micros" BIGINT,
    "rate_ppm" INTEGER NOT NULL,

    CONSTRAINT "billing_plan_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_account_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_plan_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_account_id" UUID NOT NULL,
    "metric" "BillingUsageMetric" NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 1,
    "volume_usd_micros" BIGINT NOT NULL DEFAULT 0,
    "transaction_id" UUID,
    "request_id" VARCHAR(64),
    "endpoint" VARCHAR(120),
    "status_code" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "billing_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_account_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'open',
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "gross_outbound_micros" BIGINT NOT NULL DEFAULT 0,
    "included_outbound_micros" BIGINT,
    "billable_outbound_micros" BIGINT NOT NULL DEFAULT 0,
    "api_calls" BIGINT NOT NULL DEFAULT 0,
    "included_api_calls" BIGINT,
    "active_wallets" INTEGER NOT NULL DEFAULT 0,
    "included_wallets" INTEGER,
    "monthly_fee_micros" BIGINT NOT NULL DEFAULT 0,
    "outbound_overage_micros" BIGINT NOT NULL DEFAULT 0,
    "api_overage_micros" BIGINT NOT NULL DEFAULT 0,
    "wallet_overage_micros" BIGINT NOT NULL DEFAULT 0,
    "total_micros" BIGINT NOT NULL DEFAULT 0,
    "snapshot_json" JSONB NOT NULL,
    "snapshot_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "finalized_at" TIMESTAMPTZ,

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "line_type" VARCHAR(40) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "unit_rate_ppm" INTEGER,
    "unit_amount_micros" BIGINT,
    "amount_micros" BIGINT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "billing_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_user_id_key" ON "billing_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_versions_code_version_key" ON "billing_plan_versions"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_tiers_plan_version_id_lower_bound_micros_key" ON "billing_plan_tiers"("plan_version_id", "lower_bound_micros");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plan_assignments_billing_account_id_period_start_key" ON "billing_plan_assignments"("billing_account_id", "period_start");

-- CreateIndex
CREATE INDEX "billing_plan_assignments_plan_version_id_idx" ON "billing_plan_assignments"("plan_version_id");

-- CreateIndex
CREATE INDEX "billing_plan_assignments_billing_account_id_period_start_idx" ON "billing_plan_assignments"("billing_account_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "billing_usage_events_source_key_key" ON "billing_usage_events"("source_key");

-- CreateIndex
CREATE INDEX "billing_usage_events_billing_account_id_period_start_metric_idx" ON "billing_usage_events"("billing_account_id", "period_start", "metric");

-- CreateIndex
CREATE INDEX "billing_usage_events_transaction_id_idx" ON "billing_usage_events"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_billing_account_id_period_start_key" ON "billing_invoices"("billing_account_id", "period_start");

-- CreateIndex
CREATE INDEX "billing_invoices_billing_account_id_period_start_period_end_idx" ON "billing_invoices"("billing_account_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "billing_invoice_lines_invoice_id_idx" ON "billing_invoice_lines"("invoice_id");

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_plan_tiers" ADD CONSTRAINT "billing_plan_tiers_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_plan_assignments" ADD CONSTRAINT "billing_plan_assignments_billing_account_id_fkey" FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_plan_assignments" ADD CONSTRAINT "billing_plan_assignments_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_billing_account_id_fkey" FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_billing_account_id_fkey" FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

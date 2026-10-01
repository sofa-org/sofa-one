-- Durable Stripe subscription mirror sync intents (Gate 1 B4).
-- Local plan-change apply commits an intent in the same DB transaction; the
-- worker/post-commit path mutates the existing Stripe subscription OUTSIDE any
-- DB transaction. Local entitlement never depends on provider sync success.

CREATE TYPE "BillingSubscriptionSyncKind" AS ENUM ('update_item', 'cancel_at_period_end');
CREATE TYPE "BillingSubscriptionSyncStatus" AS ENUM (
  'pending',
  'in_flight',
  'synced',
  'needs_review',
  'superseded',
  'failed'
);

CREATE TABLE "billing_subscription_sync_intents" (
  "id" UUID NOT NULL,
  "billing_account_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "source_plan_change_id" UUID,
  "kind" "BillingSubscriptionSyncKind" NOT NULL,
  "status" "BillingSubscriptionSyncStatus" NOT NULL DEFAULT 'pending',
  "stripe_customer_id" VARCHAR(255) NOT NULL,
  "stripe_subscription_id" VARCHAR(255) NOT NULL,
  "stripe_subscription_item_id" VARCHAR(255),
  "target_plan_version_id" UUID,
  "target_unit_amount_cents" INTEGER,
  "target_currency" VARCHAR(10) NOT NULL DEFAULT 'usd',
  "expected_period_start" TIMESTAMPTZ,
  "expected_period_end" TIMESTAMPTZ,
  "operation_idempotency_key" VARCHAR(120) NOT NULL,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMPTZ,
  "lease_owner_id" VARCHAR(80),
  "lease_expires_at" TIMESTAMPTZ,
  "last_error_code" VARCHAR(80),
  "last_error_type" VARCHAR(80),
  "synced_provider_price_id" VARCHAR(255),
  "synced_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "billing_subscription_sync_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_subscription_sync_intents_billing_account_id_revision_key"
  ON "billing_subscription_sync_intents" ("billing_account_id", "revision");

CREATE UNIQUE INDEX "billing_subscription_sync_intents_operation_idempotency_key_key"
  ON "billing_subscription_sync_intents" ("operation_idempotency_key");

CREATE INDEX "billing_subscription_sync_intents_status_next_retry_at_idx"
  ON "billing_subscription_sync_intents" ("status", "next_retry_at");

CREATE INDEX "billing_subscription_sync_intents_billing_account_id_status_idx"
  ON "billing_subscription_sync_intents" ("billing_account_id", "status");

CREATE INDEX "billing_subscription_sync_intents_stripe_subscription_id_idx"
  ON "billing_subscription_sync_intents" ("stripe_subscription_id");

-- At most one active (pending/in_flight) intent per account.
CREATE UNIQUE INDEX "billing_subscription_sync_intents_one_active_per_account_idx"
  ON "billing_subscription_sync_intents" ("billing_account_id")
  WHERE "status" IN ('pending', 'in_flight');

ALTER TABLE "billing_subscription_sync_intents"
  ADD CONSTRAINT "billing_subscription_sync_intents_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_subscription_sync_intents"
  ADD CONSTRAINT "billing_subscription_sync_intents_target_plan_version_id_fkey"
  FOREIGN KEY ("target_plan_version_id") REFERENCES "billing_plan_versions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

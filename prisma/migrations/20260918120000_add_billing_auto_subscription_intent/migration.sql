-- Durable first Stripe subscription create after a successful one-time Card
-- payment (plan_charge upgrade or fixed monthly usage_period first invoice).
-- Provider Subscriptions.create runs outside DB transactions with a stable
-- operation idempotency key. Billing starts at the next UTC month.

CREATE TYPE "BillingAutoSubscriptionStatus" AS ENUM (
  'pending',
  'in_flight',
  'completed',
  'needs_review',
  'failed',
  'superseded'
);

CREATE TABLE "billing_auto_subscription_intents" (
  "id" UUID NOT NULL,
  "billing_account_id" UUID NOT NULL,
  "source_invoice_id" UUID NOT NULL,
  "source_attempt_id" UUID NOT NULL,
  "plan_version_id" UUID NOT NULL,
  "stripe_customer_id" VARCHAR(255) NOT NULL,
  "stripe_payment_method_id" VARCHAR(255),
  "effective_period_start" TIMESTAMPTZ NOT NULL,
  "effective_period_end" TIMESTAMPTZ NOT NULL,
  "unit_amount_cents" INTEGER NOT NULL,
  "currency" VARCHAR(10) NOT NULL DEFAULT 'usd',
  "status" "BillingAutoSubscriptionStatus" NOT NULL DEFAULT 'pending',
  "operation_idempotency_key" VARCHAR(160) NOT NULL,
  "frozen_payload_json" JSONB,
  "stripe_subscription_id" VARCHAR(255),
  "dispatched_at" TIMESTAMPTZ,
  "payment_method_saved_at" TIMESTAMPTZ,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMPTZ,
  "lease_owner_id" VARCHAR(80),
  "lease_expires_at" TIMESTAMPTZ,
  "last_error_code" VARCHAR(80),
  "last_error_type" VARCHAR(80),
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "billing_auto_subscription_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_auto_subscription_intents_source_attempt_id_key"
  ON "billing_auto_subscription_intents" ("source_attempt_id");

CREATE UNIQUE INDEX "billing_auto_subscription_intents_operation_idempotency_key_key"
  ON "billing_auto_subscription_intents" ("operation_idempotency_key");

CREATE INDEX "billing_auto_subscription_intents_status_next_retry_at_idx"
  ON "billing_auto_subscription_intents" ("status", "next_retry_at");

CREATE INDEX "billing_auto_subscription_intents_billing_account_id_status_idx"
  ON "billing_auto_subscription_intents" ("billing_account_id", "status");

CREATE INDEX "billing_auto_subscription_intents_source_invoice_id_idx"
  ON "billing_auto_subscription_intents" ("source_invoice_id");

-- At most one account-blocking first-subscription intent:
-- pending/in_flight always block; needs_review blocks only when provider work
-- was dispatched (uncertain remote create must not free the slot).
CREATE UNIQUE INDEX "billing_auto_subscription_intents_one_unfinished_per_account_idx"
  ON "billing_auto_subscription_intents" ("billing_account_id")
  WHERE "status" IN ('pending', 'in_flight')
     OR ("status" = 'needs_review' AND "dispatched_at" IS NOT NULL);

ALTER TABLE "billing_auto_subscription_intents"
  ADD CONSTRAINT "billing_auto_subscription_intents_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_auto_subscription_intents"
  ADD CONSTRAINT "billing_auto_subscription_intents_plan_version_id_fkey"
  FOREIGN KEY ("plan_version_id") REFERENCES "billing_plan_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

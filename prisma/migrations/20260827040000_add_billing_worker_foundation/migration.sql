-- Phase 1 billing foundation (Oracle gate): cross-instance worker lease,
-- account-scoped reconciliation runs, transaction reconciliation progress,
-- persisted USDC submitted-hash/backoff, and a minimal Stripe subscription /
-- deferred-webhook data model.
--
-- No finalized invoice snapshot/hash is rewritten. No billing_plan_version is
-- rewritten in place; pricing-rate roll-forward is a separate versioned
-- migration that creates NEW plan versions.
--
-- Legacy reconciliation runs have NULL billing_account_id/account_user_id
-- (their scope is not provable) and are kept conservatively risky by
-- finalization; they are never backfilled.

-- Transaction: reconciliation progress marker + supporting index.
ALTER TABLE "transactions" ADD COLUMN "billing_reconciled_at" TIMESTAMPTZ;
CREATE INDEX "transactions_user_id_status_billing_reconciled_at_idx"
  ON "transactions" ("user_id", "status", "billing_reconciled_at");

-- BillingAccount: minimal Stripe subscription mirror (one active subscription).
ALTER TABLE "billing_accounts"
  ADD COLUMN "stripe_subscription_id" VARCHAR(255),
  ADD COLUMN "stripe_subscription_status" VARCHAR(40),
  ADD COLUMN "stripe_subscription_period_start" TIMESTAMPTZ,
  ADD COLUMN "active_subscription_plan_version_id" UUID;
CREATE UNIQUE INDEX "billing_accounts_stripe_subscription_id_key"
  ON "billing_accounts" ("stripe_subscription_id");

-- BillingReconciliationRun: account scope + worker lease.
ALTER TABLE "billing_reconciliation_runs"
  ADD COLUMN "billing_account_id" UUID,
  ADD COLUMN "account_user_id" UUID,
  ADD COLUMN "worker_id" VARCHAR(80),
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ,
  ADD COLUMN "heartbeat_at" TIMESTAMPTZ;
CREATE INDEX "billing_reconciliation_runs_status_lease_expires_at_idx"
  ON "billing_reconciliation_runs" ("status", "lease_expires_at");
CREATE INDEX "billing_reconciliation_runs_billing_account_id_period_start_idx"
  ON "billing_reconciliation_runs" ("billing_account_id", "period_start");

-- BillingPaymentAttempt: persisted user-submitted USDC hash + backoff +
-- Stripe renewal mapping.
ALTER TABLE "billing_payment_attempts"
  ADD COLUMN "stripe_invoice_id" VARCHAR(255),
  ADD COLUMN "stripe_subscription_id" VARCHAR(255),
  ADD COLUMN "stripe_charge_kind" VARCHAR(20),
  ADD COLUMN "submitted_tx_hash" VARCHAR(66),
  ADD COLUMN "next_check_at" TIMESTAMPTZ;
CREATE UNIQUE INDEX "billing_payment_attempts_stripe_invoice_id_key"
  ON "billing_payment_attempts" ("stripe_invoice_id");

-- Make legacy Stripe attempts explicit. NULL charge kind predates the
-- subscription rail and therefore means a full-invoice Checkout attempt.
-- This is idempotent and leaves USDC attempts untouched.
UPDATE "billing_payment_attempts"
SET "stripe_charge_kind" = 'full'
WHERE "method" = 'stripe' AND "stripe_charge_kind" IS NULL;

-- StripeWebhookEvent: deferred/unmatched renewal retry + bounded backoff.
ALTER TABLE "stripe_webhook_events"
  ADD COLUMN "retry_count" INTEGER,
  ADD COLUMN "next_retry_at" TIMESTAMPTZ,
  ADD COLUMN "error_type" VARCHAR(80),
  ADD COLUMN "error_code" VARCHAR(120),
  ADD COLUMN "account_user_id" UUID;
CREATE INDEX "stripe_webhook_events_status_next_retry_at_idx"
  ON "stripe_webhook_events" ("status", "next_retry_at");

-- NOTE: the accepted-rate pricing roll-forward is owned EXCLUSIVELY by the
-- next migration (20260827050000_remediate_oracle_gate1). It is not duplicated
-- here so exactly one migration mutates plan versions/assignments.

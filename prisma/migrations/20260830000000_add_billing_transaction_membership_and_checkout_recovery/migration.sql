ALTER TABLE "transactions"
  ADD COLUMN "billing_period_start" TIMESTAMPTZ,
  ADD COLUMN "billing_last_attempted_at" TIMESTAMPTZ,
  ADD COLUMN "user_op_hash" VARCHAR(66),
  ADD COLUMN "user_op_success" BOOLEAN;

-- Existing transactions have no receipt-derived accounting membership. The
-- product's durable pre-billing convention is the UTC submission/creation
-- month, which is available on every legacy row and is deterministic. Rows
-- created after this migration continue to persist the same month explicitly.
UPDATE "transactions"
SET "billing_period_start" = date_trunc('month', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
WHERE "billing_period_start" IS NULL;

CREATE UNIQUE INDEX "transactions_user_op_hash_key"
  ON "transactions"("user_op_hash");
CREATE INDEX "transactions_user_period_reconcile_attempt_idx"
  ON "transactions"("user_id", "billing_period_start", "billing_reconciled_at", "billing_last_attempted_at");

ALTER TABLE "billing_payment_attempts"
  ADD COLUMN "checkout_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkout_next_retry_at" TIMESTAMPTZ,
  ADD COLUMN "checkout_retry_owner_id" VARCHAR(80),
  ADD COLUMN "checkout_retry_lease_expires_at" TIMESTAMPTZ;

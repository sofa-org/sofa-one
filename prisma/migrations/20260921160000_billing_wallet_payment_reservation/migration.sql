-- Phase 2B: quote-bound Billing wallet-payment reservation binding.
-- Durable attempt ↔ Transaction link so dispatch-started payments retain
-- reservation across unknown outcomes and never auto-release/retry blindly.

-- Allow billing_payment operation type on transactions (dashboard IAM path).
ALTER TABLE "transactions"
  DROP CONSTRAINT IF EXISTS "transactions_operation_type_check";

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_operation_type_check"
  CHECK ("operation_type" IS NULL OR "operation_type" IN ('send', 'withdraw', 'billing_payment'));

-- Wallet-payment reservation columns on billing_payment_attempts.
ALTER TABLE "billing_payment_attempts"
  ADD COLUMN IF NOT EXISTS "wallet_payment_transaction_id" UUID,
  ADD COLUMN IF NOT EXISTS "wallet_payment_reserved" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "wallet_dispatch_started_at" TIMESTAMPTZ;

-- One attempt owns at most one wallet-payment Transaction (and vice versa).
CREATE UNIQUE INDEX IF NOT EXISTS "billing_payment_attempts_wallet_payment_transaction_id_key"
  ON "billing_payment_attempts" ("wallet_payment_transaction_id")
  WHERE "wallet_payment_transaction_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "billing_payment_attempts_wallet_payment_reserved_idx"
  ON "billing_payment_attempts" ("wallet_payment_reserved", "status")
  WHERE "wallet_payment_reserved" = true;

ALTER TABLE "billing_payment_attempts"
  ADD CONSTRAINT "billing_payment_attempts_wallet_payment_transaction_id_fkey"
  FOREIGN KEY ("wallet_payment_transaction_id")
  REFERENCES "transactions"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Phase 2B (B7): dashboard wallet-payment Transactions use auth_method = 'iam'.
-- Preserve all existing rows (historically only 'api_key') and widen the CHECK.
-- operation_type already allows billing_payment via 20260921160000.

ALTER TABLE "transactions"
  DROP CONSTRAINT IF EXISTS "transactions_auth_method_check";

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_auth_method_check"
  CHECK ("auth_method" IN ('api_key', 'iam'));

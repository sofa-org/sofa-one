-- Reconciliation quarantine is an explicit manual-review state. Keep this
-- migration idempotent because deployments may already have an equivalent
-- constraint revision applied.
ALTER TABLE "transactions"
DROP CONSTRAINT IF EXISTS "transactions_status_check";

ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_status_check"
CHECK ("status" IN ('submitting', 'pending', 'confirmed', 'failed', 'unknown', 'reverted', 'needs_review'));

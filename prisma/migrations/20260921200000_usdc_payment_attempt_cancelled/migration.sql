-- BILL-003: user-initiated cancel of a clean evidence-free pending USDC quote.
-- Adds terminal status `cancelled` plus dedicated cancelledAt/cancelReason
-- columns (do not reuse failedAt/failureCode or reviewReason semantics).
--
-- Idempotent: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so re-runs
-- and partially applied environments stay safe. `cancelled` is terminal and
-- outside the pending/confirming active-payment partial unique index, so a
-- successful cancel frees the per-invoice active USDC slot for a fresh quote.

ALTER TYPE "BillingPaymentAttemptStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "billing_payment_attempts"
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "cancel_reason" VARCHAR(80);

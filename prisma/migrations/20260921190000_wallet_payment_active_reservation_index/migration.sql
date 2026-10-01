-- Phase 2B B2/B6 remediation (M3/M4):
-- 1) Widen one-active-payment guard so walletPaymentReserved=true (any status,
--    including needs_review) blocks a second active Stripe/USDC attempt.
-- 2) Keep wallet_payment_transaction_id uniqueness as a PARTIAL unique index
--    only (NULLs distinct). Do not rely on a full-table unique constraint that
--    Prisma @unique would imply for all rows including NULL.

-- Drop the pending/confirming-only active-payment index and recreate with reservation.
DROP INDEX IF EXISTS "billing_payment_attempts_one_active_payment_per_invoice_idx";

CREATE UNIQUE INDEX "billing_payment_attempts_one_active_payment_per_invoice_idx"
ON "billing_payment_attempts"("invoice_id")
WHERE "status" IN ('pending', 'confirming')
   OR "wallet_payment_reserved" = true;

-- Ensure partial unique on wallet_payment_transaction_id exists (idempotent).
-- Full-table unique is NOT created — multiple NULL FKs must remain allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_payment_attempts_wallet_payment_transaction_id_key"
  ON "billing_payment_attempts" ("wallet_payment_transaction_id")
  WHERE "wallet_payment_transaction_id" IS NOT NULL;

-- Partial lookup index for reserved recovery (status scoped in app queries).
CREATE INDEX IF NOT EXISTS "billing_payment_attempts_wallet_payment_reserved_idx"
  ON "billing_payment_attempts" ("wallet_payment_reserved", "status")
  WHERE "wallet_payment_reserved" = true;

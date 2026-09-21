-- Phase 2B B2: bound wallet-payment Transaction must not be deleted while an
-- active reservation still references it (avoids SET NULL leaving reserved + null FK).
-- Disposable e2e DBs drop users/accounts via cascade of other tables; delete
-- payment attempts / unbind before deleting transactions in cleanup scripts.

ALTER TABLE "billing_payment_attempts"
  DROP CONSTRAINT IF EXISTS "billing_payment_attempts_wallet_payment_transaction_id_fkey";

ALTER TABLE "billing_payment_attempts"
  ADD CONSTRAINT "billing_payment_attempts_wallet_payment_transaction_id_fkey"
  FOREIGN KEY ("wallet_payment_transaction_id")
  REFERENCES "transactions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

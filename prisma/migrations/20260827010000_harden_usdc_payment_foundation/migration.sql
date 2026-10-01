-- Phase 3B hardening (Gate 1): USDC transfer-evidence uniqueness and an active
-- per-invoice/per-method slot that covers both pending and confirming attempts.
--
-- Semantics:
--   * billing_payment_attempts gains a unique index on the USDC Transfer
--     evidence columns (chain_id, token_address, tx_hash, log_index). The four
--     columns are nullable and only populated for method='usdc' rows; Postgres
--     treats NULLs as distinct, so partial evidence (e.g. tx_hash set but
--     log_index not yet known) never conflicts and Stripe rows (all NULL) are
--     unaffected. The index is representable in schema.prisma
--     (@@unique([chainId, tokenAddress, txHash, logIndex])) so `prisma migrate
--     dev` drift detection stays clean.
--   * The active per-invoice/per-method slot now covers 'pending' AND
--     'confirming', so a USDC attempt being confirmed cannot be displaced by a
--     new pending attempt on the same invoice + method. Like its predecessor,
--     this partial index is not representable in schema.prisma and must not be
--     dropped by `prisma migrate dev` drift detection.

-- CreateIndex (USDC Transfer evidence uniqueness). The name matches Prisma 7's
-- generated name for @@unique([chainId, tokenAddress, txHash, logIndex]) so
-- migrate drift detection stays clean.
CREATE UNIQUE INDEX "billing_payment_attempts_chain_id_token_address_tx_hash_log_key"
ON "billing_payment_attempts"("chain_id", "token_address", "tx_hash", "log_index");

-- DropIndex (old partial: one pending attempt per invoice + method)
DROP INDEX "billing_payment_attempts_one_pending_per_invoice_method_idx";

-- CreateIndex (partial: one active attempt per invoice + method)
CREATE UNIQUE INDEX "billing_payment_attempts_one_pending_per_invoice_method_idx"
ON "billing_payment_attempts"("invoice_id", "method")
WHERE "status" IN ('pending', 'confirming');
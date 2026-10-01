-- Phase 3B Phase 2: USDC expected-payer and required-confirmation snapshots.
--
-- Semantics:
--   * billing_payment_attempts gains expected_payer_address (the invoice
--     owner's SOFA/Openfort UserWallet.walletAddress at quote time) and
--     required_confirmations (the configured confirmation threshold at quote
--     time). Both are nullable and only populated for method='usdc' rows; they
--     are immutable quote snapshots — the claim path reads them, never the
--     client, so a later wallet/chain/config change cannot alter an in-flight
--     payment's expected payer or finality threshold.
--
--   * Attempt deletion protection: the application has no delete path for
--     billing_payment_attempts. The only FK referencing attempts is
--     billing_invoices.settlement_attempt_id (ON DELETE SET NULL), which never
--     deletes attempts. Attempts are the payment evidence ledger and must
--     never be deleted; this migration adds no delete path and no cascade.
--
--   * Legacy Stripe backfill: the applied Foundation migration
--     (20260827000000) backfilled existing paid invoices to paid_via='stripe'
--     and pointed settlement_attempt_id at their earliest succeeded attempt.
--     That backfill is legacy Stripe-only and must not be re-run or extended
--     to USDC rows; new USDC settlements always flow through the atomic
--     first-rail-wins InvoiceSettlementService CAS.

-- AlterTable: billing_payment_attempts
ALTER TABLE "billing_payment_attempts" ADD COLUMN "expected_payer_address" VARCHAR(42);
ALTER TABLE "billing_payment_attempts" ADD COLUMN "required_confirmations" INTEGER;
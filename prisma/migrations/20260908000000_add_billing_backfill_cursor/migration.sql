-- Additive, idempotent backfill cursor for the historical open-invoice
-- materialization (BillingWorkerService).
--
-- BillingAccount.billingBackfillCursor stores the normalized UTC month start of
-- the furthest historical month a worker has scanned for missing invoices, so
-- the bounded historical selection advances deterministically (round-robin)
-- instead of repeatedly re-selecting the same newest periods and starving older
-- ones — even when some periods fail materialization.
--
-- Additive only: it does not rewrite invoices, usage events, or plan data, and
-- legacy accounts keep a NULL cursor (meaning "start from the oldest missing
-- month").

-- AlterTable
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "billing_backfill_cursor" TIMESTAMPTZ;

-- Relax transaction audit CHECK constraints to match values the application
-- already writes. No data is deleted; each constraint is dropped (IF EXISTS)
-- and rebuilt with the full set of allowed values, preserving all existing ones.

-- operation_type: the dashboard withdrawal flow writes 'withdraw' in addition
-- to the public API 'send'. Keep the NULL allowance (non-send operations).
ALTER TABLE "transactions"
DROP CONSTRAINT IF EXISTS "transactions_operation_type_check";

ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_operation_type_check"
CHECK ("operation_type" IS NULL OR "operation_type" IN ('send', 'withdraw'));

-- status: keep the existing state machine and add 'unknown' (already written by
-- the application) plus 'reverted', reserved for future reconciliation flows.
ALTER TABLE "transactions"
DROP CONSTRAINT IF EXISTS "transactions_status_check";

ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_status_check"
CHECK ("status" IN ('submitting', 'pending', 'confirmed', 'failed', 'unknown', 'reverted'));

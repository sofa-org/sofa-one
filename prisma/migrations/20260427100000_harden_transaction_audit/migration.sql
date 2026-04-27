-- Add immutable API-key attribution snapshots and structured audit metadata for transaction submissions.
ALTER TABLE "transactions"
ADD COLUMN "api_key_id" UUID,
ADD COLUMN "auth_method" VARCHAR(20) NOT NULL DEFAULT 'api_key',
ADD COLUMN "api_key_prefix" VARCHAR(12),
ADD COLUMN "api_key_name" VARCHAR(100),
ADD COLUMN "interactions_hash" VARCHAR(64),
ADD COLUMN "failure_reason" VARCHAR(500),
ADD COLUMN "completed_at" TIMESTAMPTZ;

-- Normalize the legacy failure sentinel before tightening the status constraint.
UPDATE "transactions"
SET "status" = 'failed',
    "failure_reason" = COALESCE("failure_reason", 'Legacy unknown status normalized to failed')
WHERE "status" = 'unknown';

-- Keep transaction audit values constrained to the application-supported state machine.
ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_auth_method_check" CHECK ("auth_method" IN ('api_key')),
ADD CONSTRAINT "transactions_status_check" CHECK ("status" IN ('submitting', 'pending', 'confirmed', 'failed')),
ADD CONSTRAINT "transactions_operation_type_check" CHECK ("operation_type" IS NULL OR "operation_type" IN ('send'));

CREATE INDEX "transactions_api_key_id_created_at_idx" ON "transactions"("api_key_id", "created_at");
CREATE INDEX "transactions_request_hash_idx" ON "transactions"("request_hash");

ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

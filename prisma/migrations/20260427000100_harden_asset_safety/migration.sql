-- Add asset-safety idempotency columns.
ALTER TABLE "transactions" ADD COLUMN "operation_type" VARCHAR(30);
ALTER TABLE "transactions" ADD COLUMN "idempotency_key" VARCHAR(64);

-- Atomic idempotency for operations that provide a key.
CREATE UNIQUE INDEX "transactions_user_id_operation_type_idempotency_key_key"
  ON "transactions"("user_id", "operation_type", "idempotency_key");

-- Speed up API key prefix lookup without making collisions impossible.
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");

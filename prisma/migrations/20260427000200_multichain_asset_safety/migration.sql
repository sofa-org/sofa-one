-- Scope API keys to explicit chains. Existing keys keep the original default chain only.
ALTER TABLE "api_keys"
  ADD COLUMN "allowed_chains" INTEGER[] NOT NULL DEFAULT ARRAY[84532]::INTEGER[];

-- Store a request fingerprint for idempotency conflict detection.
ALTER TABLE "transactions"
  ADD COLUMN "request_hash" VARCHAR(64);

-- Idempotency is chain-aware for multi-chain execution.
DROP INDEX IF EXISTS "transactions_user_id_operation_type_idempotency_key_key";

CREATE UNIQUE INDEX "transactions_user_id_operation_type_chain_id_idempotency_key_key"
  ON "transactions"("user_id", "operation_type", "chain_id", "idempotency_key");

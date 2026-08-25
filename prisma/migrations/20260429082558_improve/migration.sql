-- Add query indexes for API key ownership and transaction history lookups.
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

CREATE INDEX "transactions_user_id_status_idx" ON "transactions"("user_id", "status");

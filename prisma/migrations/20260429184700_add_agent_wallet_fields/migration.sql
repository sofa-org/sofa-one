-- Reinterpret user_wallets.openfort_account_id/wallet_address as the user's embedded wallet.
-- Add backend agent wallet/session-key metadata used for Calibur UserOperation execution.
ALTER TABLE "user_wallets"
  ALTER COLUMN "status" TYPE VARCHAR(30),
  ADD COLUMN "agent_openfort_account_id" VARCHAR(255),
  ADD COLUMN "agent_wallet_address" VARCHAR(42),
  ADD COLUMN "agent_key_hash" VARCHAR(66),
  ADD COLUMN "agent_status" VARCHAR(30),
  ADD COLUMN "agent_expires_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX "user_wallets_agent_openfort_account_id_key"
  ON "user_wallets"("agent_openfort_account_id");

CREATE UNIQUE INDEX "user_wallets_agent_wallet_address_key"
  ON "user_wallets"("agent_wallet_address");

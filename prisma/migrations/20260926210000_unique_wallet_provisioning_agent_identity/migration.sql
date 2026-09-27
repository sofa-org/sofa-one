-- Provider agent identities must be globally unique across provisioning intents.
-- Fail closed if historical duplicate identities exist; do not silently rewrite them.
CREATE UNIQUE INDEX "wallet_provisioning_intents_agent_openfort_account_id_key"
  ON "wallet_provisioning_intents"("agent_openfort_account_id");

CREATE UNIQUE INDEX "wallet_provisioning_intents_agent_wallet_address_lower_key"
  ON "wallet_provisioning_intents"(lower("agent_wallet_address"))
  WHERE "agent_wallet_address" IS NOT NULL;

-- Coordinate with the application cutover: old binaries reference the renamed columns.
BEGIN;

ALTER TABLE "user_wallets" RENAME COLUMN "agent_wallet_address" TO "signer_address";
ALTER INDEX "user_wallets_agent_wallet_address_key" RENAME TO "user_wallets_signer_address_key";
ALTER TABLE "wallet_provisioning_intents" RENAME COLUMN "agent_wallet_address" TO "signer_address";
ALTER INDEX "wallet_provisioning_intents_agent_wallet_address_lower_key"
  RENAME TO "wallet_provisioning_intents_signer_address_lower_key";

-- Preserve legacy transaction ownership evidence under the new key. Conflicting
-- dual-key records require operator review rather than choosing an identity.
LOCK TABLE "transactions" IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "transactions"
    WHERE jsonb_typeof("details") = 'object'
      AND "details" ? 'agentWalletAddress'
      AND "details" ? 'signerAddress'
      AND "details"->'agentWalletAddress' IS DISTINCT FROM "details"->'signerAddress'
  ) THEN
    RAISE EXCEPTION 'Conflicting transaction signer address metadata; review before migration';
  END IF;
END $$;

UPDATE "transactions"
SET "details" = ("details" - 'agentWalletAddress')
  || jsonb_build_object('signerAddress', "details"->'agentWalletAddress')
WHERE jsonb_typeof("details") = 'object' AND "details" ? 'agentWalletAddress';

COMMIT;

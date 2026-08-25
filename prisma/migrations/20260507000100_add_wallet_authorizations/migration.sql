CREATE TABLE "wallet_chain_authorizations" (
  "wallet_id" UUID NOT NULL,
  "chain_id" BIGINT NOT NULL,
  "status" VARCHAR(30) NOT NULL,
  "registration_tx_hash" VARCHAR(66),
  "expires_at" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wallet_chain_authorizations_pkey" PRIMARY KEY ("wallet_id", "chain_id"),
  CONSTRAINT "wallet_chain_authorizations_wallet_id_fkey"
    FOREIGN KEY ("wallet_id") REFERENCES "user_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "wallet_chain_authorizations" (
  "wallet_id",
  "chain_id",
  "status",
  "registration_tx_hash",
  "expires_at",
  "updated_at"
)
SELECT
  "id",
  "chain_id",
  "agent_status",
  "agent_registration_tx_hash",
  "agent_expires_at",
  CURRENT_TIMESTAMP
FROM "user_wallets"
WHERE "chain_id" IS NOT NULL
  AND "agent_status" IS NOT NULL;

ALTER TABLE "user_wallets"
  DROP COLUMN "chain_id",
  DROP COLUMN "agent_status",
  DROP COLUMN "agent_registration_tx_hash",
  DROP COLUMN "agent_expires_at";

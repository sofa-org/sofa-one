-- Bind legacy credentials only when ownership is unambiguous across every wallet row.
BEGIN;

-- Block wallet-row inserts, deletes, and ownership updates while taking the legacy census.
LOCK TABLE "user_wallets" IN SHARE MODE;

ALTER TABLE "api_keys" ADD COLUMN "wallet_id" UUID;

WITH wallet_counts AS (
  SELECT "user_id", COUNT(*) AS count, MIN("id"::text)::uuid AS wallet_id
  FROM "user_wallets"
  GROUP BY "user_id"
)
UPDATE "api_keys" AS key
SET "wallet_id" = counts.wallet_id
FROM wallet_counts AS counts
WHERE key."user_id" = counts."user_id" AND counts.count = 1;

UPDATE "api_keys" SET "revoked" = TRUE WHERE "wallet_id" IS NULL AND "revoked" = FALSE;

ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_id_user_id_key" UNIQUE ("id", "user_id");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_wallet_id_user_id_fkey"
  FOREIGN KEY ("wallet_id", "user_id") REFERENCES "user_wallets"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_wallet_binding_check"
  CHECK ("revoked" OR "wallet_id" IS NOT NULL);
CREATE INDEX "api_keys_wallet_id_idx" ON "api_keys"("wallet_id");

COMMIT;

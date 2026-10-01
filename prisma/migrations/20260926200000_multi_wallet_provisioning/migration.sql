-- Preserve existing wallet identities while allowing additional wallets.
-- user_id uniqueness was created as an INDEX (not a table constraint).
-- Fail closed if historical addresses collide case-insensitively; do not merge
-- or rewrite wallet identities. PostgreSQL reports the conflicting index key.
CREATE UNIQUE INDEX "user_wallets_wallet_address_lower_key"
  ON "user_wallets" (lower("wallet_address"))
  WHERE "wallet_address" IS NOT NULL;

DROP INDEX IF EXISTS "user_wallets_user_id_key";
ALTER TABLE "user_wallets" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;
UPDATE "user_wallets" SET "is_default" = true;
CREATE INDEX "user_wallets_user_id_idx" ON "user_wallets"("user_id");
CREATE UNIQUE INDEX "user_wallets_one_default_per_user_key"
  ON "user_wallets"("user_id") WHERE "is_default" = true;

CREATE TYPE "WalletProvisioningIntentStatus" AS ENUM
  ('pending', 'dispatched', 'uncertain', 'provisioned', 'completed');

CREATE TABLE "wallet_provisioning_intents" (
  "id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "status" "WalletProvisioningIntentStatus" NOT NULL DEFAULT 'pending',
  "dispatch_token" VARCHAR(120),
  "dispatched_at" TIMESTAMPTZ,
  "agent_openfort_account_id" VARCHAR(255),
  "agent_wallet_address" VARCHAR(42),
  "agent_key_hash" VARCHAR(66),
  "resolution" VARCHAR(40),
  "resolution_details" VARCHAR(1000),
  "resolved_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_provisioning_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_provisioning_intents_wallet_id_fkey" FOREIGN KEY ("wallet_id")
    REFERENCES "user_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "wallet_provisioning_intents_wallet_id_key"
  ON "wallet_provisioning_intents"("wallet_id");
CREATE UNIQUE INDEX "wallet_provisioning_intents_dispatch_token_key"
  ON "wallet_provisioning_intents"("dispatch_token");
CREATE INDEX "wallet_provisioning_intents_status_created_at_idx"
  ON "wallet_provisioning_intents"("status", "created_at");

ALTER TABLE "billing_accounts"
  ADD COLUMN "eligible_wallet_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "wallet_count_observed_at" TIMESTAMPTZ;
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_eligible_wallet_count_check"
  CHECK ("eligible_wallet_count" >= 0);

CREATE TABLE "billing_wallet_usage_periods" (
  "id" UUID NOT NULL,
  "billing_account_id" UUID NOT NULL,
  "period_start" TIMESTAMPTZ NOT NULL,
  "peak_wallet_count" INTEGER NOT NULL DEFAULT 0,
  "observed_at" TIMESTAMPTZ,
  CONSTRAINT "billing_wallet_usage_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_wallet_usage_periods_account_fkey" FOREIGN KEY ("billing_account_id")
    REFERENCES "billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "billing_wallet_usage_periods_peak_check" CHECK ("peak_wallet_count" >= 0)
);
CREATE UNIQUE INDEX "billing_wallet_usage_periods_account_period_key"
  ON "billing_wallet_usage_periods"("billing_account_id", "period_start");

-- Rollout baseline: current eligible wallets only. Historical peak periods are
-- intentionally left absent/unknown; this does not invent past concurrency.
-- Older wallet owners may not yet have touched billing. Materialize their
-- account before the baseline so a later lazy account create cannot lose it.
INSERT INTO "billing_accounts" ("user_id", "updated_at")
SELECT DISTINCT uw."user_id", CURRENT_TIMESTAMP
FROM "user_wallets" uw
WHERE uw."status" = 'active'
  AND uw."wallet_address" IS NOT NULL
  AND uw."frozen_at" IS NULL
ON CONFLICT ("user_id") DO NOTHING;

WITH current_period AS (
  SELECT date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS period_start
), counts AS (
  SELECT ba."id" AS account_id,
         COUNT(uw."id")::INTEGER AS wallet_count
  FROM "billing_accounts" ba
  JOIN "users" u ON u."id" = ba."user_id"
  LEFT JOIN "user_wallets" uw ON uw."user_id" = u."id"
    AND uw."status" = 'active'
    AND uw."wallet_address" IS NOT NULL
    AND uw."frozen_at" IS NULL
  GROUP BY ba."id"
)
UPDATE "billing_accounts" ba
SET "eligible_wallet_count" = counts.wallet_count,
    "wallet_count_observed_at" = CURRENT_TIMESTAMP
FROM counts WHERE ba."id" = counts.account_id;

INSERT INTO "billing_wallet_usage_periods"
  ("id", "billing_account_id", "period_start", "peak_wallet_count", "observed_at")
SELECT gen_random_uuid(), ba."id",
       date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       ba."eligible_wallet_count", CURRENT_TIMESTAMP
FROM "billing_accounts" ba;

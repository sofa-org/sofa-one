-- Add withdrawal policy and allowlisted-address tables for dashboard withdrawal controls.
CREATE TABLE "withdrawal_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "single_withdrawal_limit" VARCHAR(40) NOT NULL DEFAULT '10000000000',
  "daily_withdrawal_limit" VARCHAR(40),
  "require_address_allowlist" BOOLEAN NOT NULL DEFAULT false,
  "new_address_cooldown_hours" INTEGER NOT NULL DEFAULT 24,
  "require_step_up" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "withdrawal_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "withdrawal_policies_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "withdrawal_policies_user_id_key" ON "withdrawal_policies"("user_id");

CREATE TABLE "withdrawal_addresses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "address" VARCHAR(42) NOT NULL,
  "label" VARCHAR(100),
  "available_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "withdrawal_addresses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "withdrawal_addresses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "withdrawal_addresses_user_id_address_key"
  ON "withdrawal_addresses"("user_id", "address");

CREATE INDEX "withdrawal_addresses_user_id_available_at_idx"
  ON "withdrawal_addresses"("user_id", "available_at");

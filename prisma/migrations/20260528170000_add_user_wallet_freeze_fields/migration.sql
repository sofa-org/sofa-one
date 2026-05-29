-- Add explicit user and wallet freeze state for emergency/security lockout.
ALTER TABLE "users"
ADD COLUMN "frozen_at" TIMESTAMPTZ,
ADD COLUMN "frozen_reason" VARCHAR(255);

ALTER TABLE "user_wallets"
ADD COLUMN "frozen_at" TIMESTAMPTZ,
ADD COLUMN "frozen_reason" VARCHAR(255);

CREATE INDEX "user_wallets_user_id_frozen_at_idx" ON "user_wallets"("user_id", "frozen_at");

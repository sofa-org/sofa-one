ALTER TABLE "api_keys"
ADD COLUMN "frozen_at" TIMESTAMPTZ,
ADD COLUMN "frozen_reason" VARCHAR(255);

CREATE INDEX "api_keys_user_id_frozen_at_idx" ON "api_keys"("user_id", "frozen_at");

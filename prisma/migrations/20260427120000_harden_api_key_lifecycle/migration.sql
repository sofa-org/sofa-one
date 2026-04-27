-- Harden API-key lifecycle management with audit events, lookup indexes,
-- and active-name uniqueness for user-facing API-key management.

CREATE TABLE "api_key_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "api_key_id" UUID,
  "action" VARCHAR(40) NOT NULL,
  "key_prefix" VARCHAR(32),
  "key_name" VARCHAR(100),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_key_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "api_key_events"
  ADD CONSTRAINT "api_key_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "api_key_events"
  ADD CONSTRAINT "api_key_events_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "api_key_events"
  ADD CONSTRAINT "api_key_events_action_check"
  CHECK ("action" IN ('api_key.created', 'api_key.revoked', 'api_key.rotated', 'api_key.permission_changed'));

CREATE INDEX "api_keys_user_id_revoked_idx" ON "api_keys"("user_id", "revoked");
CREATE INDEX "api_key_events_user_id_created_at_idx" ON "api_key_events"("user_id", "created_at");
CREATE INDEX "api_key_events_api_key_id_created_at_idx" ON "api_key_events"("api_key_id", "created_at");

CREATE UNIQUE INDEX "api_keys_user_active_name_unique"
  ON "api_keys"("user_id", lower("name"))
  WHERE "revoked" = false AND "name" IS NOT NULL;

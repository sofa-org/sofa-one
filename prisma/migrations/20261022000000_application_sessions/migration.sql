CREATE TABLE "app_sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
  "mfa_pending_until" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "app_sessions_lifetime_check" CHECK ("mfa_pending_until" <= "expires_at" AND "created_at" < "expires_at")
);
CREATE UNIQUE INDEX "app_sessions_token_hash_key" ON "app_sessions"("token_hash");
CREATE UNIQUE INDEX "app_sessions_id_user_id_key" ON "app_sessions"("id", "user_id");
CREATE INDEX "app_sessions_user_id_revoked_at_idx" ON "app_sessions"("user_id", "revoked_at");
CREATE INDEX "app_sessions_expires_at_idx" ON "app_sessions"("expires_at");

-- Legacy proofs have no application-session identity and must never survive cutover.
DELETE FROM "step_up_challenges";
ALTER TABLE "step_up_challenges" ADD COLUMN "session_id" UUID NOT NULL;
ALTER TABLE "step_up_challenges" ADD CONSTRAINT "step_up_challenges_session_id_user_id_fkey"
  FOREIGN KEY ("session_id", "user_id") REFERENCES "app_sessions"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "step_up_challenges_session_id_idx" ON "step_up_challenges"("session_id");

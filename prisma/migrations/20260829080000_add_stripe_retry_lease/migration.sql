ALTER TABLE "stripe_webhook_events"
ADD COLUMN IF NOT EXISTS "retry_owner_id" VARCHAR(120),
ADD COLUMN IF NOT EXISTS "retry_lease_expires_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "stripe_webhook_events_retry_lease_idx"
ON "stripe_webhook_events" ("status", "next_retry_at", "retry_lease_expires_at");

-- Gate 1 attempt 3: sync uncertain-state fields, subscription create lease,
-- effective period bounds for historical renewal identity.

ALTER TABLE "billing_subscription_sync_intents"
  ADD COLUMN IF NOT EXISTS "frozen_payload_json" JSONB,
  ADD COLUMN IF NOT EXISTS "dispatched_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "effective_period_start" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "effective_period_end" TIMESTAMPTZ;

ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "subscription_create_lease_owner_id" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "subscription_create_lease_expires_at" TIMESTAMPTZ;

-- Active unique already covers pending+in_flight; keep as-is.
CREATE INDEX IF NOT EXISTS "billing_subscription_sync_intents_effective_period_idx"
  ON "billing_subscription_sync_intents" ("billing_account_id", "effective_period_start", "status");

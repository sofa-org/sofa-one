-- Expand account-blocking partial unique: dispatched needs_review must keep
-- the account slot until the uncertain remote create is dispositioned.
-- Safe to re-run: drop + recreate the same index name.

DROP INDEX IF EXISTS "billing_auto_subscription_intents_one_unfinished_per_account_idx";

CREATE UNIQUE INDEX "billing_auto_subscription_intents_one_unfinished_per_account_idx"
  ON "billing_auto_subscription_intents" ("billing_account_id")
  WHERE "status" IN ('pending', 'in_flight')
     OR ("status" = 'needs_review' AND "dispatched_at" IS NOT NULL);

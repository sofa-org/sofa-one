-- Gate 1 attempt 3 follow-up: allow queued pending revisions while an
-- uncertain/dispatched operation is in_flight.
--
-- Old invariant (one pending OR in_flight per account) blocked enqueue of a
-- newer revision behind an in_flight/uncertain intent (P2002 on create).
-- New invariant: at most one provider-owned in_flight row per account;
-- multiple pending revisions may coexist and dispatch strictly by revision.

DROP INDEX IF EXISTS "billing_subscription_sync_intents_one_active_per_account_idx";

-- At most one provider-dispatched owner per account.
CREATE UNIQUE INDEX "billing_subscription_sync_intents_one_in_flight_per_account_idx"
  ON "billing_subscription_sync_intents" ("billing_account_id")
  WHERE "status" = 'in_flight';

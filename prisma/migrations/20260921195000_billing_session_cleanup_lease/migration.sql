-- BILL-014: durable post-paid sibling Checkout Session cleanup lease/retry.
-- Provider expire runs outside DB locks; paid facts are never mutated by cleanup.
ALTER TABLE "billing_payment_attempts"
  ADD COLUMN "session_cleanup_status" VARCHAR(20),
  ADD COLUMN "session_cleanup_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "session_cleanup_next_retry_at" TIMESTAMPTZ,
  ADD COLUMN "session_cleanup_owner_id" VARCHAR(80),
  ADD COLUMN "session_cleanup_lease_expires_at" TIMESTAMPTZ,
  ADD COLUMN "session_cleanup_completed_at" TIMESTAMPTZ;

-- Due-work helper: cleanup candidates (with or without a local Session ID yet).
-- Late discovery binds a provider Session via metadata without blind recreate.
CREATE INDEX "billing_payment_attempts_session_cleanup_due_idx"
  ON "billing_payment_attempts" (
    "session_cleanup_next_retry_at",
    "session_cleanup_status",
    "created_at"
  )
  WHERE "session_cleanup_completed_at" IS NULL
    AND "method" = 'stripe'
    AND (
      "session_cleanup_status" IS NULL
      OR "session_cleanup_status" IN ('pending', 'in_flight')
    );

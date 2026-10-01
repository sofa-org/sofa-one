-- Durable keyset cursor for first-subscription missing-intent recovery so
-- permanently ineligible candidates do not starve later eligible rows across
-- worker ticks. Singleton row id = 'default'.

CREATE TABLE IF NOT EXISTS "billing_auto_sub_recovery_cursors" (
  "id" VARCHAR(40) NOT NULL,
  "cursor_succeeded_at" TIMESTAMPTZ,
  "cursor_attempt_id" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_auto_sub_recovery_cursors_pkey" PRIMARY KEY ("id")
);

INSERT INTO "billing_auto_sub_recovery_cursors" ("id", "updated_at")
VALUES ('default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

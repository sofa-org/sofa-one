CREATE TABLE "security_notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "security_event_id" UUID,
  "type" VARCHAR(80) NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "body" VARCHAR(500) NOT NULL,
  "risk_level" VARCHAR(20) NOT NULL DEFAULT 'medium',
  "read_at" TIMESTAMPTZ,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "security_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "security_notifications_user_id_read_at_created_at_idx"
  ON "security_notifications"("user_id", "read_at", "created_at");
CREATE INDEX "security_notifications_security_event_id_idx"
  ON "security_notifications"("security_event_id");

ALTER TABLE "security_notifications"
  ADD CONSTRAINT "security_notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "security_notifications"
  ADD CONSTRAINT "security_notifications_security_event_id_fkey"
  FOREIGN KEY ("security_event_id") REFERENCES "security_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

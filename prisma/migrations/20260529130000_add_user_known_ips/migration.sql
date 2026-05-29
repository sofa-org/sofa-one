CREATE TABLE "user_known_ips" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "ip" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_known_ips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_known_ips_user_id_ip_key"
  ON "user_known_ips"("user_id", "ip");

CREATE INDEX "user_known_ips_user_id_idx"
  ON "user_known_ips"("user_id");

ALTER TABLE "user_known_ips"
  ADD CONSTRAINT "user_known_ips_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

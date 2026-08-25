ALTER TABLE "api_keys"
  ADD COLUMN "last_used_ip" VARCHAR(64),
  ADD COLUMN "last_used_user_agent" VARCHAR(255);

ALTER TABLE "api_keys" DROP COLUMN "allowed_contracts", DROP COLUMN "allowed_function_selectors";
ALTER TABLE "api_keys" ADD COLUMN "allowed_capability_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE TABLE "defi_policy_state" (
  "id" VARCHAR(16) NOT NULL,
  "paused_scope_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defi_policy_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defi_policy_state_singleton_check" CHECK ("id" = 'global')
);
INSERT INTO "defi_policy_state" ("id", "paused_scope_keys") VALUES ('global', ARRAY[]::TEXT[]);

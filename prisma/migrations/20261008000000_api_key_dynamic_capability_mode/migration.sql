BEGIN;

CREATE TYPE "api_key_capability_mode" AS ENUM ('all', 'custom');

ALTER TABLE "api_keys" ADD COLUMN "capability_mode" "api_key_capability_mode";

UPDATE "api_keys"
SET "capability_mode" = CASE
  WHEN cardinality("allowed_capability_ids") = 0 THEN 'all'::"api_key_capability_mode"
  ELSE 'custom'::"api_key_capability_mode"
END;

ALTER TABLE "api_keys" ALTER COLUMN "capability_mode" SET DEFAULT 'all';
ALTER TABLE "api_keys" ALTER COLUMN "capability_mode" SET NOT NULL;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_capability_mode_ids_check"
  CHECK ("capability_mode" <> 'all'::"api_key_capability_mode" OR cardinality("allowed_capability_ids") = 0);

COMMIT;

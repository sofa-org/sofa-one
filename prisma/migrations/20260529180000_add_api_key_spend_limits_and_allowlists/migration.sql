-- AlterTable: Add contract allowlist, function selector allowlist, and spend limits to ApiKey
ALTER TABLE "api_keys" ADD COLUMN "allowed_contracts" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "api_keys" ADD COLUMN "allowed_function_selectors" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "api_keys" ADD COLUMN "daily_spend_limit" VARCHAR(40);
ALTER TABLE "api_keys" ADD COLUMN "monthly_spend_limit" VARCHAR(40);
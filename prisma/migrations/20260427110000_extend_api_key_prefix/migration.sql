-- Extend stored API-key lookup prefixes from 11 chars (32-bit) to 27 chars (96-bit).
-- Existing rows keep their legacy prefixes and remain valid through multi-candidate verification.
ALTER TABLE "api_keys" ALTER COLUMN "key_prefix" TYPE VARCHAR(32);
ALTER TABLE "signing_requests" ALTER COLUMN "api_key_prefix" TYPE VARCHAR(32);
ALTER TABLE "transactions" ALTER COLUMN "api_key_prefix" TYPE VARCHAR(32);

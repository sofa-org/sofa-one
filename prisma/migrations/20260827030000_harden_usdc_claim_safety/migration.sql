-- Phase 3B Phase 2 hardening (Oracle Gate): tx_hash canonicalization at the
-- database layer and a non-secret provider identity on the quote snapshot.
--
-- Semantics:
--   * billing_payment_attempts gains provider_identity (VARCHAR(64)): a
--     non-secret digest derived from the per-chain RPC URL at quote time. The
--     raw URL (which may embed an API key) is never persisted, logged, or
--     returned; the claim path recomputes the digest from current config and
--     fails closed when the snapshot no longer matches the operational
--     provider configuration.
--   * tx_hash is canonicalized to lowercase so PostgreSQL VARCHAR uniqueness
--     cannot be bypassed by client casing. The migration first detects any
--     normalized collision (two rows whose tx_hash differ only by case within
--     the same evidence tuple) and fails closed, then lowercases every
--     existing hash, then adds a CHECK constraint that rejects any future
--     non-lowercase write. Combined with the existing
--     (chain_id, token_address, tx_hash, log_index) unique index, the
--     evidence tuple is case-safe at the database layer — not just in the
--     controller.
--
-- The CHECK constraint is not representable in schema.prisma (like the
-- partial active-attempt index) and must not be dropped by `prisma migrate
-- dev` drift detection.

-- AlterTable: billing_payment_attempts
ALTER TABLE "billing_payment_attempts" ADD COLUMN "provider_identity" VARCHAR(64);

-- Fail closed on any normalized tx_hash collision before lowercasing. Only
-- tuples where the unique evidence index would actually conflict (all four
-- columns non-null) are considered.
DO $$
DECLARE
  collision_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT "chain_id", "token_address", "log_index", lower("tx_hash")
    FROM "billing_payment_attempts"
    WHERE "tx_hash" IS NOT NULL
      AND "chain_id" IS NOT NULL
      AND "token_address" IS NOT NULL
      AND "log_index" IS NOT NULL
    GROUP BY "chain_id", "token_address", "log_index", lower("tx_hash")
    HAVING COUNT(DISTINCT "tx_hash") > 1
  ) AS normalized_collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION
      'Normalized tx_hash collision detected in billing_payment_attempts; resolve before applying migration';
  END IF;
END $$;

-- Canonicalize existing hashes to lowercase.
UPDATE "billing_payment_attempts" SET "tx_hash" = lower("tx_hash") WHERE "tx_hash" IS NOT NULL;

-- Database-layer lowercase enforcement: case can never bypass evidence
-- uniqueness. NULLs pass the CHECK (NULL = lower(NULL) is NULL, not false).
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "billing_payment_attempts_tx_hash_lowercase_check"
CHECK ("tx_hash" = lower("tx_hash"));
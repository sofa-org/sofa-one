-- StripeWebhookEventStatus: add the enum values used by the billing worker and
-- webhook service (deferred/needs_review/failed). The Phase 3A base migration
-- created the enum with only ('processed','ignored'); the renewal worker and
-- deferred-event retry paths introduced the other values without a migration.
--
-- Idempotent on both paths:
--   * fresh database: the base migration creates ('processed','ignored'), this
--     migration appends the remaining values in schema order;
--   * already-foundation-migrated database: IF NOT EXISTS is a no-op for any
--     value that already exists.
-- Appending in schema order (processed, ignored, deferred, needs_review, failed)
-- keeps the PostgreSQL enum ordering identical to the Prisma schema.

ALTER TYPE "StripeWebhookEventStatus" ADD VALUE IF NOT EXISTS 'deferred';
ALTER TYPE "StripeWebhookEventStatus" ADD VALUE IF NOT EXISTS 'needs_review';
ALTER TYPE "StripeWebhookEventStatus" ADD VALUE IF NOT EXISTS 'failed';
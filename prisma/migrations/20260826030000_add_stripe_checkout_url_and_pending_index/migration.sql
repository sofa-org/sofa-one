-- Phase 3A: persist the hosted Checkout URL on the payment attempt so a valid
-- pending Checkout session can be reused without a remote Stripe fetch, and
-- enforce at most one pending attempt per invoice (partial unique index) so
-- concurrent checkout requests cannot create visible duplicate pending
-- attempts.
--
-- The partial unique index is intentionally not representable in
-- schema.prisma (Prisma does not support partial indexes); it is applied only
-- through this migration and must not be dropped by `prisma migrate dev`
-- drift detection. Use `prisma migrate deploy` for environments.

-- AlterTable
ALTER TABLE "billing_payment_attempts" ADD COLUMN "checkout_url" VARCHAR(2048);

-- CreateIndex (partial: one pending attempt per invoice)
CREATE UNIQUE INDEX "billing_payment_attempts_one_pending_per_invoice_idx"
ON "billing_payment_attempts"("invoice_id")
WHERE "status" = 'pending';
-- Commercial Billing Phase 3A foundation: Stripe payment tracking.
--
-- Semantics:
--   * billing_accounts gains an optional, unique Stripe Customer ID.
--   * billing_invoices gains an optional paid_at timestamp; the existing
--     BillingInvoiceStatus enum is unchanged.
--   * billing_payment_attempts records one row per payment attempt against an
--     invoice (pending/succeeded/failed), snapshotting amount/currency and
--     safe failure code/message only. Stripe Checkout Session and PaymentIntent
--     IDs are unique lookup keys. No secrets or raw Stripe payloads are stored.
--     Multiple attempts per invoice are allowed to support later retries.
--   * stripe_webhook_events records processed/ignored webhook events by Stripe
--     event id (unique) with type, safe object id, and received/processed
--     timestamps. The full Stripe payload is never persisted.

-- CreateEnum
CREATE TYPE "BillingPaymentAttemptStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "StripeWebhookEventStatus" AS ENUM ('processed', 'ignored');

-- AlterTable
ALTER TABLE "billing_accounts" ADD COLUMN "stripe_customer_id" VARCHAR(255);

-- AlterTable
ALTER TABLE "billing_invoices" ADD COLUMN "paid_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "billing_payment_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "status" "BillingPaymentAttemptStatus" NOT NULL DEFAULT 'pending',
    "amount_micros" BIGINT NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'USD',
    "stripe_checkout_session_id" VARCHAR(255),
    "stripe_payment_intent_id" VARCHAR(255),
    "failure_code" VARCHAR(80),
    "failure_message" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "succeeded_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,

    CONSTRAINT "billing_payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stripe_event_id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(120) NOT NULL,
    "status" "StripeWebhookEventStatus" NOT NULL,
    "object_id" VARCHAR(255),
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_stripe_customer_id_key" ON "billing_accounts"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payment_attempts_stripe_checkout_session_id_key" ON "billing_payment_attempts"("stripe_checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payment_attempts_stripe_payment_intent_id_key" ON "billing_payment_attempts"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "billing_payment_attempts_invoice_id_status_idx" ON "billing_payment_attempts"("invoice_id", "status");

-- CreateIndex
CREATE INDEX "billing_payment_attempts_invoice_id_created_at_idx" ON "billing_payment_attempts"("invoice_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_webhook_events_stripe_event_id_key" ON "stripe_webhook_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_type_received_at_idx" ON "stripe_webhook_events"("type", "received_at");

-- AddForeignKey
ALTER TABLE "billing_payment_attempts" ADD CONSTRAINT "billing_payment_attempts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
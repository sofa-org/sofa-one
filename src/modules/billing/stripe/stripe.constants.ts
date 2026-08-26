import * as Stripe from 'stripe';

/** DI token for the configured Stripe client (null when Stripe is not configured). */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * Pinned Stripe API version (approved for Phase 3A). The SDK types only
 * reflect the latest API version, so the literal is asserted; the version is
 * sent as the `Stripe-Version` header on every request.
 */
export const STRIPE_API_VERSION = '2025-03-31.basil' as Stripe.LatestApiVersion;

/**
 * A pending Checkout session is reused while it is younger than this TTL.
 * Stripe Checkout sessions expire 24 hours after creation by default, so the
 * TTL matches the default session lifetime.
 */
export const PENDING_SESSION_REUSE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Stripe events the webhook service understands and processes. Any other
 * event type is signature-verified, recorded as `ignored`, and answered 2xx.
 */
export const STRIPE_WEBHOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
]);

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
 *
 * The subscription-renewal events (customer.subscription.* and invoice.*)
 * drive automatic renewal. Unmatched renewal events are `deferred` (bounded
 * retry), never silently ignored; they may only settle a local invoice whose
 * total exactly equals the fixed recurring charge for the matching
 * subscription/customer/currency.
 */
export const STRIPE_WEBHOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
]);

/**
 * Renewal-relevant events whose unmatched local invoice must be deferred and
 * retried (bounded) rather than silently ignored, because a renewal invoice may
 * not exist locally yet when the webhook arrives out of order.
 */
export const STRIPE_RENEWAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** Max times a deferred renewal event is retried before manual review. */
export const STRIPE_DEFERRED_MAX_RETRIES = 5;

/** Base backoff for deferred renewal retries (capped, bounded). */
export const STRIPE_DEFERRED_BACKOFF_MS = 5 * 60 * 1000;

/** A renewal attempt's `stripeChargeKind` for the fixed plan fee rail. */
export const STRIPE_CHARGE_KIND_FIXED_FEE = 'fixed_fee';

/**
 * A one-time Checkout attempt's `stripeChargeKind` for the full-invoice rail.
 * Pending attempts are only reusable by the same charge kind, so a one-time
 * (full-invoice) pending attempt is never reused by a subscription checkout
 * and vice versa.
 */
export const STRIPE_CHARGE_KIND_FULL = 'full';

/**
 * Stripe renewal materialization may only bind a fixed-fee recurring attempt to
 * an invoice whose total equals the fixed plan fee (no dynamic overage). Any
 * other shape is deferred/reviewable — never fabricated or falsely settled.
 */
export const STRIPE_RENEWAL_MIN_CENTS = 100;

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
  'payment_intent.canceled',
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

/**
 * BILL-014: max times a post-paid sibling Checkout Session expire is retried
 * before operator review. Provider calls stay outside DB locks.
 */
export const STRIPE_SESSION_CLEANUP_MAX_RETRIES = 5;

/** BILL-014: lease window while a worker owns a session-cleanup attempt. */
export const STRIPE_SESSION_CLEANUP_LEASE_MS = 2 * 60 * 1000;

/** BILL-014: base backoff for retryable session-cleanup provider failures. */
export const STRIPE_SESSION_CLEANUP_BACKOFF_MS = 60 * 1000;

/** BILL-014 cleanup status vocabulary (persisted on the payment attempt). */
export const SESSION_CLEANUP_STATUS_PENDING = 'pending';
export const SESSION_CLEANUP_STATUS_IN_FLIGHT = 'in_flight';
export const SESSION_CLEANUP_STATUS_COMPLETED = 'completed';
export const SESSION_CLEANUP_STATUS_NEEDS_REVIEW = 'needs_review';

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
 * A worker-created automatic overage attempt's `stripeChargeKind`. It is
 * created only after the renewal invoice has been finalized AND a succeeded
 * fixed-fee attempt has already been allocated against it AND the remainder
 * (`totalMicros - allocatedMicros`) is positive. The amount is the persisted
 * remainder snapshot; a PaymentIntent for this kind is charged off-session
 * against the customer's default payment method with a stable idempotency key,
 * and may never be created while another active full/overage payment attempt
 * exists or the invoice is already paid.
 */
export const STRIPE_CHARGE_KIND_OVERAGE = 'overage';

/**
 * Stripe renewal materialization may only bind a fixed-fee recurring attempt to
 * an invoice whose total equals the fixed plan fee (no dynamic overage). Any
 * other shape is deferred/reviewable — never fabricated or falsely settled.
 */
export const STRIPE_RENEWAL_MIN_CENTS = 100;

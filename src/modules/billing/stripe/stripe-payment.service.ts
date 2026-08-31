import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { formatUtcMonth } from '../billing.utils';
import { acquireBillingPeriodAdvisoryLock } from '../billing-period-lock';
import * as Stripe from 'stripe';
import {
  PENDING_SESSION_REUSE_TTL_MS,
  STRIPE_CHARGE_KIND_FIXED_FEE,
  STRIPE_CHARGE_KIND_FULL,
  STRIPE_CLIENT,
} from './stripe.constants';

/** 1 cent = 10,000 microdollars. Stripe amounts are integer cents. */
const MICROS_PER_CENT = 10_000n;

/** How long to wait for a concurrent request to persist its session id. */
const IN_FLIGHT_POLL_ATTEMPTS = 15;
const IN_FLIGHT_POLL_DELAY_MS = 100;

type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;

/** JSON-safe result of a checkout session creation. */
export interface CheckoutSessionResult {
  invoiceId: string;
  sessionId: string;
  checkoutUrl: string;
}

export type CheckoutRecoveryResult = { attempted: number; recovered: number; needsReview: number };

/**
 * Server-side Stripe Checkout for finalized invoices (Phase 3A).
 *
 * Amounts, currency, user, and invoice association are always read from the
 * database — never from the client. Only `finalized`, unpaid, positive,
 * USD, cent-aligned invoices are payable; anything else fails closed 4xx.
 * The success/cancel URLs come from server configuration only.
 *
 * Concurrency: a partial unique index on
 * `billing_payment_attempts(invoice_id, method) WHERE status = 'pending'`
 * guarantees at most one visible pending Stripe attempt per invoice (USDC
 * pending attempts coexist on the same invoice). A repeated request reuses the
 * valid pending Checkout session; a concurrent request that loses the insert
 * race waits briefly for the winner's session id and reuses it.
 */
@Injectable()
export class StripePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
  ) {}

  /** Bounded worker recovery; provider calls are deliberately outside DB transactions. */
  async recoverPendingCheckouts(workerId: string, limit = 50): Promise<CheckoutRecoveryResult> {
    if (!this.stripe) return { attempted: 0, recovered: 0, needsReview: 0 };
    // These recovery lease columns are present in the deployed billing schema;
    // the checked-in generated client may lag migrations in development.
    const attempts = this.prisma.billingPaymentAttempt as any;
    const rows = await attempts.findMany({
      where: {
        method: 'stripe',
        status: 'pending',
        stripeChargeKind: { in: [STRIPE_CHARGE_KIND_FULL, STRIPE_CHARGE_KIND_FIXED_FEE] },
        AND: [
          { OR: [{ stripeInvoiceId: null }, { stripeCheckoutSessionId: { not: null } }] },
          { OR: [{ checkoutNextRetryAt: null }, { checkoutNextRetryAt: { lte: new Date() } }] },
        ],
      },
      orderBy: [{ checkoutNextRetryAt: 'asc' }, { createdAt: 'asc' }], take: limit,
      include: { invoice: { include: { billingAccount: true } } },
    });
    let recovered = 0; let needsReview = 0;
    for (const row of rows) {
      const lease = await attempts.updateMany({
        where: { id: row.id, status: 'pending', OR: [{ checkoutRetryLeaseExpiresAt: null }, { checkoutRetryLeaseExpiresAt: { lt: new Date() } }] },
        data: { checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000), checkoutRetryCount: { increment: 1 } },
      });
      if (lease.count !== 1) continue;
      try {
        if (row.stripeCheckoutSessionId) {
          const session = await this.stripe.checkout.sessions.retrieve(row.stripeCheckoutSessionId, { expand: ['subscription'] });
          const url = typeof session.url === 'string' ? session.url : row.checkoutUrl;
          const paymentIntentId = providerObjectId(session.payment_intent, 'payment_intent');
          const subscriptionId = providerObjectId(session.subscription, 'subscription');
          if (!url || !this.isRecoveredSessionCompatible(row, session, paymentIntentId, subscriptionId)) throw new ConflictException('Stripe checkout identity could not be proven');
          await this.persistRecoveredCheckout(row, url, paymentIntentId, subscriptionId, workerId);
        } else {
          // Renewal attempts are mapped to Stripe invoices, not new Checkout
          // sessions. A missing session on such an attempt is out-of-order or
          // incomplete provider state and must remain review/retry work.
          if (row.stripeInvoiceId) {
            throw new ConflictException('Renewal attempt cannot create a new Checkout session');
          }
          await this.createCheckoutForExistingAttempt(row, workerId);
        }
        await attempts.updateMany({ where: { id: row.id, status: 'pending', checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: { gt: new Date() } }, data: { checkoutNextRetryAt: null, checkoutRetryOwnerId: null, checkoutRetryLeaseExpiresAt: null } });
        recovered++;
      } catch {
        const exhausted = row.checkoutRetryCount + 1 >= 5;
        await attempts.updateMany({ where: { id: row.id, status: 'pending', checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: { gt: new Date() } }, data: exhausted ? { status: 'needs_review', reviewReason: 'checkout_recovery_exhausted', checkoutRetryOwnerId: null, checkoutRetryLeaseExpiresAt: null, checkoutNextRetryAt: null } : { checkoutNextRetryAt: new Date(Date.now() + Math.min(60 * 60 * 1000, 2 ** row.checkoutRetryCount * 60 * 1000)), checkoutRetryOwnerId: null, checkoutRetryLeaseExpiresAt: null } });
        if (exhausted) needsReview++;
      }
    }
    return { attempted: rows.length, recovered, needsReview };
  }

  private async createCheckoutForExistingAttempt(row: PaymentAttemptRow & { invoice: any }, workerId: string): Promise<void> {
    const fixed = row.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE;
    const account = row.invoice.billingAccount;
    const customer = await this.ensureStripeCustomer(this.stripe!, account, account.userId);
    const period = formatUtcMonth(row.invoice.periodStart);
    const session = await this.stripe!.checkout.sessions.create(
      fixed ? {
        customer, mode: 'subscription',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', recurring: { interval: 'month' }, unit_amount: Number(row.amountMicros / MICROS_PER_CENT), product_data: { name: 'SOFA ONE subscription' } } }],
        subscription_data: { billing_cycle_anchor: Math.floor(row.invoice.periodStart.getTime() / 1000), proration_behavior: 'none', metadata: { userId: account.userId, billingAccountId: account.id, invoiceId: row.invoiceId, attemptId: row.id, planVersionId: row.invoice.planVersionId } },
        success_url: this.config.get<string>('stripe.successUrl')!, cancel_url: this.config.get<string>('stripe.cancelUrl')!, metadata: { invoiceId: row.invoiceId, attemptId: row.id, period, planVersionId: row.invoice.planVersionId }, client_reference_id: row.invoiceId,
      } : {
        customer, mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Number(row.amountMicros / MICROS_PER_CENT), product_data: { name: `SOFA ONE — ${period} invoice` } } }],
        success_url: this.config.get<string>('stripe.successUrl')!, cancel_url: this.config.get<string>('stripe.cancelUrl')!, metadata: { invoiceId: row.invoiceId, attemptId: row.id, period }, payment_intent_data: { metadata: { invoiceId: row.invoiceId, attemptId: row.id } }, client_reference_id: row.invoiceId,
      },
      { idempotencyKey: `${fixed ? 'subscription-' : ''}checkout:${row.id}` },
    );
    const paymentIntentId = providerObjectId(session.payment_intent, 'payment_intent');
    const subscriptionId = providerObjectId(session.subscription, 'subscription');
    if (!session.url || !providerObjectId(session.id, 'checkout_session') || (!fixed && !paymentIntentId)) throw new ConflictException('Stripe checkout returned incomplete identity');
    await this.persistRecoveredCheckout(row, session.url, paymentIntentId, subscriptionId, workerId);
  }

  private async persistRecoveredCheckout(
    row: PaymentAttemptRow & { invoice: { periodStart: Date; billingAccountId: string } },
    checkoutUrl: string,
    paymentIntentId: string | null,
    subscriptionId: string | null,
    workerId: string,
  ): Promise<void> {
    if (row.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      await this.persistSubscriptionCheckout(row.invoice.billingAccountId, row.invoice.periodStart, row.id,
        row.stripeCheckoutSessionId!, checkoutUrl, paymentIntentId, subscriptionId, workerId);
    } else {
      await this.persistOneTimeCheckout(row.invoice.billingAccountId, row.invoice.periodStart, row.id,
        row.stripeCheckoutSessionId!, checkoutUrl, paymentIntentId, workerId);
    }
  }

  private isRecoveredSessionCompatible(
    row: PaymentAttemptRow & { invoice: any },
    session: Stripe.Checkout.Session,
    paymentIntentId: string | null,
    subscriptionId: string | null,
  ): boolean {
    const invoice = row.invoice;
    const metadata = session.metadata;
    if (session.id !== row.stripeCheckoutSessionId || !metadata) return false;
    if (metadata.invoiceId !== row.invoiceId || metadata.attemptId !== row.id ||
      metadata.period !== formatUtcMonth(invoice.periodStart) ||
      session.client_reference_id !== row.invoiceId) return false;
    if (typeof session.customer !== 'string' || session.customer !== invoice.billingAccount?.stripeCustomerId) return false;
    if (typeof session.currency !== 'string' || session.currency.toLowerCase() !== row.currency.toLowerCase()) return false;
    if (session.amount_total !== Number(row.amountMicros / MICROS_PER_CENT)) return false;
    if (row.stripePaymentIntentId !== null && row.stripePaymentIntentId !== paymentIntentId) return false;
    if (row.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      if (session.mode !== 'subscription' || !subscriptionId) return false;
      if (row.stripeSubscriptionId !== null && row.stripeSubscriptionId !== subscriptionId) return false;
      if (metadata.planVersionId !== invoice.planVersionId) return false;
      const sub = typeof session.subscription === 'object' && session.subscription !== null ? session.subscription as any : null;
      if (!sub || typeof sub.current_period_start !== 'number' || typeof sub.current_period_end !== 'number') return false;
      if (sub.current_period_start * 1000 !== invoice.periodStart.getTime() || sub.current_period_end * 1000 !== invoice.periodEnd.getTime()) return false;
    } else if (session.mode !== 'payment' || subscriptionId !== null || !paymentIntentId) return false;
    return true;
  }

  /**
   * Explicit subscription Checkout (Phase 1 worker foundation). Unlike the
   * one-time `createCheckoutSession` (which keeps its `mode: 'payment'`
   * semantics), this opens a `mode: 'subscription'` Checkout that only charges
   * the fixed plan fee (monthly recurring). Dynamic API/wallet/outbound
   * overage is NOT part of the recurring price and is never settled by it: the
   * local renewal invoice keeps its full total, and settlement requires an
   * exact amount/currency match, so a smaller recurring charge can never mark
   * a dynamic invoice as paid.
   *
   * Fail closed: Enterprise/custom plans (no finite fixed fee), non-finalized,
   * paid, non-USD, zero/negative or non-cent-aligned invoices are rejected.
   * The account's Stripe subscription mirror is only written once Stripe
   * returns a subscription id; webhooks keep it current.
   */
  async createSubscriptionCheckout(
    userId: string,
    invoiceId: string,
    planVersionId: string,
  ): Promise<CheckoutSessionResult> {
    const stripe = this.stripe;
    if (!stripe) {
      throw new ServiceUnavailableException('Stripe billing is not configured');
    }
    const successUrl = this.config.get<string>('stripe.successUrl');
    const cancelUrl = this.config.get<string>('stripe.cancelUrl');
    if (!successUrl || !cancelUrl) {
      throw new ServiceUnavailableException('Stripe billing is not configured');
    }

    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Invoice not found');

    const invoice = await this.prisma.billingInvoice.findFirst({
      where: { id: invoiceId, billingAccountId: account.id },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    this.assertCheckoutEligible(invoice);

    const planVersion = await this.prisma.billingPlanVersion.findUnique({
      where: { id: planVersionId },
    });
    if (!planVersion) {
      throw new NotFoundException('Plan version not found');
    }
    // Fail closed BEFORE any provider call or local renewal state: the selected
    // plan version must be EXACTLY the owned invoice's plan (never a
    // caller-selected different plan), and its fixed fee must equal the invoice
    // total so the recurring charge can settle that invoice exactly. A
    // dynamic/overage invoice (total > fixed fee) is rejected rather than
    // creating a smaller recurring charge attached to it.
    if (planVersion.id !== invoice.planVersionId) {
      throw new ConflictException(
        'Subscription checkout requires the selected plan version to match the invoice plan',
      );
    }
    if (planVersion.monthlyFeeMicros === null || planVersion.monthlyFeeMicros !== invoice.totalMicros) {
      throw new ConflictException(
        'Subscription checkout requires a fixed-fee invoice with no dynamic overage',
      );
    }
    // The fixed fee must be finite, positive, and cent-aligned.
    if (
      planVersion.monthlyFeeMicros === null ||
      planVersion.monthlyFeeMicros <= 0n ||
      planVersion.monthlyFeeMicros % MICROS_PER_CENT !== 0n
    ) {
      throw new ConflictException(
        'Subscription checkout requires a finite, positive, cent-aligned fixed plan fee',
      );
    }
    const fixedCents = this.microsToCents(planVersion.monthlyFeeMicros);

    // Reuse a valid pending subscription session (local lookup, no remote
    // fetch). Only a fixed-fee pending attempt with a matching amount is
    // reusable; a one-time (full-invoice) pending attempt is never reused for
    // a subscription.
    const reusable = await this.findReusablePendingAttempt(
      invoice.id,
      STRIPE_CHARGE_KIND_FIXED_FEE,
      planVersion.monthlyFeeMicros,
      invoice.currency,
    );
    if (
      reusable?.stripeCheckoutSessionId &&
      reusable.checkoutUrl &&
      reusable.amountMicros === planVersion.monthlyFeeMicros
    ) {
      return this.toResult(reusable);
    }

    const attempt = await this.createPendingAttemptOrReuseInFlight(invoice, {
      amountMicros: planVersion.monthlyFeeMicros,
      stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE,
    });
    if (attempt.stripeCheckoutSessionId && attempt.checkoutUrl) {
      return this.toResult(attempt);
    }

    let providerIdentity: { sessionId: string; checkoutUrl: string; paymentIntentId: string | null; subscriptionId: string | null } | null = null;
    try {
      const customerId = await this.ensureStripeCustomer(stripe, account, userId);
      const period = formatUtcMonth(invoice.periodStart);

      const session = await stripe.checkout.sessions.create(
        {
          customer: customerId,
          mode: 'subscription',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                recurring: { interval: 'month' },
                unit_amount: fixedCents,
                product_data: {
                  name: `SOFA ONE — ${planVersion.name} subscription`,
                  metadata: { planVersionId, planCode: planVersion.code },
                },
              },
            },
          ],
          subscription_data: {
            // The local invoice is a UTC-month contract. Stripe must use this
            // exact boundary; if Stripe rejects an elapsed/invalid anchor,
            // creation fails closed rather than inventing a provider period.
            billing_cycle_anchor: Math.floor(invoice.periodStart.getTime() / 1000),
            proration_behavior: 'none',
            metadata: {
              userId,
              billingAccountId: account.id,
              invoiceId: invoice.id,
              attemptId: attempt.id,
              planVersionId,
            },
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: {
            invoiceId: invoice.id,
            attemptId: attempt.id,
            period,
            planVersionId,
          },
          client_reference_id: invoice.id,
        },
        { idempotencyKey: `subscription-checkout:${attempt.id}` },
      );

      const paymentIntentId = providerObjectId(session.payment_intent, 'payment_intent');
      const subscriptionId = providerObjectId(session.subscription, 'subscription');
      if (!providerObjectId(session.id, 'checkout_session') || !session.url) {
        throw new ServiceUnavailableException('Stripe subscription checkout returned incomplete identity');
      }
      providerIdentity = { sessionId: session.id, checkoutUrl: session.url, paymentIntentId, subscriptionId };

      const updated = await this.persistSubscriptionCheckout(
        account.id, invoice.periodStart, attempt.id, session.id, session.url,
        paymentIntentId, subscriptionId,
      );
      return this.toResult(updated);
    } catch (err) {
      if (providerIdentity || isAmbiguousCheckoutError(err)) {
        await this.markAttemptUnknown(attempt.id, providerIdentity);
      } else {
        await this.markAttemptFailed(attempt.id, err);
      }
      throw err;
    }
  }

  async createCheckoutSession(userId: string, invoiceId: string): Promise<CheckoutSessionResult> {
    const stripe = this.stripe;
    if (!stripe) {
      throw new ServiceUnavailableException('Stripe billing is not configured');
    }
    const successUrl = this.config.get<string>('stripe.successUrl');
    const cancelUrl = this.config.get<string>('stripe.cancelUrl');
    if (!successUrl || !cancelUrl) {
      throw new ServiceUnavailableException('Stripe billing is not configured');
    }

    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Invoice not found');

    const invoice = await this.prisma.billingInvoice.findFirst({
      where: { id: invoiceId, billingAccountId: account.id },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    this.assertCheckoutEligible(invoice);

    // Reuse a valid pending Checkout session (local lookup, no remote fetch).
    // Only a full-invoice pending attempt is reusable for one-time checkout.
    const reusable = await this.findReusablePendingAttempt(
      invoice.id,
      STRIPE_CHARGE_KIND_FULL,
      invoice.totalMicros,
      invoice.currency,
    );
    if (reusable?.stripeCheckoutSessionId && reusable.checkoutUrl) {
      return this.toResult(reusable);
    }

    // Create the pending attempt row. The partial unique index makes this
    // race-safe: a concurrent request that already inserted a pending attempt
    // is detected via P2002 and its session is reused instead.
    const attempt = await this.createPendingAttemptOrReuseInFlight(invoice, {
      stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
    });
    if (attempt.stripeCheckoutSessionId && attempt.checkoutUrl) {
      return this.toResult(attempt);
    }

    let providerIdentity: { sessionId: string; checkoutUrl: string; paymentIntentId: string | null; subscriptionId: string | null } | null = null;
    try {
      const customerId = await this.ensureStripeCustomer(stripe, account, userId);
      const cents = this.microsToCents(invoice.totalMicros);
      const period = formatUtcMonth(invoice.periodStart);

      const session = await stripe.checkout.sessions.create(
        {
          customer: customerId,
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: cents,
                product_data: {
                  name: `SOFA ONE — ${period} invoice`,
                },
              },
            },
          ],
          success_url: successUrl,
          cancel_url: cancelUrl,
          // Local identifiers for out-of-order webhook correlation. The attempt
          // id is the authoritative local key; the invoice id is a fallback.
          metadata: {
            invoiceId: invoice.id,
            attemptId: attempt.id,
            period,
          },
          payment_intent_data: {
            metadata: {
              invoiceId: invoice.id,
              attemptId: attempt.id,
            },
          },
          client_reference_id: invoice.id,
        },
        // Deterministic idempotency key derived from the local attempt: a
        // Stripe timeout/retry of this exact call returns the same Session
        // instead of creating a duplicate one. Each attempt generation gets a
        // fresh key, so a later retry after a real failure creates a new
        // Session.
        { idempotencyKey: `checkout:${attempt.id}` },
      );

      const paymentIntentId = providerObjectId(session.payment_intent, 'payment_intent');
      if (!session.url) throw new ServiceUnavailableException('Stripe checkout session could not be created');
      providerIdentity = { sessionId: session.id, checkoutUrl: session.url, paymentIntentId, subscriptionId: null };

      const updated = await this.persistOneTimeCheckout(
        account.id, invoice.periodStart, attempt.id, session.id, session.url ?? null, paymentIntentId,
      );

      if (!updated.stripeCheckoutSessionId || !updated.checkoutUrl) {
        // Hosted Checkout always returns a URL; treat a missing one as a
        // server-side failure rather than returning a broken link.
        throw new ServiceUnavailableException('Stripe checkout session could not be created');
      }
      return this.toResult(updated);
    } catch (err) {
      // A Stripe/DB failure must not leave a pending attempt that blocks
      // future retries (the partial pending index). Mark it failed safely.
      if (providerIdentity || isAmbiguousCheckoutError(err)) {
        await this.markAttemptUnknown(attempt.id, providerIdentity);
      } else {
        await this.markAttemptFailed(attempt.id, err);
      }
      throw err;
    }
  }

  // ── Eligibility ────────────────────────────────────────────────────────────

  private async persistOneTimeCheckout(
    accountId: string,
    periodStart: Date,
    attemptId: string,
    sessionId: string,
    checkoutUrl: string | null,
    paymentIntentId: string | null,
    workerId?: string,
  ): Promise<any> {
    if (!checkoutUrl) throw new ServiceUnavailableException('Stripe checkout session could not be created');
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, accountId, periodStart);
      const attempt = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt || attempt.invoiceId === null) throw new ConflictException('Stripe checkout attempt is unavailable');
      const claimed = await tx.billingPaymentAttempt.updateMany({
        where: {
          id: attemptId,
          status: 'pending',
          ...(workerId ? { checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: { gt: new Date() } } : {}),
          AND: [
            { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: sessionId }] },
            { OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: paymentIntentId }] },
            { OR: [{ checkoutUrl: null }, { checkoutUrl }] },
          ],
        } as any,
        data: { stripeCheckoutSessionId: sessionId, stripePaymentIntentId: paymentIntentId, checkoutUrl },
      });
      if (claimed.count !== 1) {
        const current = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
        if (!current || current.stripeCheckoutSessionId !== sessionId || current.checkoutUrl !== checkoutUrl || current.stripePaymentIntentId !== paymentIntentId) {
          throw new ConflictException('Stripe checkout identity was bound by a concurrent operation');
        }
      }
      const result = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!result || !result.stripeCheckoutSessionId || !result.checkoutUrl) throw new ServiceUnavailableException('Stripe checkout session could not be created');
      return result;
    });
  }

  private async persistSubscriptionCheckout(
    accountId: string,
    periodStart: Date,
    attemptId: string,
    sessionId: string,
    checkoutUrl: string | null,
    paymentIntentId: string | null,
    subscriptionId: string | null,
    workerId?: string,
  ): Promise<any> {
    if (!checkoutUrl) throw new ServiceUnavailableException('Stripe subscription checkout returned incomplete identity');
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, accountId, periodStart);
      const attempt = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      const account = await tx.billingAccount.findUnique({ where: { id: accountId } });
      if (!attempt || !account) throw new ConflictException('Stripe subscription checkout state is unavailable');
      const claimed = await tx.billingPaymentAttempt.updateMany({
        where: { id: attemptId, status: 'pending', ...(workerId ? { checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: { gt: new Date() } } : {}), AND: [
          { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: sessionId }] },
          ...(paymentIntentId ? [{ OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: paymentIntentId }] }] : []),
          ...(subscriptionId ? [{ OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: subscriptionId }] }] : []),
          { OR: [{ checkoutUrl: null }, { checkoutUrl }] },
        ] } as any,
        data: { stripeCheckoutSessionId: sessionId, ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}), ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}), checkoutUrl },
      });
      if (claimed.count !== 1) throw new ConflictException('Stripe checkout identity was bound by a concurrent operation');
      if (subscriptionId) {
        if (account.stripeSubscriptionId && account.stripeSubscriptionId !== subscriptionId) {
          throw new ConflictException('An active subscription already exists for this account');
        }
        if (!account.stripeSubscriptionId) {
          const mirrored = await tx.billingAccount.updateMany({
            where: { id: accountId, stripeSubscriptionId: null },
            data: { stripeSubscriptionId: subscriptionId, stripeSubscriptionStatus: 'incomplete' },
          });
          if (mirrored.count !== 1) throw new ConflictException('An active subscription already exists for this account');
        }
      }
      const result = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!result || !result.checkoutUrl) throw new ServiceUnavailableException('Stripe subscription checkout could not be created');
      return result;
    });
  }

  /**
   * Only `finalized` (amount-frozen), unpaid, positive, USD, cent-aligned
   * invoices are payable. `open`/`void`/`needs_review`/zero-amount invoices
   * and amounts that cannot be represented losslessly in Stripe cents fail
   * closed with a 4xx.
   */
  private assertCheckoutEligible(
    invoice: Prisma.BillingInvoiceGetPayload<Record<string, never>>,
  ): void {
    if (invoice.status !== 'finalized') {
      throw new ConflictException('Only finalized invoices can be paid');
    }
    if (invoice.paidAt) {
      throw new ConflictException('Invoice is already paid');
    }
    if (invoice.currency !== 'USD') {
      throw new BadRequestException('Only USD invoices can be paid');
    }
    if (invoice.totalMicros <= 0n) {
      throw new BadRequestException('Invoice amount must be positive');
    }
    if (invoice.totalMicros % MICROS_PER_CENT !== 0n) {
      throw new BadRequestException('Invoice amount cannot be represented in cents');
    }
  }

  /** Lossless microdollar → Stripe cent conversion (1 cent = 10,000 micros). */
  private microsToCents(micros: bigint): number {
    if (micros <= 0n || micros % MICROS_PER_CENT !== 0n) {
      throw new BadRequestException('Invoice amount cannot be represented in cents');
    }
    const cents = micros / MICROS_PER_CENT;
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException('Invoice amount is too large');
    }
    return Number(cents);
  }

  // ── Attempt lifecycle ──────────────────────────────────────────────────────

  /**
   * A pending Stripe attempt with a persisted session id younger than the TTL,
   * matching the requested charge kind (full-invoice for one-time checkout,
   * fixed_fee for subscription). Scoped to `method = stripe` so a USDC pending
   * attempt is never reused as a Stripe checkout session, and a charge-kind
   * mismatch (e.g. reusing a one-time pending attempt for a subscription) is
   * never reused.
   */
  private async findReusablePendingAttempt(
    invoiceId: string,
    chargeKind: string,
    amountMicros: bigint,
    currency: string,
  ): Promise<PaymentAttemptRow | null> {
    const cutoff = new Date(Date.now() - PENDING_SESSION_REUSE_TTL_MS);
    return this.prisma.billingPaymentAttempt.findFirst({
      where: {
        invoiceId,
        method: 'stripe',
        status: 'pending',
        stripeChargeKind: chargeKind,
        amountMicros,
        currency,
        stripeCheckoutSessionId: { not: null },
        checkoutUrl: { not: null },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Inserts a pending Stripe attempt for the invoice. On a unique-constraint
   * race (partial pending index per invoice + method) the existing pending
   * Stripe attempt is re-fetched: if it already carries a session id AND
   * matches the requested charge kind it is reused; if the winner released the
   * slot (failed) a fresh attempt is created; a clearly stale attempt (older
   * than the reuse TTL) is released and replaced. A young pending attempt that
   * is still being created by a legitimate slow Stripe request is never
   * disturbed — the caller gets a retryable conflict instead of a second
   * pending attempt/session. When `rejectKindMismatch` is set (subscription
   * checkout), a pending attempt of a different charge kind (e.g. a one-time
   * full-invoice pending attempt) is never reused and never released — it is a
   * hard conflict so a subscription charge can never ride on a one-time
   * attempt. A USDC pending attempt never blocks or satisfies a Stripe request
   * (method-scoped lookups).
   */
  private async createPendingAttemptOrReuseInFlight(
    invoice: Prisma.BillingInvoiceGetPayload<Record<string, never>>,
    overrides: {
      amountMicros?: bigint;
      stripeChargeKind?: string;
    } = {},
  ): Promise<PaymentAttemptRow> {
    const attemptData = {
      invoiceId: invoice.id,
      method: 'stripe' as const,
      status: 'pending' as const,
      amountMicros: overrides.amountMicros ?? invoice.totalMicros,
      currency: invoice.currency,
      ...(overrides.stripeChargeKind ? { stripeChargeKind: overrides.stripeChargeKind } : {}),
    };
    const requestedKind = overrides.stripeChargeKind ?? null;
    const isKindCompatible = (row: PaymentAttemptRow): boolean =>
      (requestedKind === null || row.stripeChargeKind === requestedKind) &&
      row.amountMicros === attemptData.amountMicros &&
      row.currency === attemptData.currency;
    try {
      return await this.prisma.billingPaymentAttempt.create({
        data: attemptData,
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    // A concurrent request holds the single pending Stripe slot. Wait briefly
    // for its session id to appear before deciding how to proceed.
    for (let attempt = 0; attempt < IN_FLIGHT_POLL_ATTEMPTS; attempt++) {
      const existing = await this.prisma.billingPaymentAttempt.findFirst({
        where: { invoiceId: invoice.id, method: 'stripe', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) {
        // The winner released the slot (its Stripe call failed) — create fresh.
        return this.prisma.billingPaymentAttempt.create({ data: attemptData });
      }
      if (isStalePendingAttempt(existing)) {
        break; // clearly stale — release below (a stale slot is never reused)
      }
      if (!isKindCompatible(existing)) {
        // A different charge kind occupies the pending slot. Rejecting is the
        // only safe action: a one-time pending attempt must never be reused or
        // released by a subscription checkout.
        throw new ConflictException(
          'A pending payment of a different type already exists for this invoice',
        );
      }
      if (existing.stripeCheckoutSessionId && existing.checkoutUrl) {
        return existing; // winner persisted its session — reuse it
      }
      if (attempt < IN_FLIGHT_POLL_ATTEMPTS - 1) {
        await sleep(IN_FLIGHT_POLL_DELAY_MS);
      }
    }

    // Re-check after the poll: the winner may have just persisted its session.
    const pending = await this.prisma.billingPaymentAttempt.findFirst({
      where: { invoiceId: invoice.id, method: 'stripe', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) {
      if (isStalePendingAttempt(pending)) {
        const released = await this.prisma.billingPaymentAttempt.updateMany({
          where: {
            id: pending.id,
            method: 'stripe',
            status: 'pending',
            amountMicros: attemptData.amountMicros,
            currency: attemptData.currency,
            stripeCheckoutSessionId: null,
            stripePaymentIntentId: null,
            stripeInvoiceId: null,
            stripeSubscriptionId: null,
            checkoutUrl: null,
            ...(attemptData.stripeChargeKind
              ? { stripeChargeKind: attemptData.stripeChargeKind }
              : {}),
            createdAt: pending.createdAt,
          },
          data: {
            status: 'failed',
            failedAt: new Date(),
            failureCode: 'checkout_session_creation_timeout',
            failureMessage: 'Checkout session creation did not complete; please retry',
          },
        });
        if (released.count === 0) {
          throw new ConflictException('The pending payment changed while it was being released');
        }
        return this.prisma.billingPaymentAttempt.create({ data: attemptData });
      }
      if (!isKindCompatible(pending)) {
        throw new ConflictException(
          'A pending payment of a different type already exists for this invoice',
        );
      }
      if (pending.stripeCheckoutSessionId && pending.checkoutUrl) {
        return pending;
      }
      if ((pending as any).failureCode === 'local_persistence_uncertain') {
        // The provider call may have created a session while the local write
        // failed. Reuse this exact attempt so the deterministic idempotency key
        // is retained; never create a second local attempt.
        return pending;
      }
    }

    // Still being created by a legitimate slow request — never manufacture a
    // second pending attempt/session.
    throw new ConflictException(
      'A checkout session is already being created for this invoice; please retry',
    );
  }

  /**
   * Marks an attempt failed with a safe, truncated failure code/message. The
   * update is a pending-only compare-and-set: only a `pending` attempt may
   * transition to `failed`, so a Stripe call failure racing a webhook-confirmed
   * success (or any other non-pending state) can never regress the attempt.
   * Never touches `paidAt`.
   */
  private async markAttemptUnknown(
    attemptId: string,
    identity: { sessionId: string; checkoutUrl: string; paymentIntentId: string | null; subscriptionId: string | null } | null,
  ): Promise<void> {
    try {
      await (this.prisma.billingPaymentAttempt as any).updateMany({
        where: { id: attemptId, status: 'pending' },
        data: {
          status: 'pending',
          ...(identity ? {
            stripeCheckoutSessionId: identity.sessionId,
            checkoutUrl: identity.checkoutUrl,
            ...(identity.paymentIntentId ? { stripePaymentIntentId: identity.paymentIntentId } : {}),
            ...(identity.subscriptionId ? { stripeSubscriptionId: identity.subscriptionId } : {}),
          } : {}),
          failedAt: null,
          failureCode: 'local_persistence_uncertain',
          failureMessage: 'Provider identity exists but local persistence was uncertain',
          checkoutNextRetryAt: new Date(Date.now() + 60_000),
        },
      });
    } catch {
      // The original persistence error remains the caller-visible failure. A
      // later webhook/recovery job must prove the provider identity before any
      // local attempt is rebound.
    }
  }

  private async markAttemptFailed(attemptId: string, err: unknown): Promise<void> {
    const { code, message } = extractSafeFailure(err);
    try {
      await this.prisma.billingPaymentAttempt.updateMany({
        where: { id: attemptId, status: 'pending' },
        data: {
          status: 'failed',
          failedAt: new Date(),
          failureCode: code,
          failureMessage: message,
        },
      });
    } catch {
      // Best-effort audit only; the original error is what the caller sees.
    }
  }

  // ── Stripe customer ────────────────────────────────────────────────────────

  /**
   * Returns the account's Stripe Customer id, creating the Customer once with
   * a deterministic idempotency key (concurrent requests get the same
   * Customer) and persisting the id safely. The unique `stripeCustomerId`
   * column absorbs the concurrent-persist race.
   */
  private async ensureStripeCustomer(
    stripe: Stripe,
    account: Prisma.BillingAccountGetPayload<Record<string, never>>,
    userId: string,
  ): Promise<string> {
    if (account.stripeCustomerId) return account.stripeCustomerId;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const customer = await stripe.customers.create(
      {
        email: user?.email ?? undefined,
        metadata: {
          userId,
          billingAccountId: account.id,
        },
      },
      { idempotencyKey: `customer:${account.id}` },
    );

    try {
      const claimed = await this.prisma.billingAccount.updateMany({
        where: { id: account.id, stripeCustomerId: null },
        data: { stripeCustomerId: customer.id },
      });
      if (claimed.count === 0) {
        const current = await this.prisma.billingAccount.findUnique({ where: { id: account.id } });
        if (current?.stripeCustomerId === customer.id) return customer.id;
        throw new ConflictException('An active Stripe customer already exists for this account');
      }
      return customer.id;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const again = await this.prisma.billingAccount.findUnique({
        where: { id: account.id },
      });
      if (again?.stripeCustomerId) return again.stripeCustomerId;
      throw err;
    }
  }

  private toResult(attempt: PaymentAttemptRow): CheckoutSessionResult {
    if (!attempt.stripeCheckoutSessionId || !attempt.checkoutUrl) {
      throw new ServiceUnavailableException('Stripe checkout session could not be created');
    }
    return {
      invoiceId: attempt.invoiceId,
      sessionId: attempt.stripeCheckoutSessionId,
      checkoutUrl: attempt.checkoutUrl,
    };
  }
}

function isAmbiguousCheckoutError(error: unknown): boolean {
  const value = error as { code?: unknown; statusCode?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code.toLowerCase() : '';
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  const status = typeof value?.statusCode === 'number' ? value.statusCode : typeof value?.status === 'number' ? value.status : 0;
  return status >= 500 || code === 'etimedout' || code === 'econnreset' || code === 'econnaborted' ||
    code === 'timeout' || message.includes('timeout') || message.includes('timed out') ||
    message.includes('network') || message.includes('socket hang up');
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * A pending attempt is clearly stale when it is older than the reuse TTL
 * without ever persisting a session id — the creating request died or its
 * Stripe call failed without releasing the slot. Younger pending attempts are
 * treated as legitimately in-flight and are never disturbed.
 */
function isStalePendingAttempt(attempt: PaymentAttemptRow): boolean {
  return Date.now() - attempt.createdAt.getTime() > PENDING_SESSION_REUSE_TTL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts a safe, truncated failure code/message from a Stripe API error or
 * any other thrown value. Never includes secrets or full payloads.
 */
function extractSafeFailure(err: unknown): { code: string | null; message: string | null } {
  const raw = err as { code?: unknown; message?: unknown; type?: unknown };
  const code = typeof raw.code === 'string' && raw.code.length > 0 ? raw.code.slice(0, 80) : null;
  const message =
    typeof raw.message === 'string' && raw.message.length > 0 ? raw.message.slice(0, 500) : null;
  return { code, message };
}

function providerObjectId(value: unknown, expectedPrefix: string): string | null {
  if (value === null || value === undefined) return null;
  const id = typeof value === 'string' ? value :
    typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : null;
  const prefix = expectedPrefix === 'payment_intent' ? 'pi_' :
    expectedPrefix === 'subscription' ? 'sub_' :
      expectedPrefix === 'checkout_session' ? 'cs_' : null;
  if (typeof id === 'string' && id.length > 0 && (!prefix || id.startsWith(prefix))) return id;
  throw new ConflictException(`Malformed Stripe ${expectedPrefix} identity`);
}

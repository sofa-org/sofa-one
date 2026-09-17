import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { formatUtcMonth } from '../billing.utils';
import {
  acquireBillingAccountAdvisoryLock,
  acquireBillingPeriodAdvisoryLock,
} from '../billing-period-lock';
import { BillingPlanChangeService } from '../billing-plan-change.service';
import * as Stripe from 'stripe';
import {
  PENDING_SESSION_REUSE_TTL_MS,
  STRIPE_CHARGE_KIND_FIXED_FEE,
  STRIPE_CHARGE_KIND_FULL,
  STRIPE_CHARGE_KIND_OVERAGE,
  STRIPE_CLIENT,
} from './stripe.constants';

/** 1 cent = 10,000 microdollars. Stripe amounts are integer cents. */
const MICROS_PER_CENT = 10_000n;

/** How long to wait for a concurrent request to persist its session id. */
const IN_FLIGHT_POLL_ATTEMPTS = 15;
const IN_FLIGHT_POLL_DELAY_MS = 100;

/** Bounded retry budget for automatic overage charges (worker-driven). */
const OVERAGE_MAX_RETRIES = 3;
/** Backoff base for overage charge retries (exponential, capped). */
const OVERAGE_RETRY_BACKOFF_MS = 60_000;

type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;
type BillingInvoiceRow = Prisma.BillingInvoiceGetPayload<Record<string, never>>;
type Tx = Prisma.TransactionClient;

/** Minimal account/invoice facts the automatic overage charge path reads. */
type OverageAccount = { id: string; userId: string; stripeCustomerId: string | null };
type OverageInvoice = {
  id: string;
  periodStart: Date;
  totalMicros: bigint;
  allocatedMicros: bigint | null;
  status: string;
  currency: string;
  paidAt: Date | null;
  settlementAttemptId: string | null;
};

/** JSON-safe result of a checkout session creation. */
export interface CheckoutSessionResult {
  invoiceId: string;
  sessionId: string;
  checkoutUrl: string;
}

/**
 * Result of a worker's bounded Checkout-recovery pass.
 *
 * `retryable` counts the non-exhausted recovery failures THIS worker owns: a
 * catch on its own leased row whose retry reschedule was durably persisted
 * (`updateMany.count === 1`). The row remains pending/retryable and the tick
 * heartbeat must report failed. A lease/CAS miss, stale/ineligible row, or
 * another worker completing the attempt is benign and never counted.
 *
 * `needsReview` counts only the exhaustion transitions THIS worker owns
 * (status transition CAS count === 1); a concurrent CAS miss stays benign.
 */
export type CheckoutRecoveryResult = {
  attempted: number;
  recovered: number;
  needsReview: number;
  retryable: number;
};

/** Outcome of an automatic overage charge attempt. */
export type OverageChargeResult =
  | 'created' // PaymentIntent created/persisted; webhook will confirm
  | 'skipped' // not eligible right now (paid/no remainder/active attempt/no fixed-fee coverage)
  | 'pending' // provider identity uncertain; retried later via the retry lease
  | 'needs_review' // fail-closed (no default PM / requires_action / retries exhausted)
  | 'failed'; // definitive charge failure; retryable within the bounded budget

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
    @Optional() private readonly planChanges?: BillingPlanChangeService,
  ) {}

  /** Bounded worker recovery; provider calls are deliberately outside DB transactions. */
  async recoverPendingCheckouts(workerId: string, limit = 50): Promise<CheckoutRecoveryResult> {
    if (!this.stripe) return { attempted: 0, recovered: 0, needsReview: 0, retryable: 0 };
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
      orderBy: [{ checkoutNextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      include: { invoice: { include: { billingAccount: true } } },
    });
    let recovered = 0;
    let needsReview = 0;
    let retryable = 0;
    for (let row of rows) {
      const lease = await attempts.updateMany({
        where: {
          id: row.id,
          status: 'pending',
          OR: [
            { checkoutRetryLeaseExpiresAt: null },
            { checkoutRetryLeaseExpiresAt: { lt: new Date() } },
          ],
        },
        data: {
          checkoutRetryOwnerId: workerId,
          checkoutRetryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
          checkoutRetryCount: { increment: 1 },
        },
      });
      if (lease.count !== 1) continue;
      try {
        // The findMany snapshot can go stale between selection and lease
        // acquisition. Re-read the current attempt + invoice; fail closed before
        // any provider call unless it is still pending/owned by this lease and
        // the invoice is still payable/settlement-eligible.
        const fresh = await attempts.findUnique({
          where: { id: row.id },
          include: { invoice: { include: { billingAccount: true } } },
        });
        if (!fresh || !(await this.isRecoveryAttemptEligible(fresh, workerId))) {
          continue;
        }
        row = fresh;
        if (row.stripeCheckoutSessionId) {
          const session = await this.stripe.checkout.sessions.retrieve(
            row.stripeCheckoutSessionId,
            { expand: ['subscription'] },
          );
          const url = typeof session.url === 'string' ? session.url : row.checkoutUrl;
          const paymentIntentId = providerObjectId(session.payment_intent, 'payment_intent');
          const subscriptionId = providerObjectId(session.subscription, 'subscription');
          if (
            !url ||
            !this.isRecoveredSessionCompatible(row, session, paymentIntentId, subscriptionId)
          )
            throw new ConflictException('Stripe checkout identity could not be proven');
          await this.persistRecoveredCheckout(
            row,
            session.id,
            url,
            paymentIntentId,
            subscriptionId,
            workerId,
          );
        } else {
          // Renewal attempts are mapped to Stripe invoices, not new Checkout
          // sessions. A missing session on such an attempt is out-of-order or
          // incomplete provider state and must remain review/retry work.
          if (row.stripeInvoiceId) {
            throw new ConflictException('Renewal attempt cannot create a new Checkout session');
          }
          await this.createCheckoutForExistingAttempt(row, workerId);
        }
        await attempts.updateMany({
          where: {
            id: row.id,
            status: 'pending',
            checkoutRetryOwnerId: workerId,
            checkoutRetryLeaseExpiresAt: { gt: new Date() },
          },
          data: {
            checkoutNextRetryAt: null,
            checkoutRetryOwnerId: null,
            checkoutRetryLeaseExpiresAt: null,
          },
        });
        recovered++;
      } catch {
        const exhausted = row.checkoutRetryCount + 1 >= 5;
        const rescheduled = await attempts.updateMany({
          where: {
            id: row.id,
            status: 'pending',
            checkoutRetryOwnerId: workerId,
            checkoutRetryLeaseExpiresAt: { gt: new Date() },
          },
          data: exhausted
            ? {
                status: 'needs_review',
                reviewReason: 'checkout_recovery_exhausted',
                checkoutRetryOwnerId: null,
                checkoutRetryLeaseExpiresAt: null,
                checkoutNextRetryAt: null,
              }
            : {
                checkoutNextRetryAt: new Date(
                  Date.now() + Math.min(60 * 60 * 1000, 2 ** row.checkoutRetryCount * 60 * 1000),
                ),
                checkoutRetryOwnerId: null,
                checkoutRetryLeaseExpiresAt: null,
              },
        });
        // Only THIS worker's own owned transition (CAS count 1) counts. A
        // concurrent CAS miss, stale/ineligible row, or another worker completing
        // the attempt is benign and never counts as a retryable/needs_review
        // failure.
        if (rescheduled.count === 1) {
          if (exhausted) needsReview++;
          else retryable++;
        }
      }
    }
    return { attempted: rows.length, recovered, needsReview, retryable };
  }

  private async createCheckoutForExistingAttempt(
    row: PaymentAttemptRow & { invoice: any },
    workerId: string,
  ): Promise<void> {
    const fixed = row.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE;
    // All local facts are validated before any provider/customer call: the
    // amount must be positive, cent-aligned, and safely convertible to Stripe
    // cents (throws on overflow); currency and fixed-fee invariants were
    // already proven by isRecoveryAttemptEligible before this path.
    const cents = this.microsToCents(row.amountMicros);
    const account = row.invoice.billingAccount;
    const customer = await this.ensureStripeCustomer(this.stripe!, account, account.userId);
    const period = formatUtcMonth(row.invoice.periodStart);
    const successUrl = withCheckoutReturnMarker(
      this.config.get<string>('stripe.successUrl')!,
      'success',
    );
    const cancelUrl = withCheckoutReturnMarker(
      this.config.get<string>('stripe.cancelUrl')!,
      'canceled',
    );
    const session = await this.stripe!.checkout.sessions.create(
      fixed
        ? {
            customer,
            mode: 'subscription',
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: 'usd',
                  recurring: { interval: 'month' },
                  unit_amount: cents,
                  product_data: { name: 'SOFA ONE subscription' },
                },
              },
            ],
            subscription_data: {
              billing_cycle_anchor: Math.floor(row.invoice.periodStart.getTime() / 1000),
              proration_behavior: 'none',
              metadata: {
                userId: account.userId,
                billingAccountId: account.id,
                invoiceId: row.invoiceId,
                attemptId: row.id,
                planVersionId: row.invoice.planVersionId,
              },
            },
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
              invoiceId: row.invoiceId,
              attemptId: row.id,
              period,
              planVersionId: row.invoice.planVersionId,
            },
            client_reference_id: row.invoiceId,
          }
        : {
            customer,
            mode: 'payment',
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: 'usd',
                  unit_amount: cents,
                  product_data: { name: `SOFA ONE — ${period} invoice` },
                },
              },
            ],
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: { invoiceId: row.invoiceId, attemptId: row.id, period },
            payment_intent_data: { metadata: { invoiceId: row.invoiceId, attemptId: row.id } },
            client_reference_id: row.invoiceId,
          },
      { idempotencyKey: `${fixed ? 'subscription-' : ''}checkout:${row.id}` },
    );
    const paymentIntentId = providerObjectId(session.payment_intent, 'payment_intent');
    const subscriptionId = providerObjectId(session.subscription, 'subscription');
    if (
      !session.url ||
      !providerObjectId(session.id, 'checkout_session') ||
      (!fixed && !paymentIntentId)
    )
      throw new ConflictException('Stripe checkout returned incomplete identity');
    await this.persistRecoveredCheckout(
      row,
      session.id,
      session.url,
      paymentIntentId,
      subscriptionId,
      workerId,
    );
  }

  private async persistRecoveredCheckout(
    row: PaymentAttemptRow & { invoice: { periodStart: Date; billingAccountId: string } },
    sessionId: string,
    checkoutUrl: string,
    paymentIntentId: string | null,
    subscriptionId: string | null,
    workerId: string,
  ): Promise<void> {
    if (row.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      await this.persistSubscriptionCheckout(
        row.invoice.billingAccountId,
        row.invoice.periodStart,
        row.id,
        sessionId,
        checkoutUrl,
        paymentIntentId,
        subscriptionId,
        workerId,
      );
    } else {
      await this.persistOneTimeCheckout(
        row.invoice.billingAccountId,
        row.invoice.periodStart,
        row.id,
        sessionId,
        checkoutUrl,
        paymentIntentId,
        workerId,
      );
    }
  }

  private async isRecoveryAttemptEligible(
    fresh: PaymentAttemptRow & { invoice: any },
    workerId: string,
  ): Promise<boolean> {
    // The attempt must still be pending and owned by the lease just acquired.
    if (fresh.status !== 'pending' || fresh.checkoutRetryOwnerId !== workerId) return false;
    if (
      !fresh.checkoutRetryLeaseExpiresAt ||
      fresh.checkoutRetryLeaseExpiresAt.getTime() <= Date.now()
    )
      return false;
    // The invoice must still be settlement-eligible: finalized, unpaid,
    // unsettled, USD, positive, cent-aligned, and amount-compatible.
    const inv = fresh.invoice;
    if (
      !inv ||
      inv.status !== 'finalized' ||
      inv.paidAt !== null ||
      inv.settlementAttemptId !== null ||
      inv.currency !== 'USD' ||
      inv.totalMicros <= 0n ||
      inv.totalMicros % MICROS_PER_CENT !== 0n
    )
      return false;
    if (fresh.amountMicros !== inv.totalMicros) return false;
    // A one-time full-invoice Checkout may only be recovered while the invoice
    // has NO coverage: any allocatedMicros or a succeeded-but-unallocated
    // fixed-fee attempt makes a full-total recovery an overcharge — fail
    // closed (the user pays the remainder via overage/USDC instead).
    if (fresh.stripeChargeKind === STRIPE_CHARGE_KIND_FULL) {
      if (inv.allocatedMicros > 0n) return false;
      const unallocatedFixed = await this.prisma.billingPaymentAttempt.findFirst({
        where: {
          invoiceId: inv.id,
          method: 'stripe',
          stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE,
          status: 'succeeded',
          allocatedAt: null,
        },
      });
      if (unallocatedFixed) return false;
    }
    // The attempt currency must be USD and match the invoice currency.
    if (fresh.currency !== 'USD' || fresh.currency !== inv.currency) return false;
    // The amount must be positive, cent-aligned, and safely convertible to
    // Stripe cents without unsafe Number(BigInt) overflow. Reuse the exact
    // microsToCents boundary so recovery and normal creation agree.
    try {
      this.microsToCents(fresh.amountMicros);
    } catch {
      return false;
    }
    // Fixed-fee recovery must match the invoice's plan version; a dynamic/
    // overage invoice (total != fixed fee) is rejected before any provider call.
    if (fresh.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      if (!inv.planVersionId) return false;
      if (inv.totalMicros !== fresh.amountMicros || inv.monthlyFeeMicros !== fresh.amountMicros)
        return false;
    }
    return true;
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
    if (
      metadata.invoiceId !== row.invoiceId ||
      metadata.attemptId !== row.id ||
      metadata.period !== formatUtcMonth(invoice.periodStart) ||
      session.client_reference_id !== row.invoiceId
    )
      return false;
    if (
      typeof session.customer !== 'string' ||
      session.customer !== invoice.billingAccount?.stripeCustomerId
    )
      return false;
    if (
      typeof session.currency !== 'string' ||
      session.currency.toLowerCase() !== row.currency.toLowerCase()
    )
      return false;
    if (session.amount_total !== Number(row.amountMicros / MICROS_PER_CENT)) return false;
    if (row.stripePaymentIntentId !== null && row.stripePaymentIntentId !== paymentIntentId)
      return false;
    if (row.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      if (session.mode !== 'subscription' || !subscriptionId) return false;
      if (row.stripeSubscriptionId !== null && row.stripeSubscriptionId !== subscriptionId)
        return false;
      if (metadata.planVersionId !== invoice.planVersionId) return false;
      const sub =
        typeof session.subscription === 'object' && session.subscription !== null
          ? (session.subscription as any)
          : null;
      if (
        !sub ||
        typeof sub.current_period_start !== 'number' ||
        typeof sub.current_period_end !== 'number'
      )
        return false;
      if (
        sub.current_period_start * 1000 !== invoice.periodStart.getTime() ||
        sub.current_period_end * 1000 !== invoice.periodEnd.getTime()
      )
        return false;
      // The subscription billing-cycle anchor must EXACTLY match the local
      // invoice period start; a provider period fabricated outside that cycle
      // cannot be proven and must not be recovered.
      if (
        typeof sub.billing_cycle_anchor !== 'number' ||
        sub.billing_cycle_anchor * 1000 !== invoice.periodStart.getTime()
      )
        return false;
    } else if (session.mode !== 'payment' || subscriptionId !== null || !paymentIntentId)
      return false;
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

    // Plan-charge upgrade invoices use one-time Checkout only — never a second
    // subscription. Recurring fixed-fee is reserved for usage_period renewals.
    if ((invoice as { purpose?: string }).purpose === 'plan_charge') {
      throw new ConflictException(
        'Plan upgrade charges must use one-time checkout, not subscription checkout',
      );
    }

    this.assertCheckoutEligible(invoice);

    // One subscription per account + durable create lease (Gate 1 attempt 3).
    const createLeaseOwner = `sub-create:${invoiceId}`;
    await this.prisma.$transaction(async (tx) => {
      await acquireBillingAccountAdvisoryLock(tx, account.id);
      const fresh = await tx.billingAccount.findUnique({ where: { id: account.id } });
      if (!fresh) throw new NotFoundException('Invoice not found');
      if (fresh.stripeSubscriptionId) {
        const status = fresh.stripeSubscriptionStatus;
        const liveOrUncertain =
          !status ||
          status === 'active' ||
          status === 'trialing' ||
          status === 'past_due' ||
          status === 'unpaid' ||
          status === 'incomplete' ||
          status === 'paused';
        if (liveOrUncertain) {
          throw new ConflictException(
            'Account already has a Stripe subscription; use plan change sync instead of creating another',
          );
        }
      }
      const now = new Date();
      const freshAny = fresh as typeof fresh & {
        subscriptionCreateLeaseExpiresAt?: Date | null;
        subscriptionCreateLeaseOwnerId?: string | null;
      };
      if (
        freshAny.subscriptionCreateLeaseExpiresAt &&
        freshAny.subscriptionCreateLeaseExpiresAt > now &&
        freshAny.subscriptionCreateLeaseOwnerId &&
        freshAny.subscriptionCreateLeaseOwnerId !== createLeaseOwner
      ) {
        throw new ConflictException(
          'Subscription create already in progress for this account; retry shortly',
        );
      }
      await tx.billingAccount.update({
        where: { id: account.id },
        data: {
          subscriptionCreateLeaseOwnerId: createLeaseOwner,
          subscriptionCreateLeaseExpiresAt: new Date(now.getTime() + 2 * 60 * 1000),
        } as any,
      });
    });

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
    if (
      planVersion.monthlyFeeMicros === null ||
      planVersion.monthlyFeeMicros !== invoice.totalMicros
    ) {
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

    let providerIdentity: {
      sessionId: string;
      checkoutUrl: string;
      paymentIntentId: string | null;
      subscriptionId: string | null;
    } | null = null;
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
          success_url: withCheckoutReturnMarker(successUrl, 'success'),
          cancel_url: withCheckoutReturnMarker(cancelUrl, 'canceled'),
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
        throw new ServiceUnavailableException(
          'Stripe subscription checkout returned incomplete identity',
        );
      }
      providerIdentity = {
        sessionId: session.id,
        checkoutUrl: session.url,
        paymentIntentId,
        subscriptionId,
      };

      const updated = await this.persistSubscriptionCheckout(
        account.id,
        invoice.periodStart,
        attempt.id,
        session.id,
        session.url,
        paymentIntentId,
        subscriptionId,
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
    if (this.planChanges && (invoice as { purpose?: string }).purpose === 'plan_charge') {
      await this.planChanges.assertPlanChargePayable(this.prisma, invoice.id);
    }

    // A one-time full-invoice Checkout charges the full `totalMicros`, so it is
    // ONLY allowed while the invoice has NO coverage: `allocatedMicros === 0`
    // AND no succeeded-but-not-yet-allocated fixed-fee attempt. Once any
    // fixed-fee coverage exists the user must pay the remainder (automatic
    // overage / USDC remainder) — a full-total Checkout would overcharge. The
    // gate is atomic (invoice row lock) and re-verified under the same locks on
    // the post-provider persistence path.
    await this.assertFullCheckoutNoCoverageAtomic(invoice);

    // Reuse a valid pending Checkout session (local lookup, no remote fetch).
    // Only a full-invoice pending attempt is reusable for one-time checkout.
    const reusable = await this.findReusablePendingAttempt(
      invoice.id,
      STRIPE_CHARGE_KIND_FULL,
      invoice.totalMicros,
      invoice.currency,
    );
    if (reusable?.stripeCheckoutSessionId && reusable.checkoutUrl) {
      // Re-gate under the invoice row lock before handing back a reused
      // full-total session: coverage allocated between the preflight above and
      // this return (e.g. a webhook-confirmed fixed-fee renewal) makes the
      // full-total session an overcharge. Fail closed — the remote session is
      // never canceled; the user simply cannot reuse it and must pay the
      // remainder via the overage/USDC rail instead.
      await this.assertFullCheckoutNoCoverageAtomic(invoice);
      return this.toResult(reusable);
    }

    // Create the pending attempt row atomically with the coverage gate (the
    // invoice row lock is held while the invariants are re-checked and the
    // attempt is inserted/reused, so a fixed-fee allocation can never slip
    // between the gate and the insert).
    const attempt = await this.createFullCheckoutAttempt(invoice);
    if (attempt.stripeCheckoutSessionId && attempt.checkoutUrl) {
      return this.toResult(attempt);
    }

    let providerIdentity: {
      sessionId: string;
      checkoutUrl: string;
      paymentIntentId: string | null;
      subscriptionId: string | null;
    } | null = null;
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
          success_url: withCheckoutReturnMarker(successUrl, 'success'),
          cancel_url: withCheckoutReturnMarker(cancelUrl, 'canceled'),
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
      if (!session.url)
        throw new ServiceUnavailableException('Stripe checkout session could not be created');
      providerIdentity = {
        sessionId: session.id,
        checkoutUrl: session.url,
        paymentIntentId,
        subscriptionId: null,
      };

      const updated = await this.persistOneTimeCheckout(
        account.id,
        invoice.periodStart,
        attempt.id,
        session.id,
        session.url ?? null,
        paymentIntentId,
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

  // ── Renewal overage (automatic remainder collection) ───────────────────────

  /**
   * Charges the remainder of a finalized renewal invoice after its fixed-fee
   * coverage has been allocated. Provider calls happen OUTSIDE any DB
   * transaction; only the attempt insert/status writes touch the database.
   *
   * Safety gates (each fails closed to a no-op or review — never a parallel
   * duplicate charge):
   *   * the invoice must be finalized, unpaid, and carry a positive remainder
   *     (`totalMicros - allocatedMicros`);
   *   * a succeeded fixed-fee attempt must already be ALLOCATED against the
   *     invoice (only renewal invoices with allocated fixed-fee coverage
   *     auto-collect overage);
   *   * no other active Stripe/USDC payment attempt may exist for the invoice
   *     and the invoice must be unsettled;
   *   * the remainder must be USD, positive, and cent-aligned;
   *   * the account must have a proven Stripe customer AND a provable default
   *     PaymentMethod — otherwise the attempt goes to `needs_review` (never a
   *     guessed charge).
   *
   * The PaymentIntent is created with `confirm: true`, `off_session: true`,
   * `currency: 'usd'`, and the stable idempotency key `overage-payment:<id>`.
   * Ambiguous provider failures keep the attempt pending with the retry lease
   * set; the same idempotency key on a later retry returns the SAME
   * PaymentIntent instead of charging twice.
   */
  async chargeRenewalOverage(
    account: OverageAccount,
    invoice: OverageInvoice,
    workerId: string,
  ): Promise<OverageChargeResult> {
    const stripe = this.stripe;
    if (!stripe) return 'skipped';
    // Re-read the frozen invoice fresh so the persisted attempt amount is
    // derived from the most recent committed total/allocation — never a stale
    // snapshot passed by the worker tick.
    const fresh = await this.prisma.billingInvoice.findUnique({
      where: { id: invoice.id },
    });
    if (!fresh) return 'skipped';
    invoice = {
      id: fresh.id,
      periodStart: fresh.periodStart,
      totalMicros: fresh.totalMicros,
      allocatedMicros: fresh.allocatedMicros,
      status: fresh.status,
      currency: fresh.currency,
      paidAt: fresh.paidAt,
      settlementAttemptId: fresh.settlementAttemptId,
    };
    const remainder = invoice.totalMicros - (invoice.allocatedMicros ?? 0n);
    if (
      invoice.status !== 'finalized' ||
      invoice.paidAt !== null ||
      invoice.settlementAttemptId !== null ||
      remainder <= 0n ||
      invoice.currency !== 'USD'
    ) {
      return 'skipped';
    }

    // A succeeded AND allocated fixed-fee attempt must already cover part of
    // this invoice. Without it this is a manual invoice, not a renewal.
    const fixedFeeCoverage = await this.prisma.billingPaymentAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        method: 'stripe',
        stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE,
        status: 'succeeded',
        allocatedAt: { not: null },
      },
    });
    if (!fixedFeeCoverage) return 'skipped';

    // Cross-rail exclusion: an ACTIVE USDC attempt (pending or confirming) on
    // the same invoice means the user is paying on-chain right now. Starting an
    // off-session Stripe charge in parallel could double-collect — skip and let
    // the USDC rail finish. The DB-level active-charge partial unique index is
    // the second, stronger gate (the insert below fails closed on a race).
    const activeUsdc = await this.prisma.billingPaymentAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        method: 'usdc',
        status: { in: ['pending', 'confirming'] },
      },
    });
    if (activeUsdc) return 'skipped';

    // The remainder must be positive and cent-aligned (lossless USD charge)
    // before an attempt is created; the amount is then persisted as the
    // attempt's snapshot and every later retry reuses it, never a per-tick
    // recomputation of the invoice remainder.
    if (remainder <= 0n || remainder % MICROS_PER_CENT !== 0n) return 'needs_review';

    // Bounded, backoff-respecting retry gate (atomic with the insert below via
    // the partial unique indexes): inspect the LATEST overage attempt on this
    // invoice before creating a new one.
    //   * an active attempt (pending) is the single-flight reservation — skip;
    //   * an operator-reviewed attempt (needs_review) stops auto-retry;
    //   * a successful attempt means the invoice is covered — skip;
    //   * a failed attempt is retried only after its checkoutNextRetryAt
    //     backoff has elapsed.
    const latestOverage = await this.prisma.billingPaymentAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        method: 'stripe',
        stripeChargeKind: STRIPE_CHARGE_KIND_OVERAGE,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (latestOverage) {
      if (latestOverage.status === 'pending' || latestOverage.status === 'confirming')
        return 'skipped';
      if (latestOverage.status === 'needs_review') return 'needs_review';
      if (
        latestOverage.status === 'failed' &&
        latestOverage.checkoutNextRetryAt &&
        latestOverage.checkoutNextRetryAt.getTime() > Date.now()
      ) {
        return 'skipped';
      }
    }
    const priorOverage = await this.prisma.billingPaymentAttempt.count({
      where: {
        invoiceId: invoice.id,
        method: 'stripe',
        stripeChargeKind: STRIPE_CHARGE_KIND_OVERAGE,
      },
    });
    if (priorOverage >= OVERAGE_MAX_RETRIES) return 'needs_review';

    // Atomically claim the single active Stripe slot for this invoice (partial
    // pending index). A concurrent worker/webhook that already created an
    // active attempt (overage, full checkout, or fixed fee) makes this a
    // skip — never a second charge.
    let attempt: PaymentAttemptRow;
    try {
      attempt = await this.prisma.billingPaymentAttempt.create({
        data: {
          invoiceId: invoice.id,
          method: 'stripe',
          status: 'pending',
          amountMicros: remainder,
          currency: 'USD',
          stripeChargeKind: STRIPE_CHARGE_KIND_OVERAGE,
          checkoutRetryOwnerId: workerId,
          checkoutRetryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) return 'skipped';
      throw err;
    }

    const period = formatUtcMonth(invoice.periodStart);
    return this.createOveragePaymentIntent(account, invoice, attempt, workerId, period);
  }

  /**
   * Runs the provider call for an automatic overage charge OUTSIDE any DB
   * transaction: proves the customer's default PaymentMethod (fail closed),
   * creates the off-session PaymentIntent with the stable idempotency key
   * `overage-payment:<attemptId>`, verifies the returned identity, and
   * persists the PaymentIntent id on the attempt. A retry/recovery reuses the
   * SAME attempt id — and therefore the same idempotency key — so it can never
   * produce a second charge.
   *
   * Local persistence is deliberately fail-closed: if the PaymentIntent was
   * created/confirmed by Stripe but the local id write fails or cannot be
   * proven (including `updateMany` count 0 or an unknown DB exception), the
   * attempt is NEVER marked failed and NO new attempt is ever created. The
   * same attempt stays pending with the PaymentIntent id preserved (when
   * known), `local_persistence_uncertain`, and a bounded retry lease; recovery
   * re-issues the identical idempotency key (or skips once the PI id is
   * durably stored and the webhook owns the outcome).
   */
  private async createOveragePaymentIntent(
    account: OverageAccount,
    invoice: OverageInvoice,
    attempt: PaymentAttemptRow,
    workerId: string,
    period: string,
  ): Promise<OverageChargeResult> {
    const stripe = this.stripe;
    if (!stripe) return 'skipped';
    // The charge amount is always the attempt's persisted snapshot — never a
    // per-tick recomputation of the invoice remainder.
    let cents: number;
    try {
      cents = this.microsToCents(attempt.amountMicros);
    } catch {
      await this.markOverageAttempt(attempt.id, {
        status: 'needs_review',
        reviewReason: 'overage_amount_not_cent_aligned',
      });
      return 'needs_review';
    }
    const customerId = account.stripeCustomerId;
    if (!customerId) {
      await this.markOverageAttempt(attempt.id, {
        status: 'needs_review',
        reviewReason: 'missing_stripe_customer',
      });
      return 'needs_review';
    }

    // Prove a default payment method that belongs to this customer before
    // charging anything off-session.
    let defaultPm: string | null = null;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.deleted)
        return this.markOverageReview(attempt.id, 'missing_default_payment_method');
      const invoiceSettings = (
        customer as { invoice_settings?: { default_payment_method?: unknown } }
      ).invoice_settings;
      defaultPm =
        providerPaymentMethodId(invoiceSettings?.default_payment_method) ??
        ((customer as { default_source?: unknown }).default_source !== undefined
          ? providerPaymentMethodId((customer as { default_source?: unknown }).default_source)
          : null);
      if (!defaultPm) {
        // Fail closed: without a provable default PaymentMethod we never guess
        // or charge — the attempt is surfaced for operator action.
        return this.markOverageReview(attempt.id, 'missing_default_payment_method');
      }
      // Prove the PaymentMethod is attached EXACTLY to this customer. Stripe
      // returns `customer` as a string id or an expanded Customer object; a
      // detached (`null`/`undefined`) or unprovable value can never satisfy
      // the exact match and fails closed — a cross-tenant or unattached
      // PaymentMethod is never charged.
      const pm = await stripe.paymentMethods.retrieve(defaultPm);
      if (providerCustomerId(pm.customer) !== customerId) {
        return this.markOverageReview(attempt.id, 'default_payment_method_customer_mismatch');
      }
    } catch (err) {
      // No charge has happened yet — a provider/DB failure here cannot produce
      // a second charge, so it is safe to classify as pending-uncertain (a
      // retry reuses the same idempotency key) rather than fabricating a
      // success.
      return this.markOverageUncertain(attempt.id, extractPaymentIntentId(err), workerId);
    }

    // Provider call (outside any DB transaction).
    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: cents,
          currency: 'usd',
          customer: customerId,
          payment_method: defaultPm!,
          confirm: true,
          off_session: true,
          payment_method_types: ['card'],
          description: `SOFA ONE overage — ${period}`,
          metadata: {
            invoiceId: invoice.id,
            attemptId: attempt.id,
            period,
            chargeKind: STRIPE_CHARGE_KIND_OVERAGE,
          },
        },
        // Stable business idempotency key: a Stripe timeout/retry of this
        // exact call returns the same PaymentIntent instead of double-charging.
        { idempotencyKey: `overage-payment:${attempt.id}` },
      );
    } catch (err) {
      // Ambiguous provider errors (timeout/5xx/network) may have created the
      // PaymentIntent. Keep the SAME attempt pending with the provider id when
      // it is present in the error and schedule a bounded retry that reuses
      // the same idempotency key — never a new attempt and never a new key.
      const piInError = extractPaymentIntentId(err);
      if (piInError || isAmbiguousCheckoutError(err)) {
        return this.markOverageUncertain(attempt.id, piInError, workerId);
      }
      // A definitive provider rejection (card_declined, authentication
      // required, etc.) means NO charge was made: the attempt may fail and be
      // retried within the bounded budget.
      const { code, message } = extractSafeFailure(err);
      await this.markOverageAttempt(attempt.id, {
        status: 'failed',
        failedAt: new Date(),
        failureCode: code ?? 'overage_charge_failed',
        failureMessage: message ?? 'Automatic overage charge failed',
        checkoutNextRetryAt: new Date(Date.now() + OVERAGE_RETRY_BACKOFF_MS),
      });
      return 'failed';
    }

    // Strict provider identity: the returned PaymentIntent must carry the
    // amount/currency/customer we requested and our own attempt metadata.
    const piId = typeof paymentIntent.id === 'string' ? paymentIntent.id : null;
    if (!piId || !piId.startsWith('pi_')) {
      return this.markOverageUncertain(attempt.id, piId, workerId);
    }
    if (
      paymentIntent.amount !== cents ||
      String(paymentIntent.currency).toLowerCase() !== 'usd' ||
      paymentIntent.customer !== customerId ||
      paymentIntent.metadata?.attemptId !== attempt.id ||
      paymentIntent.metadata?.chargeKind !== STRIPE_CHARGE_KIND_OVERAGE ||
      paymentIntent.metadata?.invoiceId !== invoice.id
    ) {
      return this.markOverageReview(attempt.id, 'payment_intent_identity_mismatch');
    }

    // Off-session payment intents that require SCA (requires_action /
    // requires_payment_method) or were canceled can never complete on their
    // own. Surfacing them as needs_review (with a safe reason) keeps them out
    // of an eternal pending state and out of fake-success; the bounded retry
    // budget still applies and the reason is recorded.
    const piStatus = typeof paymentIntent.status === 'string' ? paymentIntent.status : null;
    if (
      piStatus === 'requires_action' ||
      piStatus === 'requires_payment_method' ||
      piStatus === 'canceled'
    ) {
      return this.markOverageReview(
        attempt.id,
        piStatus === 'requires_action'
          ? 'payment_intent_requires_action'
          : piStatus === 'canceled'
            ? 'payment_intent_canceled'
            : 'payment_intent_requires_payment_method',
      );
    }

    // Persist the PaymentIntent id on the SAME attempt. This is the only point
    // where the attempt may legitimately transition to created; any failure
    // here means the charge may already exist on the provider side, so the
    // attempt must stay pending/uncertain (never failed, never a new attempt).
    try {
      const persisted = await this.prisma.billingPaymentAttempt.updateMany({
        where: {
          id: attempt.id,
          status: 'pending',
          OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: piId }],
        },
        data: {
          stripePaymentIntentId: piId,
          checkoutRetryOwnerId: null,
          checkoutRetryLeaseExpiresAt: null,
        },
      });
      if (persisted.count === 1) return 'created';
      const current = await this.prisma.billingPaymentAttempt.findUnique({
        where: { id: attempt.id },
      });
      if (current?.stripePaymentIntentId === piId) return 'created';
    } catch {
      // DB failure while persisting: fall through to the uncertain path.
    }
    // updateMany matched 0 rows or the PI id could not be proven stored —
    // best-effort persist the id, keep the SAME attempt pending with a bounded
    // retry lease, and never mark it failed.
    return this.markOverageUncertain(attempt.id, piId, workerId);
  }

  /** Fail-closed review outcome for an overage attempt (safe reason recorded). */
  private async markOverageReview(
    attemptId: string,
    reviewReason: string,
  ): Promise<OverageChargeResult> {
    await this.markOverageAttempt(attemptId, {
      status: 'needs_review',
      reviewReason,
      failureCode: reviewReason,
      failureMessage: 'Automatic overage charge failed closed; see review reason',
    });
    return 'needs_review';
  }

  /**
   * Keeps an overage attempt pending in an uncertainty window: the provider
   * identity (PI id) is preserved when known, the retry lease is (re)claimed,
   * and a bounded retry is scheduled. Recovery re-issues the SAME idempotency
   * key on this SAME attempt, so the charge can never be duplicated by a new
   * attempt/new key.
   */
  private async markOverageUncertain(
    attemptId: string,
    piId: string | null,
    workerId: string,
  ): Promise<OverageChargeResult> {
    try {
      await this.prisma.billingPaymentAttempt.updateMany({
        where: { id: attemptId, status: 'pending' },
        data: {
          ...(piId ? { stripePaymentIntentId: piId } : {}),
          failureCode: 'local_persistence_uncertain',
          failureMessage: 'Overage PaymentIntent identity persistence was uncertain',
          checkoutNextRetryAt: new Date(Date.now() + OVERAGE_RETRY_BACKOFF_MS),
          checkoutRetryOwnerId: workerId,
          checkoutRetryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
        },
      });
    } catch {
      // Even a failed mark is non-fatal: the attempt remains pending with no PI
      // id and recovery will re-issue the same idempotency key next tick.
    }
    return 'pending';
  }

  /**
   * Recovers an interrupted automatic overage charge whose provider identity
   * was never persisted (local_persistence_uncertain). The retry reuses the
   * SAME attempt id and therefore the SAME Stripe idempotency key
   * (`overage-payment:<id>`), so it can never produce a second charge.
   *
   * The recovery lease claim is fail-closed on the retry BACKOFF as well: the
   * atomic CAS only matches when `checkoutNextRetryAt` is absent OR already
   * due, so an attempt whose backoff is still in the future is never re-issued
   * to Stripe — even if its 2-minute lease expired early. Bounded by
   * `checkoutRetryCount`/`OVERAGE_MAX_RETRIES`.
   */
  async recoverOverageCharge(
    attempt: PaymentAttemptRow,
    workerId: string,
  ): Promise<OverageChargeResult> {
    if (!this.stripe) return 'skipped';
    if (attempt.status !== 'pending') return 'skipped';
    const current = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: attempt.id },
      include: { invoice: { include: { billingAccount: true } } },
    });
    if (
      !current ||
      current.status !== 'pending' ||
      current.stripeChargeKind !== STRIPE_CHARGE_KIND_OVERAGE
    ) {
      return 'skipped';
    }
    // A persisted PI id means the webhook owns the outcome now.
    if (current.stripePaymentIntentId) return 'skipped';
    const invoice = current.invoice;
    if (!invoice || invoice.status !== 'finalized' || invoice.paidAt !== null) return 'skipped';
    const now = new Date();
    const claimed = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attempt.id,
        status: 'pending',
        stripePaymentIntentId: null,
        AND: [
          // The recovery lease must be claimable.
          {
            OR: [
              { checkoutRetryOwnerId: null },
              { checkoutRetryLeaseExpiresAt: null },
              { checkoutRetryLeaseExpiresAt: { lt: now } },
            ],
          },
          // The retry BACKOFF must have elapsed (or never been scheduled).
          {
            OR: [{ checkoutNextRetryAt: null }, { checkoutNextRetryAt: { lte: now } }],
          },
        ],
      },
      data: {
        checkoutRetryOwnerId: workerId,
        checkoutRetryLeaseExpiresAt: new Date(now.getTime() + 2 * 60 * 1000),
        checkoutRetryCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return 'skipped';
    if (current.checkoutRetryCount + 1 > OVERAGE_MAX_RETRIES) {
      await this.markOverageAttempt(attempt.id, {
        status: 'needs_review',
        reviewReason: 'overage_recovery_exhausted',
      });
      return 'needs_review';
    }
    return this.createOveragePaymentIntent(
      current.invoice.billingAccount,
      invoice,
      current,
      workerId,
      formatUtcMonth(invoice.periodStart),
    );
  }

  /** Pending-only, identity-aware status write for an overage attempt. */
  private async markOverageAttempt(
    attemptId: string,
    data: Prisma.BillingPaymentAttemptUncheckedUpdateManyInput,
  ): Promise<void> {
    await this.prisma.billingPaymentAttempt.updateMany({
      where: { id: attemptId, status: 'pending' },
      data: {
        ...data,
        ...('status' in data && data.status !== 'pending'
          ? { checkoutRetryOwnerId: null, checkoutRetryLeaseExpiresAt: null }
          : {}),
      },
    });
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
    if (!checkoutUrl)
      throw new ServiceUnavailableException('Stripe checkout session could not be created');
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, accountId, periodStart);
      // Stable row locks in attempt → invoice order (matching the settlement
      // boundary), so the coverage re-check below serializes with any
      // concurrent fixed-fee allocation and no stale lock-free read is trusted.
      const lockedAttempt = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "billing_payment_attempts" WHERE "id" = ${attemptId} FOR UPDATE`;
      if (lockedAttempt.length === 0)
        throw new ConflictException('Stripe checkout attempt is unavailable');
      const attempt = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt || attempt.invoiceId === null)
        throw new ConflictException('Stripe checkout attempt is unavailable');
      const lockedInvoice = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "billing_invoices" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`;
      if (lockedInvoice.length === 0)
        throw new ConflictException('Stripe checkout invoice is unavailable');
      const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
      // A settled/paid/void/non-finalized invoice must never be rebound by
      // recovery. Preserve coverage-first, invoice-paid-last.
      if (
        !invoice ||
        invoice.status !== 'finalized' ||
        invoice.paidAt !== null ||
        invoice.settlementAttemptId !== null ||
        invoice.currency !== 'USD' ||
        invoice.totalMicros <= 0n ||
        invoice.totalMicros % MICROS_PER_CENT !== 0n ||
        attempt.amountMicros !== invoice.totalMicros
      )
        throw new ConflictException('Stripe checkout invoice is no longer payable');
      // Full-invoice Checkout re-gate under the locks: any coverage that
      // appeared between the preflight and the provider call (or a concurrent
      // fixed-fee allocation) rejects the persistence — the session ids are
      // never durably bound to a full-total charge on a partially-covered
      // invoice.
      await this.assertFullCheckoutNoCoverage(invoice, tx);
      const claimed = await tx.billingPaymentAttempt.updateMany({
        where: {
          id: attemptId,
          status: 'pending',
          ...(workerId
            ? { checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: { gt: new Date() } }
            : {}),
          AND: [
            { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: sessionId }] },
            { OR: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: paymentIntentId }] },
            { OR: [{ checkoutUrl: null }, { checkoutUrl }] },
          ],
        } as any,
        data: {
          stripeCheckoutSessionId: sessionId,
          stripePaymentIntentId: paymentIntentId,
          checkoutUrl,
        },
      });
      if (claimed.count !== 1) {
        const current = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
        if (
          !current ||
          current.stripeCheckoutSessionId !== sessionId ||
          current.checkoutUrl !== checkoutUrl ||
          current.stripePaymentIntentId !== paymentIntentId
        ) {
          throw new ConflictException(
            'Stripe checkout identity was bound by a concurrent operation',
          );
        }
      }
      const result = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!result || !result.stripeCheckoutSessionId || !result.checkoutUrl)
        throw new ServiceUnavailableException('Stripe checkout session could not be created');
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
    if (!checkoutUrl)
      throw new ServiceUnavailableException(
        'Stripe subscription checkout returned incomplete identity',
      );
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, accountId, periodStart);
      const attempt = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      const account = await tx.billingAccount.findUnique({ where: { id: accountId } });
      if (!attempt || !account)
        throw new ConflictException('Stripe subscription checkout state is unavailable');
      const inv = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
      if (
        !inv ||
        inv.status !== 'finalized' ||
        inv.paidAt !== null ||
        inv.settlementAttemptId !== null ||
        inv.currency !== 'USD' ||
        inv.totalMicros <= 0n ||
        inv.totalMicros % MICROS_PER_CENT !== 0n ||
        attempt.amountMicros !== inv.totalMicros
      )
        throw new ConflictException('Stripe subscription checkout invoice is no longer payable');
      const claimed = await tx.billingPaymentAttempt.updateMany({
        where: {
          id: attemptId,
          status: 'pending',
          ...(workerId
            ? { checkoutRetryOwnerId: workerId, checkoutRetryLeaseExpiresAt: { gt: new Date() } }
            : {}),
          AND: [
            { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: sessionId }] },
            ...(paymentIntentId
              ? [
                  {
                    OR: [
                      { stripePaymentIntentId: null },
                      { stripePaymentIntentId: paymentIntentId },
                    ],
                  },
                ]
              : []),
            ...(subscriptionId
              ? [{ OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: subscriptionId }] }]
              : []),
            { OR: [{ checkoutUrl: null }, { checkoutUrl }] },
          ],
        } as any,
        data: {
          stripeCheckoutSessionId: sessionId,
          ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          checkoutUrl,
        },
      });
      if (claimed.count !== 1)
        throw new ConflictException('Stripe checkout identity was bound by a concurrent operation');
      if (subscriptionId) {
        if (account.stripeSubscriptionId && account.stripeSubscriptionId !== subscriptionId) {
          throw new ConflictException('An active subscription already exists for this account');
        }
        if (!account.stripeSubscriptionId) {
          const mirrored = await tx.billingAccount.updateMany({
            where: { id: accountId, stripeSubscriptionId: null },
            data: { stripeSubscriptionId: subscriptionId, stripeSubscriptionStatus: 'incomplete' },
          });
          if (mirrored.count !== 1)
            throw new ConflictException('An active subscription already exists for this account');
        }
      }
      const result = await tx.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!result || !result.checkoutUrl)
        throw new ServiceUnavailableException('Stripe subscription checkout could not be created');
      return result;
    });
  }

  /**
   * Only `finalized` (amount-frozen), unpaid, positive, USD, cent-aligned
   * invoices are payable. Applies to both usage_period invoices and
   * plan_charge upgrade invoices (one-time Checkout only — never
   * createSubscriptionCheckout for plan_charge). `open`/`void`/`needs_review`/
   * zero-amount invoices and amounts that cannot be represented losslessly in
   * Stripe cents fail closed with a 4xx.
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

  // ── Full-invoice Checkout coverage gate ────────────────────────────────────

  /**
   * A one-time full-invoice Checkout charges `invoice.totalMicros`, so it is
   * ONLY allowed when the invoice has NO coverage yet: `allocatedMicros` must be
   * 0 AND no succeeded-but-not-yet-allocated fixed-fee attempt may exist (a
   * real renewal charge that is pending allocation). Once any fixed-fee
   * coverage exists the user must pay the remainder (automatic overage / USDC
   * remainder) instead — a full-total Checkout would overcharge. This check is
   * re-run under the invoice row lock on the atomic gate and the post-provider
   * persistence path, so it is never a bare non-atomic read.
   */
  private async assertFullCheckoutNoCoverage(invoice: BillingInvoiceRow, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    if (invoice.allocatedMicros > 0n) {
      throw new ConflictException(
        'Invoice already has allocated coverage; pay the remainder instead of the full total',
      );
    }
    const unallocatedFixed = await db.billingPaymentAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        method: 'stripe',
        stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE,
        status: 'succeeded',
        allocatedAt: null,
      },
    });
    if (unallocatedFixed) {
      throw new ConflictException(
        'A fixed-fee renewal payment is pending allocation for this invoice; full-invoice checkout is not allowed',
      );
    }
  }

  /**
   * Atomic coverage gate for the full-invoice Checkout: a short transaction
   * that locks the invoice row (FOR UPDATE) and re-checks the coverage
   * invariants, serializing with any fixed-fee allocation (settleInvoice takes
   * the same invoice row lock). Closes the pre-create TOCTOU; the
   * post-provider persistence path re-checks under the same locks.
   */
  private async assertFullCheckoutNoCoverageAtomic(invoice: BillingInvoiceRow): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
      if (locked.length === 0) throw new ConflictException('Invoice is no longer payable');
      const fresh = await tx.billingInvoice.findUnique({ where: { id: invoice.id } });
      if (!fresh) throw new ConflictException('Invoice is no longer payable');
      await this.assertFullCheckoutNoCoverage(fresh, tx);
    });
  }

  /**
   * Creates (or reuses) the pending full-invoice Checkout attempt ATOMICALLY
   * with the coverage gate: the billing-period advisory lock + the invoice row
   * lock (attempt→invoice order, matching settlement) are held while the
   * coverage invariants are re-checked and the attempt is created/reused, so a
   * fixed-fee allocation can never slip between the gate and the insert. A lost
   * insert race is resolved under the same locks (reuse a compatible pending
   * Stripe session or fail closed on a cross-rail reservation).
   */
  private async createFullCheckoutAttempt(invoice: BillingInvoiceRow): Promise<PaymentAttemptRow> {
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
      if (locked.length === 0) throw new ConflictException('Invoice is no longer payable');
      const fresh = await tx.billingInvoice.findUnique({ where: { id: invoice.id } });
      if (!fresh) throw new ConflictException('Invoice is no longer payable');
      await this.assertFullCheckoutNoCoverage(fresh, tx);
      return this.createPendingAttemptOrReuseInFlight(
        fresh,
        { stripeChargeKind: STRIPE_CHARGE_KIND_FULL },
        tx,
      );
    });
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
    tx?: Tx,
  ): Promise<PaymentAttemptRow> {
    const db = tx ?? this.prisma;
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
      return await db.billingPaymentAttempt.create({
        data: attemptData,
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    // A concurrent request holds the single pending Stripe slot. Wait briefly
    // for its session id to appear before deciding how to proceed.
    for (let attempt = 0; attempt < IN_FLIGHT_POLL_ATTEMPTS; attempt++) {
      const existing = await db.billingPaymentAttempt.findFirst({
        where: { invoiceId: invoice.id, method: 'stripe', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) {
        // The winner released the slot (its Stripe call failed) — create fresh
        // under the unified active-payment reservation (a lost race to ANOTHER
        // active rail is a hard conflict, never a second attempt).
        return this.createStripeAttemptOrConflict(attemptData, tx);
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
    const pending = await db.billingPaymentAttempt.findFirst({
      where: { invoiceId: invoice.id, method: 'stripe', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) {
      if (isStalePendingAttempt(pending)) {
        const released = await db.billingPaymentAttempt.updateMany({
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
        return this.createStripeAttemptOrConflict(attemptData, tx);
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
   * Creates a pending Stripe attempt under the unified active-payment
   * reservation (`billing_payment_attempts_one_active_payment_per_invoice_idx`,
   * migration-only): at most ONE active payment attempt per invoice across all
   * rails. A lost unique-constraint race therefore means another ACTIVE rail
   * (e.g. a confirming USDC transfer or a concurrent different-kind Stripe
   * attempt) holds the invoice-level slot — a hard Conflict, never a second
   * attempt that could double-charge. The same rail's own active attempt is
   * reused by the caller, so this never blocks a legitimate same-rail flow.
   */
  private async createStripeAttemptOrConflict(
    attemptData: Prisma.BillingPaymentAttemptUncheckedCreateInput,
    tx?: Tx,
  ): Promise<PaymentAttemptRow> {
    const db = tx ?? this.prisma;
    try {
      return await db.billingPaymentAttempt.create({ data: attemptData });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const active = await db.billingPaymentAttempt.findFirst({
        where: {
          invoiceId: attemptData.invoiceId,
          status: { in: ['pending', 'confirming'] },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (active && active.method !== 'stripe') {
        throw new ConflictException(
          'An active payment of another rail is already in progress for this invoice',
        );
      }
      throw new ConflictException(
        'A payment attempt is already being created for this invoice; please retry',
      );
    }
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
    identity: {
      sessionId: string;
      checkoutUrl: string;
      paymentIntentId: string | null;
      subscriptionId: string | null;
    } | null,
  ): Promise<void> {
    try {
      // Build a single AND array so every null-or-same identity predicate is
      // applied simultaneously — spreading separate AND keys would drop the
      // payment-intent fence when both PI and subscription identities exist.
      const identityAnd: Array<Record<string, unknown>> = [];
      if (identity?.sessionId)
        identityAnd.push({
          OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: identity.sessionId }],
        });
      if (identity?.paymentIntentId)
        identityAnd.push({
          OR: [
            { stripePaymentIntentId: null },
            { stripePaymentIntentId: identity.paymentIntentId },
          ],
        });
      if (identity?.subscriptionId)
        identityAnd.push({
          OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: identity.subscriptionId }],
        });
      await (this.prisma.billingPaymentAttempt as any).updateMany({
        where: {
          id: attemptId,
          status: 'pending',
          ...(identityAnd.length > 0 ? { AND: identityAnd } : {}),
        } as any,
        data: {
          status: 'pending',
          ...(identity
            ? {
                stripeCheckoutSessionId: identity.sessionId,
                checkoutUrl: identity.checkoutUrl,
                ...(identity.paymentIntentId
                  ? { stripePaymentIntentId: identity.paymentIntentId }
                  : {}),
                ...(identity.subscriptionId
                  ? { stripeSubscriptionId: identity.subscriptionId }
                  : {}),
              }
            : {}),
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
  const value = error as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
  } | null;
  const code = typeof value?.code === 'string' ? value.code.toLowerCase() : '';
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  const status =
    typeof value?.statusCode === 'number'
      ? value.statusCode
      : typeof value?.status === 'number'
        ? value.status
        : 0;
  return (
    status >= 500 ||
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnaborted' ||
    code === 'timeout' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('socket hang up')
  );
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
  const id =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null
        ? (value as { id?: unknown }).id
        : null;
  const prefix =
    expectedPrefix === 'payment_intent'
      ? 'pi_'
      : expectedPrefix === 'subscription'
        ? 'sub_'
        : expectedPrefix === 'checkout_session'
          ? 'cs_'
          : null;
  if (typeof id === 'string' && id.length > 0 && (!prefix || id.startsWith(prefix))) return id;
  throw new ConflictException(`Malformed Stripe ${expectedPrefix} identity`);
}

/**
 * Resolves a Stripe Customer id from a provider `customer` field (string id or
 * expanded Customer object). Anything unprovable — including a detached
 * `null`/`undefined` or a malformed value — returns null so callers fail
 * closed instead of guessing ownership.
 */
function providerCustomerId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.startsWith('cus_')) return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('cus_')) return id;
  }
  return null;
}

/**
 * Resolves a Stripe PaymentMethod id from a customer's default payment method
 * field (string id or expanded object). Anything unprovable returns null — the
 * overage flow fails closed on null instead of guessing.
 */
function providerPaymentMethodId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.startsWith('pm_')) return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('pm_')) return id;
  }
  return null;
}

/**
 * Best-effort extraction of a PaymentIntent id from a Stripe API error, so a
 * timeout/5xx that actually created the PaymentIntent never loses its
 * identity. Returns null when the error carries no PI id.
 */
function extractPaymentIntentId(error: unknown): string | null {
  const raw = error as { payment_intent?: unknown; paymentIntent?: unknown; code?: unknown } | null;
  const value = raw?.payment_intent ?? raw?.paymentIntent;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.startsWith('pi_')) return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('pi_')) return id;
  }
  return null;
}

// ── Checkout return markers ───────────────────────────────────────────────────

const CHECKOUT_RETURN_MARKERS: Record<'success' | 'canceled', string> = {
  success: 'success=1',
  canceled: 'canceled=1',
};

/**
 * Deterministic, frontend-compatible checkout return marker merged onto a
 * server-configured absolute success/cancel URL (the frontend billing page
 * keys off the bare query-param presence of `success`/`canceled`). The
 * configured URL stays authoritative: its scheme/host/path, every existing
 * query parameter, and any fragment are preserved byte-for-byte, and the
 * marker is only placed in the query string (before any fragment) when its key
 * is not already present — so URLs with/without query strings and fragments
 * are handled and duplicate marker keys are never emitted.
 */
export function withCheckoutReturnMarker(url: string, outcome: 'success' | 'canceled'): string {
  const marker = CHECKOUT_RETURN_MARKERS[outcome];
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = base.indexOf('?');
  if (queryIndex === -1) {
    return `${base}?${marker}${fragment}`;
  }
  const query = base.slice(queryIndex + 1);
  const alreadyMarked = query.split('&').some((pair) => {
    const equalsIndex = pair.indexOf('=');
    return (equalsIndex === -1 ? pair : pair.slice(0, equalsIndex)) === outcome;
  });
  if (alreadyMarked) return url;
  return `${base}&${marker}${fragment}`;
}

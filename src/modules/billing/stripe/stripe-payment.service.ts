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
import * as Stripe from 'stripe';
import { PENDING_SESSION_REUSE_TTL_MS, STRIPE_CLIENT } from './stripe.constants';

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
    const reusable = await this.findReusablePendingAttempt(invoice.id);
    if (reusable?.stripeCheckoutSessionId && reusable.checkoutUrl) {
      return this.toResult(reusable);
    }

    // Create the pending attempt row. The partial unique index makes this
    // race-safe: a concurrent request that already inserted a pending attempt
    // is detected via P2002 and its session is reused instead.
    const attempt = await this.createPendingAttemptOrReuseInFlight(invoice);
    if (attempt.stripeCheckoutSessionId && attempt.checkoutUrl) {
      return this.toResult(attempt);
    }

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

      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);

      const updated = await this.prisma.billingPaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          checkoutUrl: session.url ?? null,
        },
      });

      if (!updated.stripeCheckoutSessionId || !updated.checkoutUrl) {
        // Hosted Checkout always returns a URL; treat a missing one as a
        // server-side failure rather than returning a broken link.
        throw new ServiceUnavailableException('Stripe checkout session could not be created');
      }
      return this.toResult(updated);
    } catch (err) {
      // A Stripe/DB failure must not leave a pending attempt that blocks
      // future retries (the partial pending index). Mark it failed safely.
      await this.markAttemptFailed(attempt.id, err);
      throw err;
    }
  }

  // ── Eligibility ────────────────────────────────────────────────────────────

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
   * A pending Stripe attempt with a persisted session id younger than the TTL.
   * Scoped to `method = stripe` so a USDC pending attempt is never reused as a
   * Stripe checkout session.
   */
  private async findReusablePendingAttempt(invoiceId: string): Promise<PaymentAttemptRow | null> {
    const cutoff = new Date(Date.now() - PENDING_SESSION_REUSE_TTL_MS);
    return this.prisma.billingPaymentAttempt.findFirst({
      where: {
        invoiceId,
        method: 'stripe',
        status: 'pending',
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
   * Stripe attempt is re-fetched: if it already carries a session id it is
   * reused; if the winner released the slot (failed) a fresh attempt is
   * created; a clearly stale attempt (older than the reuse TTL) is released
   * and replaced. A young pending attempt that is still being created by a
   * legitimate slow Stripe request is never disturbed — the caller gets a
   * retryable conflict instead of a second pending attempt/session. A USDC
   * pending attempt never blocks or satisfies a Stripe request (method-scoped
   * lookups).
   */
  private async createPendingAttemptOrReuseInFlight(
    invoice: Prisma.BillingInvoiceGetPayload<Record<string, never>>,
  ): Promise<PaymentAttemptRow> {
    try {
      return await this.prisma.billingPaymentAttempt.create({
        data: {
          invoiceId: invoice.id,
          method: 'stripe',
          status: 'pending',
          amountMicros: invoice.totalMicros,
          currency: invoice.currency,
        },
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
        return this.prisma.billingPaymentAttempt.create({
          data: {
            invoiceId: invoice.id,
            method: 'stripe',
            status: 'pending',
            amountMicros: invoice.totalMicros,
            currency: invoice.currency,
          },
        });
      }
      if (existing.stripeCheckoutSessionId && existing.checkoutUrl) {
        return existing; // winner persisted its session — reuse it
      }
      if (isStalePendingAttempt(existing)) {
        break; // clearly stale — release below
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
    if (pending?.stripeCheckoutSessionId && pending.checkoutUrl) {
      return pending;
    }
    if (pending && isStalePendingAttempt(pending)) {
      await this.prisma.billingPaymentAttempt.update({
        where: { id: pending.id },
        data: {
          status: 'failed',
          failedAt: new Date(),
          failureCode: 'checkout_session_creation_timeout',
          failureMessage: 'Checkout session creation did not complete; please retry',
        },
      });
      return this.prisma.billingPaymentAttempt.create({
        data: {
          invoiceId: invoice.id,
          method: 'stripe',
          status: 'pending',
          amountMicros: invoice.totalMicros,
          currency: invoice.currency,
        },
      });
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
      await this.prisma.billingAccount.update({
        where: { id: account.id },
        data: { stripeCustomerId: customer.id },
      });
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

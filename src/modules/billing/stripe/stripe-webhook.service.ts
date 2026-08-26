import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import * as Stripe from 'stripe';
import { STRIPE_CLIENT, STRIPE_WEBHOOK_EVENT_TYPES } from './stripe.constants';

type Tx = Prisma.TransactionClient;
type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;

/** Forward-only payment outcome derived from a verified Stripe event. */
type PaymentTransition = 'succeeded' | 'failed' | null;

/**
 * Verifies and applies Stripe webhook events (Phase 3A).
 *
 * Payment facts are only ever confirmed by a signature-verified webhook — a
 * redirect is UX only. Events are atomically idempotent on the Stripe event
 * id: the `StripeWebhookEvent` row and the attempt/invoice updates commit in
 * one transaction, so a processing failure rolls back and Stripe retries
 * without leaving a "processed but business not updated" record.
 *
 * Only the explicit event set is processed; unknown events are recorded as
 * `ignored` and answered 2xx. State only moves forward: `succeeded` is never
 * regressed by a later failure/pending event, and `paidAt` is set at most
 * once and never cleared.
 */
@Injectable()
export class StripeWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
  ) {}

  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    const webhookSecret = this.config.get<string>('stripe.webhookSecret');
    if (!webhookSecret || !this.stripe) {
      throw new ServiceUnavailableException('Stripe webhooks are not configured');
    }
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException('Missing webhook payload');
    }
    if (!signature) {
      throw new BadRequestException('Missing Stripe signature');
    }

    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
    } catch {
      // Signature/parse failures are client errors: 400, no side effects.
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    if (!STRIPE_WEBHOOK_EVENT_TYPES.has(event.type)) {
      await this.recordIgnoredEvent(event);
      return;
    }

    await this.processKnownEvent(event);
  }

  /**
   * Records a verified-but-unhandled event as `ignored`. Duplicate delivery is
   * idempotent (unique event id).
   */
  private async recordIgnoredEvent(event: Stripe.Event): Promise<void> {
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          status: 'ignored',
          objectId: extractObjectId(event),
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) return;
      throw err;
    }
  }

  /**
   * Applies a known event inside one transaction: insert the webhook event row
   * (atomic idempotency), locate the local attempt, and apply the forward-only
   * transition. Any failure rolls the whole transaction back so Stripe retries.
   */
  private async processKnownEvent(event: Stripe.Event): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      try {
        await tx.stripeWebhookEvent.create({
          data: {
            stripeEventId: event.id,
            type: event.type,
            status: 'processed',
            objectId: extractObjectId(event),
          },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) return; // duplicate event id — already applied
        throw err;
      }

      const attempt = await this.findAttemptForEvent(tx, event);
      if (!attempt) {
        // Legitimate event with no local match: ignored, 2xx, no business change.
        await tx.stripeWebhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: 'ignored' },
        });
        return;
      }

      // Persist the actual PI/session id so later events for the same object
      // match by id (out-of-order delivery converges on the id lookup).
      await this.persistEventIds(tx, event, attempt);

      const transition = this.resolveTransition(event);
      if (transition === null) return; // pending/no-op — leave the attempt as-is

      if (transition === 'succeeded') {
        // Forward-only: an already-succeeded attempt is never rewritten.
        if (attempt.status !== 'succeeded') {
          await tx.billingPaymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: 'succeeded',
              succeededAt: new Date(),
              failedAt: null,
              failureCode: null,
              failureMessage: null,
            },
          });
        }
        // Set paidAt only once; never clear it.
        if (!attempt.invoice.paidAt) {
          await tx.billingInvoice.update({
            where: { id: attempt.invoiceId },
            data: { paidAt: new Date() },
          });
        }
        return;
      }

      // Failure: never regress a succeeded attempt, never clear paidAt.
      if (attempt.status === 'succeeded') return;
      const { code, message } = extractFailureDetails(event);
      await tx.billingPaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'failed',
          failedAt: new Date(),
          failureCode: code,
          failureMessage: message,
        },
      });
    });
  }

  /**
   * Locates the local attempt for an event, in order:
   * 1. Persisted object id (Checkout Session id / PaymentIntent id) — the
   *    normal case once the ids are stored on the attempt.
   * 2. Verified object metadata (`attemptId`, then `invoiceId`) — required for
   *    PaymentIntent-before-Checkout ordering, because the PaymentIntent id is
   *    usually not known at Checkout session creation and therefore not yet
   *    persisted. Metadata values are format-validated (UUID) before any query
   *    so malformed/malicious metadata never causes a meaningless 500.
   * 3. `client_reference_id` (Checkout sessions only) — the invoice id we set
   *    at session creation, as a final fallback.
   *
   * A verified event with no local match is handled by the caller as ignored
   * + 2xx.
   */
  private async findAttemptForEvent(
    tx: Tx,
    event: Stripe.Event,
  ): Promise<(PaymentAttemptRow & { invoice: { paidAt: Date | null } }) | null> {
    const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
    if (!object || typeof object.id !== 'string') return null;

    const include = { invoice: { select: { paidAt: true } } } as const;

    // 1. Persisted object id.
    if (event.type.startsWith('checkout.session')) {
      const bySession = await tx.billingPaymentAttempt.findFirst({
        where: { stripeCheckoutSessionId: object.id },
        include,
      });
      if (bySession) return bySession;
    }
    if (event.type.startsWith('payment_intent')) {
      const byPi = await tx.billingPaymentAttempt.findFirst({
        where: { stripePaymentIntentId: object.id },
        include,
      });
      if (byPi) return byPi;
    }

    // 2. Verified metadata (attemptId is authoritative; invoiceId is a
    //    fallback for the most recent pending attempt of that invoice).
    const metadata = extractSafeMetadata(object);
    if (metadata.attemptId) {
      const byAttempt = await tx.billingPaymentAttempt.findFirst({
        where: { id: metadata.attemptId },
        include,
      });
      if (byAttempt) return byAttempt;
    }
    if (metadata.invoiceId) {
      const byInvoice = await tx.billingPaymentAttempt.findFirst({
        where: { invoiceId: metadata.invoiceId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        include,
      });
      if (byInvoice) return byInvoice;
    }

    // 3. client_reference_id fallback (Checkout sessions only).
    if (event.type.startsWith('checkout.session')) {
      const referenceId = (object as Stripe.Checkout.Session).client_reference_id;
      if (isUuid(referenceId)) {
        const byReference = await tx.billingPaymentAttempt.findFirst({
          where: { invoiceId: referenceId, status: 'pending' },
          orderBy: { createdAt: 'desc' },
          include,
        });
        if (byReference) return byReference;
      }
    }

    return null;
  }

  /**
   * Persists the actual PaymentIntent/Checkout Session id on the attempt when
   * it was located via metadata/fallback rather than by the persisted id, so
   * later events for the same object resolve by id. Never overwrites a
   * different already-persisted id (that would violate the unique columns).
   */
  private async persistEventIds(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<void> {
    const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
    if (!object || typeof object.id !== 'string') return;

    if (event.type.startsWith('payment_intent') && attempt.stripePaymentIntentId === null) {
      await tx.billingPaymentAttempt.update({
        where: { id: attempt.id },
        data: { stripePaymentIntentId: object.id },
      });
    }
    if (event.type.startsWith('checkout.session') && attempt.stripeCheckoutSessionId === null) {
      await tx.billingPaymentAttempt.update({
        where: { id: attempt.id },
        data: { stripeCheckoutSessionId: object.id },
      });
    }
  }

  /**
   * Maps a verified event to a forward-only transition:
   * - `checkout.session.completed` only succeeds when `payment_status = paid`;
   *   an unpaid completion stays pending.
   * - async success/failure and `payment_intent.succeeded`/`payment_failed`
   *   map directly.
   * - `payment_intent.processing` stays pending.
   */
  private resolveTransition(event: Stripe.Event): PaymentTransition {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return session.payment_status === 'paid' ? 'succeeded' : null;
      }
      case 'checkout.session.async_payment_succeeded':
      case 'payment_intent.succeeded':
        return 'succeeded';
      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed':
        return 'failed';
      case 'payment_intent.processing':
        return null;
      default:
        return null;
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Canonical UUID shape (the local attempt/invoice id columns are UUIDs). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Safely extracts `attemptId`/`invoiceId` from a verified event object's
 * metadata. Values are format-validated (UUID) before any DB query so
 * malformed/malicious metadata never causes a meaningless 500 — it simply
 * yields no match and the event is recorded as ignored.
 */
function extractSafeMetadata(object: unknown): {
  attemptId: string | null;
  invoiceId: string | null;
} {
  const metadata = (object as { metadata?: unknown } | null)?.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return { attemptId: null, invoiceId: null };
  }
  const record = metadata as Record<string, unknown>;
  return {
    attemptId: isUuid(record.attemptId) ? record.attemptId : null,
    invoiceId: isUuid(record.invoiceId) ? record.invoiceId : null,
  };
}

/** Safe object id from a verified event payload (never the full payload). */
function extractObjectId(event: Stripe.Event): string | null {
  const object = event.data.object as { id?: unknown } | null;
  return typeof object?.id === 'string' && object.id.length > 0 ? object.id.slice(0, 255) : null;
}

/**
 * Extracts a safe, truncated failure code/message from a PaymentIntent's
 * `last_payment_error`. Checkout session objects do not carry it, so async
 * checkout failures are recorded without details (the failure itself is still
 * persisted). Never includes secrets or full payloads.
 */
function extractFailureDetails(event: Stripe.Event): {
  code: string | null;
  message: string | null;
} {
  const object = event.data.object as Stripe.PaymentIntent | Stripe.Checkout.Session;
  const lastError = (object as Stripe.PaymentIntent).last_payment_error;
  if (!lastError) return { code: null, message: null };
  const code = lastError.code ?? lastError.decline_code ?? null;
  const message = lastError.message ?? null;
  return {
    code: typeof code === 'string' && code.length > 0 ? code.slice(0, 80) : null,
    message: typeof message === 'string' && message.length > 0 ? message.slice(0, 500) : null,
  };
}

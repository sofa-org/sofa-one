import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/database/prisma.service';
import { getErrorText, sanitizeErrorMessage } from '../../../common/utils/sanitize';
import { SecurityEventService } from '../../security-events/security-event.service';
import { InvoiceSettlementService } from '../invoice-settlement.service';
import { canonicalBillingJson } from '../billing-json';
import { acquireBillingPeriodAdvisoryLock } from '../billing-period-lock';
import * as Stripe from 'stripe';
import {
  STRIPE_CHARGE_KIND_FIXED_FEE,
  STRIPE_CHARGE_KIND_FULL,
  STRIPE_CLIENT,
  STRIPE_DEFERRED_BACKOFF_MS,
  STRIPE_DEFERRED_MAX_RETRIES,
  STRIPE_RENEWAL_EVENT_TYPES,
  STRIPE_WEBHOOK_EVENT_TYPES,
} from './stripe.constants';

type Tx = Prisma.TransactionClient;
type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;
type SecurityEventInput = Parameters<SecurityEventService['record']>[0];

/** Forward-only payment outcome derived from a verified Stripe event. */
type PaymentTransition = 'succeeded' | 'failed' | null;

/** 1 cent = 10,000 microdollars. Stripe amounts are integer cents. */
const MICROS_PER_CENT = 10_000n;

/** Canonical UUID shape (the local attempt/invoice id columns are UUIDs). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runtime-safe shape of the Stripe object fields the renewal materializer and
 * provider-fact validation read. Stripe SDK types vary across API versions, so
 * every field is validated at runtime and never trusted blindly.
 */
interface StripeObjectLike {
  id?: unknown;
  subscription?: unknown;
  customer?: unknown;
  payment_intent?: unknown;
  invoice?: unknown;
  latest_invoice?: unknown;
  currency?: unknown;
  current_period_start?: unknown;
  current_period_end?: unknown;
  status?: unknown;
  period?: { start?: unknown; end?: unknown };
  amount_paid?: unknown;
  amount_total?: unknown;
  amount_received?: unknown;
  amount?: unknown;
  amount_subtotal?: unknown;
  total?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  payment_status?: unknown;
  mode?: unknown;
  lines?: { data?: Array<{ period?: { start?: unknown; end?: unknown } }> };
}

/**
 * Result of locating the local attempt for a verified event.
 * - `none`: no local match — the caller defers (renewal) or ignores (other).
 * - `conflict`: metadata identities disagree (e.g. attemptId and invoiceId
 *   point at different local records) — the caller records the event for
 *   manual review and never mutates anything.
 * - `attempt`: a uniquely attributable local attempt.
 */
type AttemptLookup =
  | { kind: 'attempt'; attempt: PaymentAttemptRow }
  | { kind: 'conflict' }
  | { kind: 'none' };

/**
 * Verifies and applies Stripe webhook events (Phase 3A + Gate 1 remediation).
 *
 * Payment facts are only ever confirmed by a signature-verified webhook — a
 * redirect is UX only. Raw-body signature verification (`handleWebhook`) is the
 * only live webhook entry; the worker re-applies verified events through the
 * internal `processEvent` path (never a controller/public route). Events are
 * atomically idempotent on the Stripe event id: the `StripeWebhookEvent` row
 * and the attempt/invoice updates commit in one transaction, so a processing
 * failure rolls back and Stripe retries without leaving a "processed but
 * business not updated" record.
 *
 * Renewal materialization: `invoice.created`/`invoice.finalized` deterministically
 * materialize the local renewal invoice + fixed-fee payment attempt exactly once
 * (unique Stripe invoice mapping) when the account, subscription, customer,
 * period, and currency can all be proven from the account mirror and validated
 * subscription metadata. Dynamic-overage invoices are never attached to a
 * fixed-fee attempt — they stay deferred/reviewable or route to the existing
 * one-time full-invoice payment.
 *
 * Provider facts are validated before any success transition: the event-specific
 * amount, currency, customer, and subscription (where applicable) must match the
 * local attempt/invoice; under/over/missing/wrong-currency/mismatched events are
 * rejected without settling.
 *
 * Audit intents are queued during the business transaction and emitted only
 * AFTER a successful commit — a business rollback never leaves a success audit,
 * and an audit/SIEM failure never rolls back a settlement.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
    private readonly settlementService: InvoiceSettlementService,
    @Optional() private readonly securityEvents?: SecurityEventService,
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

    try {
      await this.processKnownEvent(event);
    } catch (error) {
      // Preflight failures are deliberately converted to a durable bounded
      // review outcome at the HTTP boundary. The business transaction has
      // already rolled back; this row contains no provider payload and keeps
      // Stripe from receiving an unbounded silent acknowledgement.
      if (error instanceof ConflictException && isPreflightConflict(error)) {
        await this.recordPreflightReview(event);
        return;
      }
      throw error;
    }
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

  private async recordPreflightReview(event: Stripe.Event, lease?: { ownerId: string }): Promise<void> {
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          status: 'needs_review',
          objectId: extractObjectId(event),
          errorType: 'preflight_rejected',
          errorCode: 'identity_or_provider_mismatch',
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      await this.prisma.stripeWebhookEvent.updateMany({
        // Processed is terminal; a replay must never demote a committed event.
        where: {
          stripeEventId: event.id,
          status: 'deferred',
          ...(lease ? { retryOwnerId: lease.ownerId, retryLeaseExpiresAt: { gt: new Date() } } : {}),
        },
        data: { status: 'needs_review', errorType: 'preflight_rejected', errorCode: 'identity_or_provider_mismatch' },
      });
    }
  }

  /**
   * Applies a known event atomically. Audit intents are queued during the
   * transaction and emitted only after the commit succeeds, so a business
   * rollback never leaves a success audit and an audit/notification/SIEM
   * failure is isolated (never rolls back settlement).
   */
  private async processKnownEvent(event: Stripe.Event, lease?: { ownerId: string }): Promise<void> {
    const audits: SecurityEventInput[] = [];
    const queueAudit = (input: SecurityEventInput): void => {
      audits.push(input);
    };

    await this.prisma.$transaction(async (tx) => {
      // Dedupe is read-only. A new event must pass the complete identity/provider
      // preflight before it can create an event row or become an identity anchor.
      const existingEvent = await tx.stripeWebhookEvent.findUnique({
        where: { stripeEventId: event.id },
      });
      const terminalReplay = existingEvent && existingEvent.status !== 'deferred';
      if (lease) {
        const leaseValid = existingEvent?.status === 'deferred' &&
          existingEvent.retryOwnerId === lease.ownerId &&
          existingEvent.retryLeaseExpiresAt instanceof Date &&
          existingEvent.retryLeaseExpiresAt.getTime() > Date.now();
        if (!leaseValid) throw new ConflictException('Stripe deferred retry lease is missing or expired');
      }
      let createdFresh = !existingEvent;
      const preflightLookup = await this.findAttemptForEvent(tx, event);
      if (preflightLookup.kind === 'conflict') throw new ConflictException('Stripe event identity conflict');
      const preflightAttempt = preflightLookup.kind === 'attempt' ? preflightLookup.attempt : null;
      if (hasMalformedIdentityMetadata(event.data.object)) throw new ConflictException('Stripe event metadata is malformed');
      if (!preflightAttempt && !STRIPE_RENEWAL_EVENT_TYPES.has(event.type)) throw new ConflictException('Stripe event has no owned local identity');
      let renewalAccount: Prisma.BillingAccountGetPayload<Record<string, never>> | null = null;
      if (event.type.startsWith('customer.subscription') || event.type.startsWith('invoice')) {
        if ((event.type.startsWith('customer.subscription') || event.type === 'invoice.finalized') &&
          (!Number.isSafeInteger(event.created) || event.created <= 0)) {
          throw new ConflictException('Stripe event ordering timestamp is missing');
        }
        // Account resolution is deliberately read-only here. The mutating mirror
        // routine runs only after this proof and event-row insertion.
        renewalAccount = await this.resolveAccountForEvent(tx, event.data.object);
        if (!renewalAccount) throw new ConflictException('Stripe event account is unresolved');
      }
      if (
        preflightAttempt &&
        !(await this.validateAttemptIdentity(tx, event, preflightAttempt))
      ) {
        throw new ConflictException('Stripe attempt identity preflight failed');
      }
      if (preflightAttempt) {
        const providerFacts = await this.validateProviderFacts(tx, event, preflightAttempt);
        if (!providerFacts.ok) throw new ConflictException(`Stripe provider preflight failed: ${providerFacts.reason}`);
        if (event.type.startsWith('invoice') && preflightAttempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE &&
          !(await this.validateRenewalReplay(tx, event, preflightAttempt))) {
          throw new ConflictException('Stripe renewal replay proof failed');
        }
      } else if (event.type.startsWith('customer.subscription') || event.type.startsWith('invoice')) {
        const providerFacts = this.validateUnmatchedProviderFacts(event);
        if (!providerFacts.ok) throw new ConflictException(`Stripe provider preflight failed: ${providerFacts.reason}`);
      }
      if (terminalReplay) return;
      if (lease) {
        const heartbeat = await tx.stripeWebhookEvent.updateMany({
          where: {
            stripeEventId: event.id,
            status: 'deferred',
            retryOwnerId: lease.ownerId,
            retryLeaseExpiresAt: { gt: new Date() },
          },
          data: { retryLeaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000) },
        });
        if (heartbeat.count !== 1) throw new ConflictException('Stripe deferred retry lease was lost');
      }

      let attempt = preflightLookup.kind === 'attempt' ? preflightLookup.attempt : null;

      // True when THIS transaction inserted the webhook row; false when the row
      // already existed as deferred. All later status writes remain guarded.
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
        if (isUniqueConstraintError(err)) {
          const existing = await tx.stripeWebhookEvent.findUnique({
            where: { stripeEventId: event.id },
          });
          // A deferred event is re-processed by the worker once its local
          // renewal invoice exists; processed/ignored/needs_review events are
          // already applied and are idempotent no-ops.
          if (existing?.status !== 'deferred') return;
          createdFresh = false;
        } else {
          throw err;
        }
      }

      // Claim first, then serialize every period-affecting Stripe mutation
      // (not just invoice materialization) with BillingService's advisory-key
      // protocol. No provider call is made while this transaction is open.
      const lockAccount = renewalAccount ?? (attempt
        ? await this.getAttemptAccount(tx, attempt)
        : null);
      const lockPeriod = this.eventPeriod(event) ??
        (attempt ? await this.getAttemptPeriod(tx, attempt) : null) ??
        (renewalAccount?.stripeSubscriptionPeriodStart ? this.utcMonthStart(renewalAccount.stripeSubscriptionPeriodStart) : null);
      const periodAffecting = event.type.startsWith('payment_intent') ||
        event.type.startsWith('checkout.session') ||
        event.type.startsWith('customer.subscription') ||
        event.type.startsWith('invoice');
      if (periodAffecting && (!lockAccount || !lockPeriod)) {
        throw new ConflictException('Stripe event account-period scope is unresolved');
      }
      if (lockAccount && lockPeriod) {
        await acquireBillingPeriodAdvisoryLock(tx, lockAccount.id, lockPeriod);
      }

      const lookup = preflightLookup;

      // Identity conflict (e.g. metadata attemptId and invoiceId disagree):
      // never mutate anything — record the event for manual review.
      attempt = lookup.kind === 'attempt' ? lookup.attempt : attempt;
      // Claim the event before materialization. Materialization remains inside
      // this transaction, so a proof/CAS failure rolls back both the claim and
      // every invoice/attempt write instead of leaving an orphaned processed row.
      if (!attempt && (event.type === 'invoice.created' || event.type === 'invoice.finalized' || event.type === 'invoice.paid')) {
        attempt = await this.materializeRenewal(tx, event, queueAudit);
        if (!attempt) throw new ConflictException('Stripe renewal materialization preflight failed');
      }
      if (preflightAttempt && attempt && event.type === 'invoice.finalized' && attempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
        if (!(await this.validateRenewalReplay(tx, event, attempt))) {
          throw new ConflictException('Renewal finalization replay proof failed');
        }
        await this.promoteRenewalInvoice(tx, event, attempt);
        if (attempt.status === 'succeeded') {
          const settled = await this.settlementService.settleInvoice(tx, {
            id: attempt.id, invoiceId: attempt.invoiceId, method: 'stripe',
          });
          if (settled.settled) {
            await this.bootstrapActivePlan(tx, event, attempt);
            await this.persistEventIds(tx, event, attempt);
          }
        }
      }

      // The read-only account/mirror proof completed before event insertion.
      // Subscription lifecycle events may legitimately update the mirror even
      // when no payment attempt exists yet; this is still after preflight.
      if (event.type.startsWith('customer.subscription') && this.resolveTransition(event) === null) {
        const mirrorResult = await this.applySubscriptionMirror(tx, event);
        if (mirrorResult === 'unmatched') {
          await this.deferUnmatched(tx, event, queueAudit, createdFresh, lease);
          return;
        }
        if (mirrorResult === 'conflict') {
          await tx.stripeWebhookEvent.updateMany({
            where: { stripeEventId: event.id, ...(createdFresh ? { status: 'processed' } : { status: 'deferred' }), ...(lease ? { retryOwnerId: lease.ownerId, retryLeaseExpiresAt: { gt: new Date() } } : {}) },
            data: { status: 'needs_review', errorType: 'subscription_ownership_conflict', nextRetryAt: null },
          });
          return;
        }
      }

      if (!attempt) {
        // A renewal event with no local match yet (out-of-order delivery before
        // the renewal invoice/attempt exists) is deferred for bounded retry by
        // the worker — never silently ignored. Non-renewal orphans stay ignored.
        if (STRIPE_RENEWAL_EVENT_TYPES.has(event.type)) {
          await this.deferUnmatched(tx, event, queueAudit, createdFresh, lease);
          return;
        }
        // Legitimate event with no local match: ignored, 2xx, no business
        // change. Guarded to the row this transaction owns (or a deferred
        // replay), so a concurrent processed row is never demoted.
        const ignored = await tx.stripeWebhookEvent.updateMany({
          where: {
            stripeEventId: event.id,
            ...(createdFresh ? { status: 'processed' } : { status: 'deferred' }),
          },
          data: { status: 'ignored' },
        });
        if (ignored.count !== 1) throw new ConflictException('Stripe event claim was lost');
        return;
      }

      // A previously deferred event that now has a local match is processed.
      // The transition is guarded to `status = 'deferred'` (or our own fresh
      // row), so a stale deferred writer can never overwrite a row a
      // concurrent webhook already processed.
      if (createdFresh) {
        await tx.stripeWebhookEvent.update({
          where: { stripeEventId: event.id },
          data: { processedAt: new Date() },
        });
      } else {
        const processed = await tx.stripeWebhookEvent.updateMany({
          where: { stripeEventId: event.id, status: 'deferred', ...(lease ? { retryOwnerId: lease.ownerId, retryLeaseExpiresAt: { gt: new Date() } } : {}) },
          data: { status: 'processed', processedAt: new Date() },
        });
        if (processed.count !== 1) throw new ConflictException('Stripe deferred event claim was lost');
      }

      const transition = this.resolveTransition(event);
      if (transition === null) {
        // Safe non-payment lifecycle events may persist only the exact object
        // identity after the complete lookup/mirror preflight above.
        await this.persistEventIds(tx, event, attempt);
        await this.applySubscriptionBookkeeping(tx, event, attempt);
        return;
      }

      if (transition === 'succeeded') {
        // Provider facts were exhaustively validated before the event row and
        // all other writes above. Do not perform a second validation here: a
        // post-write validation failure would otherwise create a partial event
        // unless every caller remembered to throw and rollback.
        //
        // A Checkout completion is allowed to omit `subscription` (Stripe does
        // this for some subscription Checkout responses).  Bootstrap the plan
        // from the already-owned local fixed-fee invoice/attempt, never from
        // untrusted Checkout metadata.  This CAS is identity- and event-time
        // guarded, so it cannot replace a newer or different account plan.
        // Provider IDs, plan bootstrap, and subscription bookkeeping are deferred
        // until the exact settlement CAS has won. Preflight has already proven
        // these writes safe; doing them earlier would let a losing rail mutate
        // the active mirror.

        // Forward-only: an already-succeeded attempt is never rewritten.
        if (attempt.status !== 'pending' && attempt.status !== 'succeeded') {
          // Terminal failures/expiry/review are never resurrected by a later
          // provider success. The event is reviewed by the outer preflight
          // boundary, with no reassignment to another attempt.
          throw new ConflictException('Stripe success cannot advance a terminal attempt');
        }
        if (attempt.status === 'pending') {
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
        // Atomic first-rail-wins settlement: sets paidAt/paidVia/pointer once.
        // The CAS requires the attempt amount/currency to EXACTLY match the
        // invoice total, so a fixed-fee recurring charge can never mark a
        // dynamic invoice (with overage > fixed fee) as paid. A duplicate
        // replay of this attempt is an idempotent no-op, and a settlement
        // already won by another rail is never overwritten.
        const result = await this.settlementService.settleInvoice(tx, {
          id: attempt.id,
          invoiceId: attempt.invoiceId,
          method: 'stripe',
        });
        if (!result.settled) {
          // This Stripe success lost the settlement race. Only when the
          // invoice's settlement pointer clearly belongs to a different
          // attempt is the succeeded Stripe payment recorded as a
          // duplicate/unallocated review — mirroring the USDC losing path. A
          // precondition failure (invoice unsettled) or this attempt's own
          // idempotent replay never changes the attempt, and the winning
          // attempt/invoice is never touched. A fixed-fee renewal on an
          // invoice whose total exceeds the fixed charge stays unsettled
          // (the separately-payable dynamic overage remains), never a fake
          // paid — surfaced as deferred for the dashboard/operator.
          const settledInvoice = await tx.billingInvoice.findUnique({
            where: { id: attempt.invoiceId },
            select: { settlementAttemptId: true, totalMicros: true },
          });
          if (
            settledInvoice?.settlementAttemptId &&
            settledInvoice.settlementAttemptId !== attempt.id
          ) {
            await tx.billingPaymentAttempt.update({
              where: { id: attempt.id },
              data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
            });
            queueAudit({
              actorType: 'system',
              eventType: 'billing.stripe.duplicate_unallocated',
              riskLevel: 'high',
              result: 'denied',
              reason: 'duplicate_unallocated',
              metadata: { invoiceId: attempt.invoiceId, attemptId: attempt.id },
            });
          } else if (
            attempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE &&
            settledInvoice &&
            attempt.amountMicros < settledInvoice.totalMicros
          ) {
            await tx.billingPaymentAttempt.update({
              where: { id: attempt.id },
              data: { status: 'needs_review', reviewReason: 'fixed_fee_partial_balance' },
            });
            queueAudit({
              actorType: 'system',
              eventType: 'billing.stripe.fixed_fee_partial_balance',
              riskLevel: 'high',
              result: 'denied',
              reason: 'fixed_fee_partial_balance',
              metadata: { invoiceId: attempt.invoiceId, attemptId: attempt.id },
            });
          }
        } else {
          queueAudit({
            actorType: 'system',
            eventType: 'billing.stripe.invoice.settled',
            riskLevel: 'low',
            result: 'allowed',
            metadata: { invoiceId: attempt.invoiceId, attemptId: attempt.id },
          });
        }
        // A false settlement is a losing/open/dynamic rail. It must not bind
        // provider identities or mutate the active subscription mirror. An
        // already-winning replay has already persisted these identities; the
        // locked settlement service is the sole authority for this boundary.
        if (!result.settled) return;
        try {
          await this.bootstrapActivePlan(tx, event, attempt);
          await this.persistEventIds(tx, event, attempt);
          await this.applySubscriptionBookkeeping(tx, event, attempt);
        } catch {
          // Settlement is authoritative and must not be rolled back because a
          // nonessential post-settlement identity/mirror CAS lost a race. Keep
          // the event durably reviewable, guarded so a concurrent terminal
          // processor can never be demoted.
          const reviewed = await tx.stripeWebhookEvent.updateMany({
            where: {
              stripeEventId: event.id,
              status: 'processed',
              ...(lease ? { retryOwnerId: lease.ownerId, retryLeaseExpiresAt: { gt: new Date() } } : {}),
            },
            data: { status: 'needs_review', errorType: 'post_settlement_identity_conflict', nextRetryAt: null },
          });
          if (reviewed.count === 1) {
            queueAudit({
              actorType: 'system',
              eventType: 'billing.stripe.post_settlement_review',
              riskLevel: 'high',
              result: 'denied',
              reason: 'post_settlement_identity_conflict',
              metadata: { invoiceId: attempt.invoiceId, attemptId: attempt.id },
            });
          }
          return;
        }
        return;
      }

      // Failure: only a pending attempt may transition to failed. The CAS
      // predicate (status = 'pending') makes the transition atomic under Read
      // Committed — a concurrent success that already committed can never be
      // regressed, and a stale read of a pending attempt cannot overwrite a
      // succeeded/confirming attempt or the attempt that settled the invoice.
      if (attempt.status === 'succeeded') return;
      const { code, message } = extractFailureDetails(event);
      await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, status: 'pending' },
        data: {
          status: 'failed',
          failedAt: new Date(),
          failureCode: code,
          failureMessage: message,
        },
      });
      queueAudit({
        actorType: 'system',
        eventType: 'billing.stripe.payment_failed',
        riskLevel: 'high',
        result: 'denied',
        reason: code ?? 'payment_failed',
        metadata: { invoiceId: attempt.invoiceId, attemptId: attempt.id },
      });
    });

    // Emit queued audits only after the business transaction committed.
    // Notification/SIEM work is never awaited inside the business transaction;
    // an audit/export failure is isolated and never rolls back settlement.
    for (const input of audits) {
      await this.audit(input);
    }
  }

  /**
   * Public entry for the worker's deferred-retry path. Re-applies a verified
   * Stripe event (re-fetched by the worker) through the same atomic
   * idempotent pipeline as a live webhook. The event must already be
   * signature-verified/trusted (retrieved from Stripe by id). This is an
   * internal trusted path — never a controller/public route.
   */
  async processEvent(event: Stripe.Event, lease?: { ownerId: string }): Promise<void> {
    try {
      await this.processKnownEvent(event, lease);
    } catch (error) {
      if (error instanceof ConflictException && isPreflightConflict(error)) {
        await this.recordPreflightReview(event, lease);
        return;
      }
      throw error;
    }
  }

  /**
   * Sanitized audit for material Stripe transitions. Never includes Stripe
   * payloads, payment data, RPC URLs, or secrets — only safe identifiers.
   * Audit/notification/SIEM failures are isolated and never affect the webhook
   * outcome. Called only after the business transaction commits.
   */
  private async audit(input: SecurityEventInput): Promise<void> {
    if (!this.securityEvents) return;
    try {
      await this.securityEvents.record({
        actorType: input.actorType ?? 'system',
        eventType: input.eventType,
        userId: input.userId ?? null,
        riskLevel: input.riskLevel ?? 'low',
        result: input.result ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? undefined,
      });
    } catch (error) {
      this.logger.error(
        `Stripe audit write failed for ${input.eventType}: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
    }
  }

  /**
   * Marks a verified renewal event with no local match as `deferred` with a
   * bounded retry schedule. The worker re-fetches it from Stripe and
   * re-processes once the local renewal invoice/attempt exists. Retries are
   * bounded; exceeding the max marks the event for manual review. Only safe
   * identifiers are stored — never the full payload.
   *
   * The status write is guarded: a fresh row (created by THIS transaction as
   * 'processed') is moved to deferred/needs_review; a replayed deferred row is
   * only updated while it is STILL 'deferred'. A concurrent webhook that
   * already processed/settled the event can never be overwritten by a stale
   * deferred or needs_review update from this path.
   */
  private async deferUnmatched(
    tx: Tx,
    event: Stripe.Event,
    queueAudit: (i: SecurityEventInput) => void,
    createdFresh: boolean,
    lease?: { ownerId: string },
  ): Promise<void> {
    const existing = await tx.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
      select: { retryCount: true, nextRetryAt: true, retryOwnerId: true, retryLeaseExpiresAt: true },
    });
    const retryCount = (existing?.retryCount ?? 0) + 1;
    const exhausted = retryCount > STRIPE_DEFERRED_MAX_RETRIES;
    const accountUserId = extractAccountUserId(event);
    const result = await tx.stripeWebhookEvent.updateMany({
      where: {
        stripeEventId: event.id,
        ...(createdFresh ? { status: 'processed' } : { status: 'deferred' }),
        retryCount: existing?.retryCount ?? null,
        nextRetryAt: existing?.nextRetryAt ?? null,
        ...(lease ? { retryOwnerId: lease.ownerId, retryLeaseExpiresAt: { gt: new Date() } } : {}),
      },
      data: exhausted
        ? {
            status: 'needs_review',
            retryCount,
            nextRetryAt: null,
            errorType: 'deferred_retry_exhausted',
            accountUserId,
          }
        : {
            status: 'deferred',
            retryCount,
            nextRetryAt: new Date(Date.now() + STRIPE_DEFERRED_BACKOFF_MS * 2 ** retryCount),
            errorType: 'unmatched_renewal_invoice',
            accountUserId,
          },
    });
    if (result.count === 0) {
      // A concurrent webhook processed the event before this write — never
      // demote it. The audit below is suppressed to avoid a false "deferred"
      // audit for an event that actually succeeded.
      this.logger.warn(
        `Stripe event ${event.id} was already processed concurrently; skipping deferral`,
      );
      return;
    }
    queueAudit({
      actorType: 'system',
      eventType: exhausted
        ? 'billing.stripe.renewal_deferred_exhausted'
        : 'billing.stripe.renewal_deferred',
      userId: accountUserId ?? undefined,
      riskLevel: exhausted ? 'high' : 'medium',
      result: 'denied',
      reason: exhausted ? 'deferred_retry_exhausted' : 'unmatched_renewal_invoice',
      metadata: { stripeEventId: event.id, type: event.type, retryCount },
    });
  }

  // ── Subscription mirror (event-order safe, account-resolvable) ─────────────

  /**
   * Updates the account's active-subscription mirror from subscription/invoice
   * events. Unlike the attempt-bound path, this resolves the account from
   * validated metadata (userId) or the subscription/customer mirror directly —
   * so subscription created/updated/deleted bookkeeping works even before any
   * local renewal attempt exists. The update is forward/event-order safe: an
   * older event can never regress a newer mirror state.
   *
   * Identity guards: an EXISTING account binding can never be replaced by a
   * different subscription or customer. If the account's mirror already binds
   * a subscription/customer and the event carries a DIFFERENT id, the write is
   * skipped entirely (the caller defers/manual-review); only the exact same id
   * (or a first binding on a null mirror) may be written. Metadata `userId`
   * alone is never trusted to bind/overwrite (resolution already requires
   * exact mirror ownership).
   */
  private async applySubscriptionMirror(
    tx: Tx,
    event: Stripe.Event,
  ): Promise<'ok' | 'unmatched' | 'conflict'> {
    const raw = event.data.object as StripeObjectLike;
    const object = event.data.object as Stripe.Subscription | Stripe.Invoice;
    if (!object || typeof raw.id !== 'string') return 'unmatched';

    const account = await this.resolveAccountForEvent(tx, object);
    if (!account) return 'unmatched'; // caller defers/ignores

    const eventSubscriptionId =
      event.type.startsWith('customer.subscription')
        ? (typeof raw.id === 'string' ? raw.id : null)
        : readProviderId(raw.subscription, 'subscription');
    const eventCustomerId = readProviderId(raw.customer, 'customer');

    // Exact identity guards: never replace an existing binding with a
    // different subscription/customer. A mismatch is deferred/manual-review —
    // the mirror is left untouched.
    if (
      account.stripeSubscriptionId &&
      eventSubscriptionId &&
      eventSubscriptionId !== account.stripeSubscriptionId
    ) {
      this.logger.warn(
        `Stripe subscription event ${event.id} refers to subscription ${eventSubscriptionId} but account ${account.id} is bound to ${account.stripeSubscriptionId}; skipping mirror update`,
      );
      return 'conflict';
    }
    if (
      account.stripeCustomerId &&
      eventCustomerId &&
      eventCustomerId !== account.stripeCustomerId
    ) {
      this.logger.warn(
        `Stripe event ${event.id} refers to customer ${eventCustomerId} but account ${account.id} is bound to ${account.stripeCustomerId}; skipping mirror update`,
      );
      return 'conflict';
    }

    const eventCreated = Number.isSafeInteger(event.created) && event.created > 0 ? event.created : null;
    if (eventCreated === null) return 'conflict';
    const current = account.stripeSubscriptionUpdatedAt
      ? Math.floor(account.stripeSubscriptionUpdatedAt.getTime() / 1000)
      : null;
    // Stripe timestamps have second precision. Use the event id as the
    // deterministic tie-breaker instead of arrival/server time.
    if (current !== null && eventCreated < current) return 'ok';
    if (current !== null && eventCreated === current && account.stripeSubscriptionEventId && event.id <= account.stripeSubscriptionEventId) return 'ok';

    const data: Prisma.BillingAccountUncheckedUpdateInput = {
      stripeSubscriptionUpdatedAt: new Date(eventCreated * 1000),
      stripeSubscriptionEventId: event.id,
    };
    const eventTime = data.stripeSubscriptionUpdatedAt as Date;

    if (event.type === 'customer.subscription.created') {
      data.stripeSubscriptionId = raw.id as string;
      data.stripeSubscriptionStatus =
        typeof raw.status === 'string' ? raw.status : 'active';
      if (typeof raw.current_period_start === 'number') {
        data.stripeSubscriptionPeriodStart = new Date(raw.current_period_start * 1000);
      }
      if (typeof raw.current_period_end === 'number') {
        data.stripeSubscriptionPeriodEnd = new Date(raw.current_period_end * 1000);
      }
    } else if (event.type === 'customer.subscription.updated') {
      data.stripeSubscriptionId = raw.id as string;
      data.stripeSubscriptionStatus =
        typeof raw.status === 'string' ? raw.status : 'active';
      if (typeof raw.current_period_start === 'number') {
        data.stripeSubscriptionPeriodStart = new Date(raw.current_period_start * 1000);
      }
      if (typeof raw.current_period_end === 'number') {
        data.stripeSubscriptionPeriodEnd = new Date(raw.current_period_end * 1000);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      // Only cancel the mirror when the deleted subscription IS the bound one
      // (or the account has no binding yet — a defensive no-op for null).
      if (account.stripeSubscriptionId && eventSubscriptionId !== account.stripeSubscriptionId) {
        return 'conflict';
      }
      data.stripeSubscriptionStatus = 'canceled';
      if (typeof raw.id === 'string') data.stripeSubscriptionId = raw.id;
    } else if (event.type === 'invoice.created' || event.type === 'invoice.finalized') {
      if (eventSubscriptionId) data.stripeSubscriptionId = eventSubscriptionId;
      // Never fabricate a customer binding: only fill when the account has no
      // customer yet AND the customer is the account's own (guarded above).
      if (eventCustomerId && !account.stripeCustomerId) {
        data.stripeCustomerId = eventCustomerId;
      }
    }

    const guarded = await tx.billingAccount.updateMany({
      where: {
        id: account.id,
        ...(account.stripeSubscriptionId
          ? { stripeSubscriptionId: account.stripeSubscriptionId }
          : { stripeSubscriptionId: null }),
        ...(account.stripeCustomerId
          ? { stripeCustomerId: account.stripeCustomerId }
          : { stripeCustomerId: null }),
        OR: [
          { stripeSubscriptionUpdatedAt: null },
          { stripeSubscriptionUpdatedAt: { lt: eventTime } },
          { AND: [{ stripeSubscriptionUpdatedAt: eventTime }, { stripeSubscriptionEventId: { lt: event.id } }] },
        ],
      },
      data,
    });
    if (guarded.count === 0) return 'conflict';
    return 'ok';
  }

  /**
   * Mirrors the account's active subscription state from subscription/invoice
   * events (never settles). Only updates the mirror when a matching local
   * attempt resolves to an account, so orphaned events remain deferred.
   */
  private async applySubscriptionBookkeeping(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<void> {
    const object = event.data.object as
      | Stripe.Subscription
      | Stripe.Invoice
      | Stripe.Checkout.Session
      | Stripe.PaymentIntent;
    if (!object || typeof object.id !== 'string') return;

    const rawObject = object as unknown as { subscription?: unknown };
    const subscriptionId =
      attempt.stripeSubscriptionId ??
      (event.type.startsWith('customer.subscription')
        ? (object as Stripe.Subscription).id
        : typeof rawObject.subscription === 'string'
          ? (rawObject.subscription as string)
          : null);
    const subscription =
      subscriptionId && typeof subscriptionId === 'string' ? subscriptionId : null;

    const invoice = await tx.billingInvoice.findUnique({
      where: { id: attempt.invoiceId },
      select: { billingAccountId: true },
    });
    if (!invoice) return;

    if (subscription) {
      const updated = await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: subscription }] },
        data: { stripeSubscriptionId: subscription },
      });
      if (updated.count !== 1) throw new ConflictException('Stripe subscription bookkeeping CAS lost');
    }
  }

  /**
   * Resolves the billing account for an event's object with STRICT ownership
   * proof. Metadata `userId` is NEVER trusted alone to bind or overwrite a
   * subscription: it is only a hint, accepted when the event's customer and
   * subscription exactly match the account's own Stripe mirror. Resolution
   * order (strongest first):
   *   1. account mirror by exact subscription id (customer must also match
   *      when the event and mirror both carry one);
   *   2. account mirror by exact customer id;
   *   3. metadata userId hint — accepted ONLY when the account's mirror has a
   *      customer/subscription and they match the event exactly. An account
   *      with no Stripe mirror at all is never bound from metadata alone.
   * Returns null when the account cannot be proven (the caller defers/manual
   * review — never silently binds).
   */
  private async resolveAccountForEvent(
    tx: Tx,
    object: unknown,
  ): Promise<Prisma.BillingAccountGetPayload<Record<string, never>> | null> {
    const raw = object as { subscription?: unknown; customer?: unknown };
    const subscriptionId = readProviderId(raw.subscription, 'subscription');
    const customerId = readProviderId(raw.customer, 'customer');
    const metadata = extractSafeMetadata(object);
    const metadataAccountId = readMetadataString(object, 'billingAccountId');

    const ownsEvent = (account: Prisma.BillingAccountGetPayload<Record<string, never>>): boolean => {
      if (metadata.userId && account.userId !== metadata.userId) return false;
      if (metadataAccountId && account.id !== metadataAccountId) return false;
      if (customerId && account.stripeCustomerId && customerId !== account.stripeCustomerId) return false;
      if (subscriptionId && account.stripeSubscriptionId && subscriptionId !== account.stripeSubscriptionId) return false;
      // A null local subscription is a valid bootstrap state. The proven
      // customer/subscription pair is claimed later with an atomic null-or-same
      // CAS; only a different existing identity is rejected above.
      return true;
    };

    // 1. Strongest: the account mirror by exact subscription id.
    if (subscriptionId) {
      const bySubscription = await tx.billingAccount.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
      });
      if (bySubscription) {
        // Customer must also agree when both the event and the mirror carry one.
        return ownsEvent(bySubscription) ? bySubscription : null;
      }
      // The subscription hint was not owned by an account. A customer lookup
      // is not an authority that may bypass this conflict.
      if (customerId) {
        const byCustomer = await tx.billingAccount.findFirst({ where: { stripeCustomerId: customerId } });
        return byCustomer && ownsEvent(byCustomer) ? byCustomer : null;
      }
    }

    // 2. Account mirror by exact customer id.
    if (customerId) {
      const byCustomer = await tx.billingAccount.findFirst({
        where: { stripeCustomerId: customerId },
      });
      if (byCustomer && ownsEvent(byCustomer)) return byCustomer;
    }

    // 3. Metadata userId is only a hint: it can never bind/overwrite a
    //    subscription or customer unless the account's mirror already proves
    //    the exact customer/subscription ownership.
    if (metadata.userId) {
      const byUser = await tx.billingAccount.findUnique({ where: { userId: metadata.userId } });
      if (byUser) {
        if (!ownsEvent(byUser)) return null;
        // No mirror proof at all — metadata alone must never bind a fresh
        // account to an event's subscription/customer.
        if (!byUser.stripeCustomerId && !byUser.stripeSubscriptionId) return null;
        return byUser;
      }
    }

    // Subscription Checkout may legitimately return no subscription id. When
    // the first subscription lifecycle event arrives, metadata is only a
    // locator: bind it to an account only through the exact Stripe customer
    // and an already-owned local fixed-fee attempt/invoice.
    if (subscriptionId && customerId && metadata.attemptId) {
      const attempt = await tx.billingPaymentAttempt.findFirst({
        where: { id: metadata.attemptId, method: 'stripe', stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE },
      });
      if (attempt) {
        const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
        if (invoice?.planVersionId) {
          const byCustomer = await tx.billingAccount.findFirst({ where: { id: invoice.billingAccountId, stripeCustomerId: customerId } });
          if (byCustomer && attempt.stripeSubscriptionId === null && invoice.currency === 'USD' && invoice.monthlyFeeMicros === attempt.amountMicros) {
            return byCustomer;
          }
        }
      }
    }
    return null;
  }

  // ── Deterministic renewal materialization ──────────────────────────────────

  private async validateRenewalReplay(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<boolean> {
    if (attempt.stripeChargeKind !== STRIPE_CHARGE_KIND_FIXED_FEE) return false;
    const raw = event.data.object as StripeObjectLike;
    const customer = readProviderId(raw.customer, 'customer');
    if (!customer) return false;
    const subscription = readProviderId(raw.subscription, 'subscription');
    if (!customer || !subscription || raw.currency !== 'usd' && raw.currency !== 'USD') return false;
    if (attempt.stripeSubscriptionId !== subscription) return false;
    const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId }, include: { lines: true } });
    if (!invoice || invoice.currency !== 'USD' || invoice.planVersionId === null) return false;
    if (typeof invoice.snapshotHash !== 'string' || !/^[0-9a-f]{64}$/i.test(invoice.snapshotHash)) return false;
    const account = await tx.billingAccount.findUnique({ where: { id: invoice.billingAccountId } });
    if (!account || account.stripeCustomerId !== customer || account.stripeSubscriptionId !== subscription) return false;
    const period = event.type.startsWith('invoice') ? this.invoicePeriod(raw) : (raw.period ?? raw.lines?.data?.[0]?.period);
    if (!period || typeof period.start !== 'number' || typeof period.end !== 'number') return false;
    const start = this.utcMonthStart(new Date(period.start * 1000));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    if (period.start * 1000 !== start.getTime() || period.end * 1000 !== end.getTime()) return false;
    if (invoice.periodStart.getTime() !== start.getTime() || invoice.periodEnd.getTime() !== end.getTime()) return false;
    if (invoice.status !== 'open' && invoice.status !== 'finalized') return false;
    if (invoice.totalMicros !== attempt.amountMicros || invoice.monthlyFeeMicros !== attempt.amountMicros) return false;
    if (
      invoice.grossOutboundMicros !== 0n ||
      invoice.billableOutboundMicros !== 0n ||
      invoice.outboundOverageMicros !== 0n ||
      invoice.apiOverageMicros !== 0n ||
      invoice.walletOverageMicros !== 0n
    ) return false;
    const plan = await tx.billingPlanVersion.findUnique({ where: { id: invoice.planVersionId } });
    if (!plan || plan.monthlyFeeMicros !== attempt.amountMicros) return false;
    const snapshot = invoice.snapshotJson as {
      version?: unknown; planVersionId?: unknown; fixedFeeMicros?: unknown; period?: unknown;
      renewal?: unknown; plan?: { code?: unknown; name?: unknown; monthlyFeeMicros?: unknown };
      amounts?: { monthlyFeeMicros?: unknown; totalMicros?: unknown };
    } | null;
    if (!snapshot || snapshot.planVersionId !== invoice.planVersionId) return false;
    const datePeriod = start.toISOString().slice(0, 10);
    const monthPeriod = start.toISOString().slice(0, 7);
    const syntheticRenewal = snapshot.renewal === true &&
      snapshot.fixedFeeMicros === attempt.amountMicros.toString() && snapshot.period === datePeriod;
    const canonicalWorkerSnapshot = snapshot.version === 1 && snapshot.period === monthPeriod &&
      snapshot.plan?.code === plan.code && snapshot.plan?.name === plan.name &&
      snapshot.plan?.monthlyFeeMicros === microsToDecimal(plan.monthlyFeeMicros) &&
      snapshot.amounts?.monthlyFeeMicros === microsToDecimal(attempt.amountMicros) &&
      snapshot.amounts?.totalMicros === microsToDecimal(attempt.amountMicros);
    if (!syntheticRenewal && !canonicalWorkerSnapshot) return false;
    const recomputedSnapshotHash = createHash('sha256').update(canonicalBillingJson(snapshot)).digest('hex');
    if (recomputedSnapshotHash !== invoice.snapshotHash) return false;
    if (invoice.paidAt !== null || invoice.settlementAttemptId !== null) return false;
    const lines = (invoice as typeof invoice & { lines?: Array<{ lineType: string; amountMicros: bigint }> }).lines;
    if (!Array.isArray(lines) || lines.length !== 1 || lines[0].lineType !== 'monthly_fee' || lines[0].amountMicros !== attempt.amountMicros || (lines[0] as any).quantity !== 1n) return false;
    return true;
  }

  /**
   * Materializes the local renewal invoice + fixed-fee payment attempt for a
   * verified `invoice.created`/`invoice.finalized` event exactly once (the
   * attempt's unique `stripeInvoiceId` mapping). Resolution is deterministic
   * and fail-closed:
   * - the account must be provable from validated metadata or the account mirror;
   * - the event's subscription and customer must match the account mirror;
   * - the currency must be USD and the fixed fee must be finite/positive and
   *   cent-aligned from the account's active subscription plan version;
   * - the renewal period maps to a local UTC-month invoice that is either
   *   absent (created here as a fixed-only invoice) or an open invoice whose
   *   total exactly equals the fixed fee. A dynamic-overage invoice is never
   *   attached to a fixed-fee attempt — the event stays deferred/reviewable.
   *
   * Returns null when the event cannot be materialized safely (the caller
   * defers it for bounded retry / manual review — never silently ignored).
   */
  private async materializeRenewal(
    tx: Tx,
    event: Stripe.Event,
    queueAudit: (i: SecurityEventInput) => void,
  ): Promise<PaymentAttemptRow | null> {
    const rawObject = event.data.object as StripeObjectLike;
    const object = event.data.object as Stripe.Invoice;
    const stripeInvoiceId = rawObject?.id;
    if (!rawObject || typeof stripeInvoiceId !== 'string') return null;

    // Exact-once by the unique Stripe invoice mapping.
    const existingAttempt = await tx.billingPaymentAttempt.findFirst({
      where: { stripeInvoiceId, method: 'stripe' },
    });
    if (existingAttempt) {
      // A unique provider id is an idempotency hint, not proof of ownership.
      // Revalidate the replay's stable identity and accounting facts before
      // returning the existing local attempt.
      return (await this.validateRenewalReplay(tx, event, existingAttempt))
        ? existingAttempt
        : null;
    }

    const account = await this.resolveAccountForEvent(tx, object);
    if (!account) return null;

    const subscriptionId = readProviderId(rawObject.subscription, 'subscription');
    const customerId = readProviderId(rawObject.customer, 'customer');
    const currency = typeof rawObject.currency === 'string' ? rawObject.currency.toUpperCase() : null;
    if (!subscriptionId || !customerId || currency !== 'USD') return null;

    // Ownership: the event's customer/subscription must match the account's
    // Stripe mirror when the mirror exists; an unproven mirror is deferred.
    if (account.stripeCustomerId && customerId !== account.stripeCustomerId) return null;
    if (account.stripeSubscriptionId && subscriptionId !== account.stripeSubscriptionId) return null;
    if (!account.stripeSubscriptionId) return null;
    if (account.stripeSubscriptionStatus === 'canceled') return null;
    if (!account.activeSubscriptionPlanVersionId) return null;

    // Period: the Stripe invoice period must be exactly one supported UTC
    // month (start = a UTC month boundary, end = the next UTC month boundary).
    // A mid-month or odd-length period is never forced into a local month —
    // the event is deferred instead.
    const period = this.invoicePeriod(rawObject);
    if (
      !period ||
      typeof period.start !== 'number' ||
      typeof period.end !== 'number' ||
      !Number.isFinite(period.start) ||
      !Number.isFinite(period.end) ||
      period.start >= period.end
    ) {
      return null;
    }
    const periodStartMs = period.start * 1000;
    const monthStart = this.utcMonthStart(new Date(periodStartMs));
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
    // Exact UTC month boundary: the Stripe period must align 1:1 with the
    // local UTC month it maps to, never a partial/slopped interval.
    if (periodStartMs !== monthStart.getTime() || period.end * 1000 !== monthEnd.getTime()) {
      return null;
    }

    // Fixed fee from the proven active subscription plan version. Never derive
    // an amount from untrusted event metadata.
    const plan = await tx.billingPlanVersion.findUnique({
      where: { id: account.activeSubscriptionPlanVersionId },
    });
    const fixedFee = plan?.monthlyFeeMicros ?? null;
    if (!plan || fixedFee === null || fixedFee <= 0n || fixedFee % MICROS_PER_CENT !== 0n) {
      return null; // cannot prove a fixed-fee renewal — fail closed
    }

    // Provider amount/currency: the event's own total (cents) must equal the
    // fixed fee exactly. Under/over/missing amounts are deferred, never
    // materialized into a local invoice/attempt.
    const amountCents = this.invoiceAmount(rawObject, event.type);
    if (amountCents === null || amountCents <= 0) return null;
    if (BigInt(amountCents) * MICROS_PER_CENT !== fixedFee) return null;

    // Find or create the local renewal invoice (unique account+period).
    let invoice: any = await tx.billingInvoice.findUnique({
      where: {
        billingAccountId_periodStart: { billingAccountId: account.id, periodStart: monthStart },
      },
      include: { lines: true },
    });
    if (invoice) {
      // Immutable finalized invoices may receive a late, exact fixed-fee
      // attempt mapping. Their snapshot/amount/lines are never changed.
      if (invoice.status !== 'open' && invoice.status !== 'finalized') return null;
      if (invoice.totalMicros !== fixedFee) return null;
      if (invoice.stripeInvoiceId !== null && invoice.stripeInvoiceId !== stripeInvoiceId) {
        return null;
      }
      if (!(await this.validateLocalRenewalInvoice(tx, invoice, plan, monthStart, monthEnd, fixedFee))) return null;
      // Bind the Stripe invoice id to this local invoice ATOMICALLY when absent
      // (CAS on `stripeInvoiceId = null`), so repeated/retried events reuse the
      // SAME local invoice and no two invoices can ever carry the same Stripe
      // invoice id. A lost CAS means a concurrent writer bound it elsewhere.
      if (invoice.stripeInvoiceId === null) {
        const claimed = await tx.billingInvoice.updateMany({
          where: { id: invoice.id, stripeInvoiceId: null },
          data: { stripeInvoiceId },
        });
        if (claimed.count === 0) {
          const current = await tx.billingInvoice.findUnique({ where: { id: invoice.id } });
          if (!current || current.stripeInvoiceId !== stripeInvoiceId) return null; // defer
        }
      }
      // Provider invoice.finalized is identity/payment evidence only. Local
      // billing stays open until BillingService proves the UTC period ended.
    } else {
      const snapshot = {
        renewal: true,
        planVersionId: plan.id,
        stripeInvoiceId,
        period: monthStart.toISOString().slice(0, 10),
        planCode: plan.code,
        planName: plan.name,
        fixedFeeMicros: fixedFee.toString(),
      };
      const snapshotHash = createHash('sha256')
        .update(canonicalBillingJson(snapshot))
        .digest('hex');
      try {
        invoice = await tx.billingInvoice.create({
          data: {
            billingAccountId: account.id,
            planVersionId: plan.id,
            periodStart: monthStart,
            periodEnd: monthEnd,
            status: 'open',
            currency: 'USD',
            grossOutboundMicros: 0n,
            includedOutboundMicros: plan.includedOutboundMicros,
            billableOutboundMicros: 0n,
            apiCalls: 0n,
            includedApiCalls: plan.includedApiCalls,
            activeWallets: 0,
            includedWallets: plan.includedWallets,
            monthlyFeeMicros: fixedFee,
            outboundOverageMicros: 0n,
            apiOverageMicros: 0n,
            walletOverageMicros: 0n,
            totalMicros: fixedFee,
            snapshotJson: snapshot as Prisma.InputJsonValue,
            snapshotHash,
            stripeInvoiceId,
          },
        });
        await tx.billingInvoiceLine.createMany({
          data: [
            {
              invoiceId: invoice.id,
              lineType: 'monthly_fee',
              description: `Monthly fee — ${plan.name}`,
              quantity: 1n,
              amountMicros: fixedFee,
            },
          ],
        });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const winner = await tx.billingInvoice.findUnique({
          where: {
            billingAccountId_periodStart: {
              billingAccountId: account.id,
              periodStart: monthStart,
            },
          },
        });
        if (
          !winner ||
          (winner.status !== 'open' && winner.status !== 'finalized') ||
          winner.totalMicros !== fixedFee
        ) return null;
        // The winner must also be bound to this exact Stripe invoice id (or be
        // bound atomically now) before an attempt is attached to it.
        if (winner.stripeInvoiceId !== null && winner.stripeInvoiceId !== stripeInvoiceId) {
          return null;
        }
        if (winner.stripeInvoiceId === null) {
          const claimed = await tx.billingInvoice.updateMany({
            where: { id: winner.id, stripeInvoiceId: null },
            data: { stripeInvoiceId },
          });
          if (claimed.count === 0) {
            const current = await tx.billingInvoice.findUnique({ where: { id: winner.id } });
            if (!current || current.stripeInvoiceId !== stripeInvoiceId) return null;
          }
        }
        invoice = winner;
      }
    }

    // Fixed-fee payment attempt exactly once (unique stripeInvoiceId).
    try {
      const attempt = await tx.billingPaymentAttempt.create({
        data: {
          invoiceId: invoice.id,
          method: 'stripe',
          status: 'pending',
          amountMicros: fixedFee,
          currency: 'USD',
          stripeInvoiceId,
          stripeSubscriptionId: subscriptionId,
          stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE,
        },
      });
      queueAudit({
        actorType: 'system',
        eventType: 'billing.stripe.renewal_materialized',
        riskLevel: 'low',
        result: 'allowed',
        metadata: { invoiceId: invoice.id, stripeInvoiceId, subscriptionId },
      });
      return attempt;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const winner = await tx.billingPaymentAttempt.findFirst({
        where: { stripeInvoiceId, method: 'stripe' },
      });
      if (!winner || !(await this.validateRenewalReplay(tx, event, winner))) return null;
      return winner;
    }
  }

  private async validateLocalRenewalInvoice(
    tx: Tx,
    invoice: any,
    plan: any,
    start: Date,
    end: Date,
    fixedFee: bigint,
  ): Promise<boolean> {
    if (invoice.currency !== 'USD' || invoice.periodStart.getTime() !== start.getTime() ||
      invoice.periodEnd.getTime() !== end.getTime() || invoice.totalMicros !== fixedFee ||
      invoice.monthlyFeeMicros !== fixedFee || invoice.paidAt !== null || invoice.settlementAttemptId !== null ||
      !['open', 'finalized'].includes(invoice.status) || invoice.planVersionId !== plan.id) return false;
    if (invoice.grossOutboundMicros !== 0n || invoice.billableOutboundMicros !== 0n ||
      invoice.outboundOverageMicros !== 0n || invoice.apiOverageMicros !== 0n || invoice.walletOverageMicros !== 0n) return false;
    const snapshot = invoice.snapshotJson as any;
    if (!snapshot || typeof invoice.snapshotHash !== 'string' ||
      createHash('sha256').update(canonicalBillingJson(snapshot)).digest('hex') !== invoice.snapshotHash) return false;
    const synthetic = snapshot.renewal === true && snapshot.planVersionId === plan.id &&
      snapshot.fixedFeeMicros === fixedFee.toString() && snapshot.period === start.toISOString().slice(0, 10);
    const canonical = snapshot.version === 1 && snapshot.planVersionId === plan.id &&
      snapshot.period === start.toISOString().slice(0, 7) && snapshot.plan?.code === plan.code &&
      snapshot.plan?.name === plan.name && snapshot.plan?.monthlyFeeMicros === microsToDecimal(fixedFee) &&
      snapshot.amounts?.monthlyFeeMicros === microsToDecimal(fixedFee) && snapshot.amounts?.totalMicros === microsToDecimal(fixedFee);
    const lines = invoice.lines;
    return (synthetic || canonical) && Array.isArray(lines) && lines.length === 1 &&
      lines[0].lineType === 'monthly_fee' && lines[0].quantity === 1n && lines[0].amountMicros === fixedFee;
  }

  private async promoteRenewalInvoice(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<void> {
    // Stripe may finalize its invoice before the local accounting period ends.
    // Local finalization is owned exclusively by BillingService's period-close
    // flow, so this provider event must not close the local invoice.
    if (event.type === 'invoice.finalized') return;
    const raw = event.data.object as StripeObjectLike;
    const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
    if (!invoice || invoice.currency !== 'USD' || invoice.totalMicros !== attempt.amountMicros ||
      invoice.stripeInvoiceId !== (typeof raw.id === 'string' ? raw.id : null) || invoice.paidAt !== null || invoice.settlementAttemptId !== null) {
      throw new ConflictException('Renewal finalization proof failed');
    }
    if (invoice.status === 'finalized') return;
    if (invoice.status !== 'open') throw new ConflictException('Renewal invoice is not promotable');
    const promoted = await tx.billingInvoice.updateMany({
      where: { id: invoice.id, status: 'open', stripeInvoiceId: typeof raw.id === 'string' ? raw.id : null, totalMicros: attempt.amountMicros, paidAt: null, settlementAttemptId: null },
      data: { status: 'finalized', finalizedAt: new Date() },
    });
    if (promoted.count !== 1) {
      const current = await tx.billingInvoice.findUnique({ where: { id: invoice.id } });
      if (!current || current.status !== 'finalized' || current.stripeInvoiceId !== raw.id || current.paidAt !== null || current.settlementAttemptId !== null) {
        throw new ConflictException('Renewal finalization ownership lost');
      }
    }
  }

  private async bootstrapActivePlan(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<void> {
    if (attempt.stripeChargeKind !== STRIPE_CHARGE_KIND_FIXED_FEE) return;
    const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
    if (!invoice || invoice.status !== 'finalized' && invoice.status !== 'open') throw new ConflictException('Invalid fixed-fee bootstrap invoice');
    if (invoice.currency !== 'USD' || invoice.totalMicros !== attempt.amountMicros) throw new ConflictException('Fixed-fee bootstrap amount/currency mismatch');
    if (invoice.grossOutboundMicros !== 0n || invoice.billableOutboundMicros !== 0n || invoice.outboundOverageMicros !== 0n || invoice.apiOverageMicros !== 0n || invoice.walletOverageMicros !== 0n) throw new ConflictException('Dynamic invoice cannot bootstrap recurring plan');
    if (invoice.planVersionId === null) throw new ConflictException('Fixed-fee bootstrap plan is missing');
    const snapshot = invoice.snapshotJson as { planVersionId?: unknown; renewal?: unknown } | null;
    if (!snapshot || snapshot.planVersionId !== invoice.planVersionId) throw new ConflictException('Fixed-fee bootstrap snapshot mismatch');
    if (typeof invoice.snapshotHash !== 'string' || createHash('sha256').update(canonicalBillingJson(snapshot)).digest('hex') !== invoice.snapshotHash) throw new ConflictException('Fixed-fee bootstrap snapshot hash mismatch');
    const plan = await tx.billingPlanVersion.findUnique({ where: { id: invoice.planVersionId } });
    if (!plan || plan.monthlyFeeMicros === null || plan.monthlyFeeMicros !== invoice.totalMicros) throw new ConflictException('Fixed-fee bootstrap plan mismatch');
    const account = await tx.billingAccount.findUnique({ where: { id: invoice.billingAccountId } });
    if (!account) throw new ConflictException('Fixed-fee bootstrap account missing');
    const raw = event.data.object as StripeObjectLike;
    const customer = readProviderId(raw.customer, 'customer');
    const subscription = readProviderId(raw.subscription, 'subscription');
    if (!customer || !account.stripeCustomerId || customer !== account.stripeCustomerId) throw new ConflictException('Fixed-fee bootstrap customer mismatch');
    if (subscription && account.stripeSubscriptionId && subscription !== account.stripeSubscriptionId) throw new ConflictException('Fixed-fee bootstrap subscription mismatch');
    const eventTime = new Date(event.created * 1000);
    if (!Number.isFinite(eventTime.getTime())) throw new ConflictException('Invalid Stripe event timestamp');
    const guarded = await tx.billingAccount.updateMany({
      where: {
        id: account.id,
        ...(customer ? { stripeCustomerId: customer } : {}),
        ...(subscription ? { stripeSubscriptionId: subscription } : {}),
        AND: [
          { OR: [{ activeSubscriptionPlanVersionId: null }, { activeSubscriptionPlanVersionId: invoice.planVersionId }] },
          { OR: [
            { stripeSubscriptionUpdatedAt: null },
            { stripeSubscriptionUpdatedAt: { lt: eventTime } },
            { AND: [{ stripeSubscriptionUpdatedAt: eventTime }, { stripeSubscriptionEventId: { lt: event.id } }] },
          ] },
        ],
      },
      data: { activeSubscriptionPlanVersionId: invoice.planVersionId, stripeSubscriptionUpdatedAt: eventTime, stripeSubscriptionEventId: event.id },
    });
    if (guarded.count !== 1) throw new ConflictException('Fixed-fee bootstrap ownership/order lost');
  }

  // ── Provider-fact validation ───────────────────────────────────────────────

  /** Validate renewal facts before an unmatched event can be materialized. */
  private validateUnmatchedProviderFacts(
    event: Stripe.Event,
  ): { ok: true } | { ok: false; reason: string } {
    const raw = event.data.object as StripeObjectLike;
    if (!raw || typeof raw.id !== 'string') return { ok: false, reason: 'provider_object_missing' };
    if (!readProviderId(raw.customer, 'customer')) return { ok: false, reason: 'provider_customer_missing' };
    const eventSubscription = event.type.startsWith('customer.subscription')
      ? raw.id
      : raw.subscription;
    if (!readProviderId(eventSubscription, 'subscription')) return { ok: false, reason: 'provider_subscription_missing' };
    if (!event.type.startsWith('customer.subscription') &&
      (typeof raw.currency !== 'string' || raw.currency.toLowerCase() !== 'usd')) {
      return { ok: false, reason: 'provider_currency_mismatch' };
    }
    if (event.type.startsWith('customer.subscription')) {
      const status = typeof raw.status === 'string' ? raw.status : null;
      const valid = event.type.endsWith('.deleted')
        ? status === 'canceled'
        : status !== null && ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired'].includes(status);
      if (!valid) return { ok: false, reason: 'provider_status_mismatch' };
      if (!event.type.endsWith('.deleted') &&
        (typeof raw.current_period_start !== 'number' || typeof raw.current_period_end !== 'number' ||
          !Number.isSafeInteger(raw.current_period_start) || !Number.isSafeInteger(raw.current_period_end) ||
          raw.current_period_start >= raw.current_period_end)) {
        return { ok: false, reason: 'provider_period_missing' };
      }
      return { ok: true };
    }
    const status = typeof raw.status === 'string' ? raw.status : null;
    const allowed = event.type === 'invoice.created' ? ['draft', 'open', 'finalized'] :
      event.type === 'invoice.finalized' ? ['open', 'finalized'] :
        event.type === 'invoice.paid' ? ['paid'] : ['open', 'uncollectible'];
    if (!status || !allowed.includes(status)) return { ok: false, reason: 'provider_status_mismatch' };
    const amount = this.invoiceAmount(raw, event.type);
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
      return { ok: false, reason: 'provider_amount_missing' };
    }
    const period = event.type.startsWith('invoice') ? this.invoicePeriod(raw) : (raw.period ?? raw.lines?.data?.[0]?.period);
    if (!period || typeof period.start !== 'number' || typeof period.end !== 'number' ||
      !Number.isSafeInteger(period.start) || !Number.isSafeInteger(period.end) || period.start >= period.end) {
      return { ok: false, reason: 'provider_period_missing' };
    }
    return { ok: true };
  }

  /**
   * Validates provider facts before a success transition: the event-specific
   * amount (amount_received/amount_paid/amount_total as applicable, converted
   * exactly from cents to micros), the currency, and — where applicable — the
   * Stripe customer and subscription identity against the local attempt/invoice.
   * Any under/over/missing/wrong-currency/mismatched value rejects the event
   * without settling.
   */
  private async validateProviderFacts(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<{ ok: true } | { ok: false; reason: string; details?: string }> {
    const rawObject = event.data.object as StripeObjectLike;
    const object = event.data.object as
      | Stripe.Checkout.Session
      | Stripe.PaymentIntent
      | Stripe.Invoice;
    if (!object || typeof rawObject.id !== 'string') {
      return { ok: false, reason: 'provider_object_missing' };
    }

    // Subscription lifecycle objects are not payments.  Do not demand an
    // amount_received/amount_paid field, but do demand their complete
    // lifecycle proof before allowing mirror/bookkeeping writes.
    if (event.type.startsWith('customer.subscription')) {
      const customer = readProviderId(rawObject.customer, 'customer');
      const subscription = readProviderId(rawObject.id, 'subscription');
      const status = typeof rawObject.status === 'string' ? rawObject.status : null;
      const validStatus = event.type.endsWith('.deleted') ? status === 'canceled' :
        status !== null && ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired'].includes(status);
      if (!customer || !subscription || !validStatus || !Number.isSafeInteger(event.created) || event.created <= 0) {
        return { ok: false, reason: 'provider_lifecycle_identity_invalid' };
      }
      if (!event.type.endsWith('.deleted') &&
        (typeof rawObject.current_period_start !== 'number' || typeof rawObject.current_period_end !== 'number' ||
          !Number.isSafeInteger(rawObject.current_period_start) || !Number.isSafeInteger(rawObject.current_period_end) ||
          rawObject.current_period_start >= rawObject.current_period_end)) {
        return { ok: false, reason: 'provider_period_missing' };
      }
      return { ok: true };
    }

    // Provider state is part of the proof, even for non-success events. A
    // webhook type alone must never authorize an incompatible state transition.
    if (event.type.startsWith('payment_intent')) {
      const status = typeof rawObject.status === 'string' ? rawObject.status : null;
      const valid = event.type === 'payment_intent.succeeded' ? status === 'succeeded'
        : event.type === 'payment_intent.processing' ? status === 'processing'
          : status === 'requires_payment_method' || status === 'canceled';
      if (!valid) return { ok: false, reason: 'provider_status_mismatch' };
    }
    if (event.type.startsWith('checkout.session')) {
      const paymentStatus = typeof rawObject.payment_status === 'string' ? rawObject.payment_status : null;
      if (!paymentStatus || !['paid', 'unpaid', 'no_payment_required'].includes(paymentStatus)) {
        return { ok: false, reason: 'provider_payment_status_missing' };
      }
      if (typeof rawObject.mode !== 'string' || !['payment', 'subscription', 'setup'].includes(rawObject.mode)) {
        return { ok: false, reason: 'provider_mode_missing' };
      }
      if (rawObject.lines !== undefined &&
        (!rawObject.lines || !Array.isArray(rawObject.lines.data) || rawObject.lines.data.length === 0)) {
        return { ok: false, reason: 'provider_line_structure_invalid' };
      }
      if (event.type === 'checkout.session.async_payment_succeeded' && paymentStatus !== 'paid') {
        return { ok: false, reason: 'provider_status_mismatch' };
      }
      if (event.type === 'checkout.session.async_payment_failed' && paymentStatus !== 'unpaid') {
        return { ok: false, reason: 'provider_status_mismatch' };
      }
      if (event.type === 'checkout.session.completed' && rawObject.payment_status === 'paid' && rawObject.mode === 'subscription' && rawObject.subscription === undefined) {
        // Subscription Checkout may omit subscription only when the local fixed
        // fee attempt is already owned; validateAttemptIdentity/provider facts
        // perform that local ownership proof before any mutation.
      }
    }
    if (event.type === 'invoice.paid' && rawObject.status !== 'paid') return { ok: false, reason: 'provider_status_mismatch' };
    if (event.type === 'invoice.payment_failed' && !['open', 'uncollectible'].includes(String(rawObject.status))) return { ok: false, reason: 'provider_status_mismatch' };
    if (event.type === 'invoice.created' && !['draft', 'open'].includes(String(rawObject.status))) return { ok: false, reason: 'provider_status_mismatch' };
    if (event.type === 'invoice.finalized' && !['open', 'finalized'].includes(String(rawObject.status))) return { ok: false, reason: 'provider_status_mismatch' };

    // Event-specific amount in cents.
    let amountCents: unknown;
    if (event.type.startsWith('invoice')) {
      // Invoice payloads use the top-level Invoice facts. `amount_total` is a
      // Checkout Session field and is intentionally never consulted here.
      amountCents = this.invoiceAmount(rawObject, event.type);
    } else if (event.type.startsWith('checkout.session')) {
      // For a paid Checkout, Stripe's amount_total is the final settled
      // Checkout total. It is accepted only together with the explicit paid
      // status; never use it for an unpaid/ambiguous session and never fall
      // back to amount or amount_subtotal.
      amountCents = rawObject.amount_total;
    } else if (event.type.startsWith('payment_intent')) {
      amountCents = rawObject.amount_received;
    }
    if (this.resolveTransition(event) === 'succeeded') {
      if (
        typeof amountCents !== 'number' ||
        !Number.isSafeInteger(amountCents) ||
        amountCents <= 0 ||
        BigInt(amountCents) * MICROS_PER_CENT !== attempt.amountMicros
      ) {
        return { ok: false, reason: 'provider_amount_mismatch' };
      }
    } else if (amountCents === undefined ||
      (amountCents !== undefined &&
      (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 0 ||
        BigInt(amountCents) * MICROS_PER_CENT > attempt.amountMicros))) {
      return { ok: false, reason: 'provider_amount_mismatch' };
    }

    // Currency must match the attempt (lowercase usd vs USD).
    const currency = (object as { currency?: unknown }).currency;
    if (typeof currency !== 'string' || currency.toLowerCase() !== attempt.currency.toLowerCase()) {
      return { ok: false, reason: 'provider_currency_mismatch' };
    }

    // Customer ownership: a customer-bearing event must match the invoice
    // owner's Stripe customer when the account mirror exists.
    const customer = (object as { customer?: unknown }).customer;
    if (typeof customer !== 'string' || customer.length === 0) {
      return { ok: false, reason: 'provider_customer_missing' };
    }
    if (typeof customer === 'string') {
      const invoice = await tx.billingInvoice.findUnique({
        where: { id: attempt.invoiceId },
        select: { billingAccountId: true },
      });
      if (invoice) {
        const account = await tx.billingAccount.findUnique({
          where: { id: invoice.billingAccountId },
          select: { stripeCustomerId: true },
        });
        if (account?.stripeCustomerId && customer !== account.stripeCustomerId) {
          return { ok: false, reason: 'provider_customer_mismatch' };
        }
      }
    }

    // Subscription ownership: a subscription-bearing success event must match
    // the attempt's subscription (fixed-fee renewal attempts always carry one).
    const subscription = (object as { subscription?: unknown }).subscription;
    if (typeof subscription === 'string') {
      if (attempt.stripeSubscriptionId && subscription !== attempt.stripeSubscriptionId) {
        return { ok: false, reason: 'provider_subscription_mismatch' };
      }
      if (
        attempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE &&
        !attempt.stripeSubscriptionId
      ) {
        return { ok: false, reason: 'provider_subscription_missing' };
      }
    } else if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      // Stripe may omit subscription on a paid Checkout response. The owned
      // local fixed-fee invoice/attempt is the only trusted bootstrap source.
      // A paid Checkout session may omit subscription. For a fixed-fee attempt,
      // the local invoice/attempt ownership is the trusted bootstrap proof; the
      // active-plan CAS later binds null-or-same without accepting metadata.
    } else if (attempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      // Non-Checkout fixed-fee renewal success must always carry a subscription.
      return { ok: false, reason: 'provider_subscription_missing' };
    }

    // Invoice period boundaries: for invoice.* events the Stripe period must
    // map EXACTLY to the local invoice's UTC month (start = invoice.periodStart,
    // end = invoice.periodEnd). A slopped/partial/mismatched period is rejected
    // without settling — never trusted as a proxy for the local period.
    if (event.type.startsWith('invoice')) {
      const period = this.invoicePeriod(rawObject);
      if (
        !period ||
        !Number.isSafeInteger(period.start) ||
        !Number.isSafeInteger(period.end)
      ) {
        return { ok: false, reason: 'provider_period_missing' };
      }
      const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
      if (!invoice) return { ok: false, reason: 'provider_invoice_missing' };
      if (
        period.start * 1000 !== invoice.periodStart.getTime() ||
        period.end * 1000 !== invoice.periodEnd.getTime()
      ) {
        return { ok: false, reason: 'provider_period_mismatch' };
      }
    }

    return { ok: true };
  }

  /**
   * Read-only identity fence shared by every attempt-bearing event, including
   * failed, processing, and lifecycle events. Provider facts cannot be
   * validated only on the success branch: a forged failure or lifecycle event
   * must not become an identity anchor or persist provider ids.
   */
  private async validateAttemptIdentity(
    tx: Tx,
    event: Stripe.Event,
    attempt: PaymentAttemptRow,
  ): Promise<boolean> {
    if (attempt.method !== 'stripe') return false;
    const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId } });
    if (!invoice || invoice.billingAccountId.length === 0) return false;
    const account = await tx.billingAccount.findUnique({ where: { id: invoice.billingAccountId } });
    if (!account) return false;
    if (attempt.stripeChargeKind !== STRIPE_CHARGE_KIND_FIXED_FEE && attempt.stripeChargeKind !== STRIPE_CHARGE_KIND_FULL) return false;
    if (attempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE && !invoice.planVersionId) return false;
    if (!invoice.periodStart || !invoice.periodEnd || invoice.periodStart >= invoice.periodEnd) return false;

    const metadata = extractSafeMetadata(event.data.object);
    if (metadata.invalidAttemptId || metadata.invalidInvoiceId) return false;
    if (metadata.userId && metadata.userId !== account.userId) return false;
    const metadataAccountId = readMetadataString(event.data.object, 'billingAccountId');
    if (metadataAccountId && metadataAccountId !== invoice.billingAccountId) return false;
    if (metadata.invoiceId && metadata.invoiceId !== invoice.id) return false;
    if (metadata.attemptId && metadata.attemptId !== attempt.id) return false;
    const metadataChargeKind = readMetadataString(event.data.object, 'chargeKind');
    if (metadataChargeKind && metadataChargeKind !== attempt.stripeChargeKind) return false;
    const metadataPlanVersionId = readMetadataString(event.data.object, 'planVersionId');
    if (metadataPlanVersionId && metadataPlanVersionId !== invoice.planVersionId) return false;
    const metadataPeriod = readMetadataString(event.data.object, 'period');
    if (metadataPeriod && metadataPeriod !== invoice.periodStart.toISOString().slice(0, 7)) return false;

    const raw = event.data.object as StripeObjectLike;
    const customer = typeof raw.customer === 'string' ? raw.customer : null;
    if (!customer) return false;
    if (customer && account.stripeCustomerId && customer !== account.stripeCustomerId) return false;

    const objectId = typeof raw.id === 'string' ? raw.id : null;
    if (!objectId) return false;
    if (event.type.startsWith('checkout.session') && attempt.stripeCheckoutSessionId && objectId !== attempt.stripeCheckoutSessionId) return false;
    if (event.type.startsWith('payment_intent') && attempt.stripePaymentIntentId && objectId !== attempt.stripePaymentIntentId) return false;
    if (event.type.startsWith('invoice') && attempt.stripeInvoiceId && objectId !== attempt.stripeInvoiceId) return false;
    if (event.type.startsWith('customer.subscription') && attempt.stripeSubscriptionId && objectId !== attempt.stripeSubscriptionId) return false;
    const associatedPaymentIntent = readProviderId(raw.payment_intent, 'PaymentIntent');
    if (associatedPaymentIntent && attempt.stripePaymentIntentId && associatedPaymentIntent !== attempt.stripePaymentIntentId) return false;
    const associatedInvoice = readProviderId(raw.invoice, 'Invoice');
    const latestInvoice = readProviderId(raw.latest_invoice, 'Invoice');
    if (associatedInvoice && attempt.stripeInvoiceId && associatedInvoice !== attempt.stripeInvoiceId) return false;
    if (latestInvoice && attempt.stripeInvoiceId && latestInvoice !== attempt.stripeInvoiceId) return false;
    if ((associatedInvoice || latestInvoice) && !attempt.stripeInvoiceId && event.type !== 'invoice.created' && event.type !== 'invoice.finalized') return false;

    const suppliedSubscription = readProviderId(raw.subscription, 'subscription');
    if (
      suppliedSubscription &&
      ((attempt.stripeSubscriptionId && suppliedSubscription !== attempt.stripeSubscriptionId) ||
        (account.stripeSubscriptionId && suppliedSubscription !== account.stripeSubscriptionId))
    ) {
      return false;
    }
    return true;
  }

  private utcMonthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  private async getAttemptAccount(tx: Tx, attempt: PaymentAttemptRow): Promise<{ id: string } | null> {
    const invoice = await tx.billingInvoice.findUnique({ where: { id: attempt.invoiceId }, select: { billingAccountId: true } });
    return invoice ? { id: invoice.billingAccountId } : null;
  }

  private async getAttemptPeriod(tx: Tx, attempt: PaymentAttemptRow): Promise<Date | null> {
    const invoice = await tx.billingInvoice.findUnique({
      where: { id: attempt.invoiceId },
      select: { periodStart: true, periodEnd: true },
    });
    if (!invoice?.periodStart || !invoice.periodEnd || invoice.periodStart >= invoice.periodEnd) return null;
    return this.utcMonthStart(invoice.periodStart);
  }

  private eventPeriod(event: Stripe.Event): Date | null {
    const raw = event.data.object as StripeObjectLike;
    const period = event.type.startsWith('customer.subscription') &&
      typeof raw.current_period_start === 'number' && typeof raw.current_period_end === 'number'
      ? { start: raw.current_period_start, end: raw.current_period_end }
      : event.type.startsWith('invoice')
      ? this.invoicePeriod(raw)
      : raw.period ?? raw.lines?.data?.[0]?.period;
    if (period && typeof period.start === 'number' && Number.isSafeInteger(period.start)) {
      return this.utcMonthStart(new Date(period.start * 1000));
    }
    const periodHint = readMetadataString(raw, 'period');
    if (periodHint && /^\d{4}-\d{2}$/.test(periodHint)) {
      const [year, month] = periodHint.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, 1));
    }
    return null;
  }

  /** Stripe Invoice period fields are top-level and are not Checkout fields. */
  private invoicePeriod(raw: StripeObjectLike): { start: number; end: number } | null {
    if (!Number.isSafeInteger(raw.period_start) || !Number.isSafeInteger(raw.period_end) ||
      (raw.period_start as number) >= (raw.period_end as number)) return null;
    return { start: raw.period_start as number, end: raw.period_end as number };
  }

  private invoiceAmount(raw: StripeObjectLike, eventType: string): number | null {
    const value = eventType === 'invoice.paid' || eventType === 'invoice.payment_failed'
      ? raw.amount_paid
      : raw.total;
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
  }

  // ── Attempt lookup ─────────────────────────────────────────────────────────

  /**
   * Locates the local attempt for an event, in order:
   * 1. Persisted object id (Checkout Session id / PaymentIntent id) — the
   *    normal case once the ids are stored on the attempt.
   * 2. Verified object metadata (`attemptId`, then `invoiceId`) — required for
   *    PaymentIntent-before-Checkout ordering, because the PaymentIntent id is
   *    usually not known at Checkout session creation and therefore not yet
   *    persisted. Metadata values are format-validated (UUID) before any query
   *    so malformed/malicious metadata never causes a meaningless 500. When
   *    BOTH `attemptId` and `invoiceId` are present, both are resolved and any
   *    disagreement is a CONFLICT (rejected before any mutation) — an attempt
   *    can never be cross-linked to a different local invoice.
   * 3. `client_reference_id` (Checkout sessions only) — the invoice id we set
   *    at session creation, as a final fallback.
   *
   * Every lookup path is restricted to `method = stripe` — the persisted
   * object-id and metadata-attemptId lookups included — so a Stripe event can
   * never resolve to a USDC attempt, even when a USDC row happens to carry the
   * same PaymentIntent/Checkout id or the same attempt id in metadata
   * (dual-rail isolation).
   */
  private async findAttemptForEvent(
    tx: Tx,
    event: Stripe.Event,
  ): Promise<AttemptLookup> {
    const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
    if (!object || typeof object.id !== 'string') return { kind: 'none' };

    const metadata = extractSafeMetadata(object);
    const metadataInvoiceId = metadata.invoiceId;
    const metadataAttemptId = metadata.attemptId;
    if (metadata.invalidAttemptId || metadata.invalidInvoiceId) return { kind: 'conflict' };
    // Any attempt resolved through ANY path (persisted Stripe id, metadata, or
    // client_reference_id) must agree with BOTH metadata identifiers when
    // present — an attempt can never be cross-linked to a different local
    // invoice or a different local attempt. Disagreement is a conflict that is
    // rejected before any mutation.
    const rejectMetadataConflict = (attempt: PaymentAttemptRow | null): boolean => {
      if (attempt === null) return false;
      if (metadataInvoiceId !== null && attempt.invoiceId !== metadataInvoiceId) return true;
      if (metadataAttemptId !== null && attempt.id !== metadataAttemptId) return true;
      return false;
    };

    // 1. Persisted object id.
    if (event.type.startsWith('checkout.session')) {
      const bySession = await tx.billingPaymentAttempt.findFirst({
        where: { stripeCheckoutSessionId: object.id, method: 'stripe' },
      });
      if (bySession) {
        if (rejectMetadataConflict(bySession)) return { kind: 'conflict' };
        return { kind: 'attempt', attempt: bySession };
      }
    }
    if (event.type.startsWith('payment_intent')) {
      const byPi = await tx.billingPaymentAttempt.findFirst({
        where: { stripePaymentIntentId: object.id, method: 'stripe' },
      });
      if (byPi) {
        if (rejectMetadataConflict(byPi)) return { kind: 'conflict' };
        return { kind: 'attempt', attempt: byPi };
      }
    }
    if (event.type.startsWith('invoice')) {
      const byInvoice = await tx.billingPaymentAttempt.findFirst({
        where: { stripeInvoiceId: object.id, method: 'stripe' },
      });
      if (byInvoice) {
        if (rejectMetadataConflict(byInvoice)) return { kind: 'conflict' };
        return { kind: 'attempt', attempt: byInvoice };
      }
    }
    if (event.type.startsWith('customer.subscription')) {
      const bySubscription = await tx.billingPaymentAttempt.findFirst({
        where: { stripeSubscriptionId: object.id, method: 'stripe' },
      });
      if (bySubscription) {
        if (rejectMetadataConflict(bySubscription)) return { kind: 'conflict' };
        return { kind: 'attempt', attempt: bySubscription };
      }
    }

    // 2. Verified metadata (attemptId is authoritative; invoiceId is a
    //    fallback for the most recent pending Stripe attempt of that invoice).
    if (metadata.attemptId) {
      const byAttempt = await tx.billingPaymentAttempt.findFirst({
        where: { id: metadata.attemptId, method: 'stripe' },
      });
      if (byAttempt) {
        // When both attemptId and invoiceId are present, resolve BOTH and
        // reject any disagreement before mutating anything.
        if (rejectMetadataConflict(byAttempt)) return { kind: 'conflict' };
        return { kind: 'attempt', attempt: byAttempt };
      }
      // An explicitly supplied attempt identity is authoritative. Do not
      // fall through to invoice/reference fallback when it is unknown.
      return { kind: 'conflict' };
    }
    const referenceId = event.type.startsWith('checkout.session')
      ? (typeof (object as Stripe.Checkout.Session).client_reference_id === 'string'
        ? (object as Stripe.Checkout.Session).client_reference_id
        : null)
      : null;
    let byReference: PaymentAttemptRow | null = null;
    if (isUuid(referenceId)) {
      byReference = await tx.billingPaymentAttempt.findFirst({
        where: { invoiceId: referenceId, status: 'pending', method: 'stripe' },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (metadata.invoiceId) {
      const byInvoice = await tx.billingPaymentAttempt.findFirst({
        where: { invoiceId: metadata.invoiceId, status: 'pending', method: 'stripe' },
        orderBy: { createdAt: 'desc' },
      });
      if (byInvoice && byReference && byInvoice.id !== byReference.id) return { kind: 'conflict' };
      if (byInvoice) return { kind: 'attempt', attempt: byInvoice };
      if (byReference) return { kind: 'conflict' };
    }

    // 3. client_reference_id fallback (Checkout sessions only).
    if (byReference) return { kind: 'attempt', attempt: byReference };

    return { kind: 'none' };
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
      const result = await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, stripePaymentIntentId: null },
        data: { stripePaymentIntentId: object.id },
      });
      if (result.count === 0) {
        const current = await tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } });
        if (current?.stripePaymentIntentId !== object.id) throw new ConflictException('Stripe PaymentIntent identity conflict');
      }
    }
    if (event.type.startsWith('checkout.session') && attempt.stripeCheckoutSessionId === null) {
      const result = await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, stripeCheckoutSessionId: null },
        data: { stripeCheckoutSessionId: object.id },
      });
      if (result.count === 0) {
        const current = await tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } });
        if (current?.stripeCheckoutSessionId !== object.id) throw new ConflictException('Stripe Checkout identity conflict');
      }
    }

    if (event.type.startsWith('invoice') && attempt.stripeInvoiceId === null) {
      const result = await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, stripeInvoiceId: null },
        data: { stripeInvoiceId: object.id },
      });
      if (result.count === 0) {
        const current = await tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } });
        if (current?.stripeInvoiceId !== object.id) throw new ConflictException('Stripe Invoice identity conflict');
      }
    }
    if (event.type.startsWith('customer.subscription') && attempt.stripeSubscriptionId === null) {
      const result = await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, stripeSubscriptionId: null },
        data: { stripeSubscriptionId: object.id },
      });
      if (result.count === 0) {
        const current = await tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } });
        if (current?.stripeSubscriptionId !== object.id) throw new ConflictException('Stripe Subscription identity conflict');
      }
    }

    // Expanded Checkout/PaymentIntent/Subscription objects can carry the
    // remaining provider identities. Normalize them before writing and use the
    // same null-or-same CAS as primary object persistence.
    const raw = object as unknown as StripeObjectLike;
    const associated = [
      ['stripePaymentIntentId', readProviderId(raw.payment_intent, 'PaymentIntent')],
      ['stripeInvoiceId', readProviderId(raw.invoice ?? raw.latest_invoice, 'Invoice')],
      ['stripeSubscriptionId', readProviderId(raw.subscription, 'Subscription')],
    ] as const;
    for (const [field, value] of associated) {
      if (!value) continue;
      const current = attempt[field];
      if (current && current !== value) throw new ConflictException(`Stripe ${field} identity conflict`);
      if (current === value) continue;
      const claimed = await tx.billingPaymentAttempt.updateMany({
        where: { id: attempt.id, [field]: null },
        data: { [field]: value },
      });
      if (claimed.count !== 1) {
        const reloaded = await tx.billingPaymentAttempt.findUnique({ where: { id: attempt.id } });
        if (!reloaded || reloaded[field] !== value) throw new ConflictException(`Stripe ${field} CAS lost`);
      }
    }
  }

  /**
   * Maps a verified event to a forward-only transition:
   * - `checkout.session.completed` only succeeds when `payment_status = paid`;
   *   an unpaid completion stays pending.
   * - async success/failure, `payment_intent.succeeded`/`payment_failed`, and
   *   `invoice.paid`/`invoice.payment_failed` map directly.
   * - `payment_intent.processing` stays pending.
   * - `invoice.created`/`invoice.finalized` and `customer.subscription.*` are
   *   bookkeeping/materialization only (no direct payment transition).
   */
  private resolveTransition(event: Stripe.Event): PaymentTransition {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return session.payment_status === 'paid' ? 'succeeded' : null;
      }
      case 'checkout.session.async_payment_succeeded':
      case 'payment_intent.succeeded':
      case 'invoice.paid':
        return 'succeeded';
      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed':
      case 'invoice.payment_failed':
        return 'failed';
      case 'payment_intent.processing':
        return null;
      default:
        return null;
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function microsToDecimal(value: bigint | null): string | null {
  if (value === null) return null;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}


function readProviderId(value: unknown, kind: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'id') {
      const id = (value as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  throw new ConflictException(`Malformed Stripe ${kind} identity`);
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isPreflightConflict(error: ConflictException): boolean {
  const message = error.message;
  return message.startsWith('Stripe event ') || message.startsWith('Stripe renewal ') || message.startsWith('Stripe provider ') || message.startsWith('Stripe attempt ') || message.startsWith('Stripe success ');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Safely extracts `attemptId`/`invoiceId`/`userId` from a verified event
 * object's metadata. Values are format-validated (UUID) before any DB query so
 * malformed/malicious metadata never causes a meaningless 500 — it simply
 * yields no match and the event is recorded as ignored/deferred.
 */
function extractSafeMetadata(object: unknown): {
  attemptId: string | null;
  invoiceId: string | null;
  userId: string | null;
  invalidAttemptId: boolean;
  invalidInvoiceId: boolean;
} {
  const metadata = (object as { metadata?: unknown } | null)?.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return { attemptId: null, invoiceId: null, userId: null, invalidAttemptId: false, invalidInvoiceId: false };
  }
  const record = metadata as Record<string, unknown>;
  return {
    attemptId: isUuid(record.attemptId) ? record.attemptId : null,
    invoiceId: isUuid(record.invoiceId) ? record.invoiceId : null,
    userId: isUuid(record.userId) ? record.userId : null,
    invalidAttemptId: record.attemptId !== undefined && !isUuid(record.attemptId),
    invalidInvoiceId: record.invoiceId !== undefined && !isUuid(record.invoiceId),
  };
}

function readMetadataString(object: unknown, key: string): string | null {
  const metadata = (object as { metadata?: unknown } | null)?.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasMalformedIdentityMetadata(object: unknown): boolean {
  const metadata = (object as { metadata?: unknown } | null)?.metadata;
  if (typeof metadata !== 'object' || metadata === null) return false;
  const record = metadata as Record<string, unknown>;
  if (record.userId !== undefined && !isUuid(record.userId)) return true;
  if (record.billingAccountId !== undefined && (typeof record.billingAccountId !== 'string' || record.billingAccountId.length === 0)) return true;
  if (record.attemptId !== undefined && !isUuid(record.attemptId)) return true;
  if (record.invoiceId !== undefined && !isUuid(record.invoiceId)) return true;
  if (record.planVersionId !== undefined && (typeof record.planVersionId !== 'string' || record.planVersionId.length === 0)) return true;
  if (record.chargeKind !== undefined && record.chargeKind !== 'fixed_fee' && record.chargeKind !== 'full') return true;
  if (record.period !== undefined && (typeof record.period !== 'string' || !/^\d{4}-\d{2}$/.test(record.period))) return true;
  return false;
}

/** Safe object id from a verified event payload (never the full payload). */
function extractObjectId(event: Stripe.Event): string | null {
  const object = event.data.object as { id?: unknown } | null;
  return typeof object?.id === 'string' && object.id.length > 0 ? object.id.slice(0, 255) : null;
}

/**
 * Safely extracts a local userId from a verified event's metadata (we set
 * `userId` on Stripe customers/subscriptions). Format-validated (UUID) so
 * malformed metadata never causes a meaningless 500.
 */
function extractAccountUserId(event: Stripe.Event): string | null {
  const object = event.data.object as { metadata?: unknown } | null;
  const metadata = object?.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const record = metadata as Record<string, unknown>;
  const userId = record.userId;
  return typeof userId === 'string' && UUID_REGEX.test(userId) ? userId : null;
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as Stripe from 'stripe';
import { PrismaService } from '../../../core/database/prisma.service';
import { getErrorText, sanitizeErrorMessage } from '../../../common/utils/sanitize';
import { formatUtcMonth } from '../billing.utils';
import {
  SESSION_CLEANUP_STATUS_COMPLETED,
  SESSION_CLEANUP_STATUS_IN_FLIGHT,
  SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
  SESSION_CLEANUP_STATUS_PENDING,
  STRIPE_CHARGE_KIND_FIXED_FEE,
  STRIPE_CHARGE_KIND_FULL,
  STRIPE_CLIENT,
  STRIPE_SESSION_CLEANUP_BACKOFF_MS,
  STRIPE_SESSION_CLEANUP_LEASE_MS,
  STRIPE_SESSION_CLEANUP_MAX_RETRIES,
} from './stripe.constants';

const MICROS_PER_CENT = 10_000n;

/**
 * Aggregate outcome of one bounded BILL-014 cleanup pass.
 *
 * - `expired` / `alreadyClosed`: durable success for THIS invocation (fenced CAS).
 * - `needsReview`: permanent/unrecoverable identity or exhausted failure THIS
 *   invocation transitioned.
 * - `retryable`: owned non-exhausted provider/infra failure rescheduled.
 * Benign lease/CAS misses are never counted.
 */
export type SessionCleanupResult = {
  attempted: number;
  expired: number;
  alreadyClosed: number;
  needsReview: number;
  retryable: number;
};

type CleanupInvoice = {
  id: string;
  paidAt: Date | null;
  settlementAttemptId: string | null;
  totalMicros: bigint;
  allocatedMicros: bigint | null;
  periodStart: Date;
  periodEnd: Date | null;
  planVersionId: string | null;
  currency: string;
  billingAccount: {
    id: string;
    stripeCustomerId: string | null;
  };
};

type CleanupCandidate = {
  id: string;
  invoiceId: string;
  amountMicros: bigint;
  currency: string;
  stripeChargeKind: string | null;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  stripeSubscriptionId: string | null;
  sessionCleanupRetryCount: number;
  sessionCleanupOwnerId: string | null;
  sessionCleanupLeaseExpiresAt: Date | null;
  sessionCleanupCompletedAt: Date | null;
  sessionCleanupStatus: string | null;
  invoice: CleanupInvoice;
};

type IdentityProof =
  | { ok: true; sessionId: string; status: 'open' | 'complete' | 'expired' }
  | { ok: false; code: string; permanent: boolean };

/**
 * BILL-014: after an invoice is fully paid, durably expire open sibling Stripe
 * Checkout Sessions so superseded payment links cannot collect a second charge.
 *
 * Gate 1 remediation invariants:
 * - Trigger only when the invoice is fully paid (paidAt + settlement + coverage).
 * - Lease ownership uses a per-invocation fencing token (not a stable worker id).
 * - Retrieve + verify session identity (id, customer, metadata, client_reference,
 *   amount, currency, mode) before any expire or completion write.
 * - Only explicit identity-matched `expired` / `complete` outcomes finish cleanup.
 * - Empty/unknown responses, arbitrary statuses, bare `resource_missing`, and
 *   ambiguous errors stay retryable/reviewable — never treated as done.
 * - Late discovery may bind a provider Session ID not yet local (metadata match)
 *   without blind recreation; unrecoverable identity retains needs_review.
 * - Normal recurring Stripe invoice renewals
 *   (`stripeInvoiceId` + `stripeSubscriptionId`, no Checkout Session id) are
 *   never candidates for late Session discovery/list/retrieve/expire/review.
 *   Known Checkout Session ids and legitimate late-ID recovery are retained.
 * - Provider retrieve/list/expire run OUTSIDE database transactions/locks.
 * - Never refund, cancel subscriptions, or mutate paid/settlement facts.
 */
@Injectable()
export class StripeCheckoutSessionCleanupService {
  private readonly logger = new Logger(StripeCheckoutSessionCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
  ) {}

  /**
   * Bounded worker entry. Discovers due cleanup candidates on fully-paid
   * invoices (with or without a persisted Session ID), leases each attempt with
   * a unique fencing token, and expires only identity-proven open siblings.
   *
   * Also clears misclassified recurring invoice renewals that were previously
   * pushed into session-cleanup backlog (no Checkout Session ever existed).
   */
  async processDue(workerId: string, limit = 50): Promise<SessionCleanupResult> {
    const attempts = this.prisma.billingPaymentAttempt as any;

    // Path C (BILL-014): recurring renewals never used Checkout — drop any
    // leftover cleanup backlog without provider list/retrieve/expire.
    await this.clearRecurringRenewalCleanupBacklog(limit);

    if (!this.stripe) {
      return { attempted: 0, expired: 0, alreadyClosed: 0, needsReview: 0, retryable: 0 };
    }
    const now = new Date();
    const dueFilter = {
      method: 'stripe' as const,
      stripeChargeKind: { in: [STRIPE_CHARGE_KIND_FULL, STRIPE_CHARGE_KIND_FIXED_FEE] },
      sessionCleanupCompletedAt: null,
      OR: [
        { sessionCleanupStatus: null },
        {
          sessionCleanupStatus: {
            in: [SESSION_CLEANUP_STATUS_PENDING, SESSION_CLEANUP_STATUS_IN_FLIGHT],
          },
        },
      ],
      AND: [
        {
          OR: [{ sessionCleanupNextRetryAt: null }, { sessionCleanupNextRetryAt: { lte: now } }],
        },
        {
          OR: [
            { sessionCleanupOwnerId: null },
            { sessionCleanupLeaseExpiresAt: null },
            { sessionCleanupLeaseExpiresAt: { lt: now } },
          ],
        },
      ],
      invoice: {
        paidAt: { not: null },
        settlementAttemptId: { not: null },
      },
    };

    const include = {
      invoice: {
        select: {
          id: true,
          paidAt: true,
          settlementAttemptId: true,
          totalMicros: true,
          allocatedMicros: true,
          periodStart: true,
          periodEnd: true,
          planVersionId: true,
          currency: true,
          billingAccount: {
            select: { id: true, stripeCustomerId: true },
          },
        },
      },
    };

    // Path A: known Session identity. Path B: late discovery (Session created
    // before local ID was persisted) — never blind-recreate a Checkout Session.
    // Path B explicitly excludes normal recurring invoice renewals that never
    // had a Checkout Session (invoice id + subscription id, session id null).
    const [withId, withoutId] = await Promise.all([
      attempts.findMany({
        where: { ...dueFilter, stripeCheckoutSessionId: { not: null } },
        orderBy: [{ sessionCleanupNextRetryAt: 'asc' }, { createdAt: 'asc' }],
        take: limit,
        include,
      }) as Promise<CleanupCandidate[]>,
      attempts.findMany({
        where: {
          ...dueFilter,
          stripeCheckoutSessionId: null,
          NOT: RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
        },
        orderBy: [{ sessionCleanupNextRetryAt: 'asc' }, { createdAt: 'asc' }],
        take: limit,
        include,
      }) as Promise<CleanupCandidate[]>,
    ]);

    const seen = new Set<string>();
    const rows: CleanupCandidate[] = [];
    for (const row of [...withId, ...withoutId]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      if (rows.length >= limit) break;
    }

    let expired = 0;
    let alreadyClosed = 0;
    let needsReview = 0;
    let retryable = 0;

    for (const seed of rows) {
      const outcome = await this.processOne(seed, workerId);
      if (outcome === 'expired') expired += 1;
      else if (outcome === 'already_closed') alreadyClosed += 1;
      else if (outcome === 'needs_review') needsReview += 1;
      else if (outcome === 'retryable') retryable += 1;
    }

    return {
      attempted: rows.length,
      expired,
      alreadyClosed,
      needsReview,
      retryable,
    };
  }

  /**
   * BILL-014 Path C: clear session-cleanup backlog on normal recurring Stripe
   * invoice renewals. These rows never had a Checkout Session; prior late-discovery
   * misclassification must not keep PENDING/IN_FLIGHT/NEEDS_REVIEW forever.
   * No Stripe provider calls.
   */
  private async clearRecurringRenewalCleanupBacklog(limit: number): Promise<number> {
    const attempts = this.prisma.billingPaymentAttempt as any;
    const stuck = (await attempts.findMany({
      where: {
        method: 'stripe',
        stripeCheckoutSessionId: null,
        ...RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
        sessionCleanupCompletedAt: null,
        sessionCleanupStatus: {
          in: [
            SESSION_CLEANUP_STATUS_PENDING,
            SESSION_CLEANUP_STATUS_IN_FLIGHT,
            SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
          ],
        },
      },
      orderBy: [{ sessionCleanupNextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    })) as Array<{ id: string }>;

    let cleared = 0;
    for (const row of stuck) {
      const updated = await attempts.updateMany({
        where: {
          id: row.id,
          stripeCheckoutSessionId: null,
          stripeInvoiceId: { not: null },
          stripeSubscriptionId: { not: null },
          sessionCleanupCompletedAt: null,
          sessionCleanupStatus: {
            in: [
              SESSION_CLEANUP_STATUS_PENDING,
              SESSION_CLEANUP_STATUS_IN_FLIGHT,
              SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
            ],
          },
        },
        data: {
          sessionCleanupStatus: null,
          sessionCleanupOwnerId: null,
          sessionCleanupLeaseExpiresAt: null,
          sessionCleanupNextRetryAt: null,
        },
      });
      if (updated.count === 1) cleared += 1;
    }
    return cleared;
  }

  private async processOne(
    seed: CleanupCandidate,
    workerId: string,
  ): Promise<'expired' | 'already_closed' | 'needs_review' | 'retryable' | 'skipped'> {
    const stripe = this.stripe;
    if (!stripe) return 'skipped';
    const attempts = this.prisma.billingPaymentAttempt as any;

    // Per-invocation fencing token — stale workers cannot complete under a
    // recycled stable workerId after lease takeover.
    const leaseToken = `${workerId}:${randomUUID()}`;
    const leaseNow = new Date();
    const leaseExpiresAt = new Date(leaseNow.getTime() + STRIPE_SESSION_CLEANUP_LEASE_MS);

    const leased = await attempts.updateMany({
      where: {
        id: seed.id,
        sessionCleanupCompletedAt: null,
        OR: [
          { sessionCleanupStatus: null },
          {
            sessionCleanupStatus: {
              in: [SESSION_CLEANUP_STATUS_PENDING, SESSION_CLEANUP_STATUS_IN_FLIGHT],
            },
          },
        ],
        AND: [
          {
            OR: [
              { sessionCleanupOwnerId: null },
              { sessionCleanupLeaseExpiresAt: null },
              { sessionCleanupLeaseExpiresAt: { lt: leaseNow } },
            ],
          },
        ],
      },
      data: {
        sessionCleanupStatus: SESSION_CLEANUP_STATUS_IN_FLIGHT,
        sessionCleanupOwnerId: leaseToken,
        sessionCleanupLeaseExpiresAt: leaseExpiresAt,
        sessionCleanupRetryCount: { increment: 1 },
      },
    });
    if (leased.count !== 1) return 'skipped';

    const fresh = (await attempts.findUnique({
      where: { id: seed.id },
      include: {
        invoice: {
          select: {
            id: true,
            paidAt: true,
            settlementAttemptId: true,
            totalMicros: true,
            allocatedMicros: true,
            periodStart: true,
            periodEnd: true,
            planVersionId: true,
            currency: true,
            billingAccount: {
              select: { id: true, stripeCustomerId: true },
            },
          },
        },
      },
    })) as CleanupCandidate | null;

    if (
      !fresh ||
      fresh.sessionCleanupOwnerId !== leaseToken ||
      fresh.sessionCleanupCompletedAt != null ||
      !fresh.sessionCleanupLeaseExpiresAt ||
      fresh.sessionCleanupLeaseExpiresAt.getTime() <= Date.now()
    ) {
      return 'skipped';
    }

    if (!this.isInvoiceFullyPaid(fresh.invoice)) {
      await this.releaseLease(fresh.id, leaseToken, {
        undoRetryIncrement: true,
        priorRetryCount: fresh.sessionCleanupRetryCount ?? 1,
      });
      return 'skipped';
    }

    try {
      let sessionId = fresh.stripeCheckoutSessionId;

      // Defense-in-depth: recurring invoice renewals never used Checkout; do not
      // list/retrieve/expire or push them into cleanup review/backlog.
      if (!sessionId && isRecurringStripeInvoiceRenewalAttempt(fresh)) {
        await this.releaseLease(fresh.id, leaseToken, {
          undoRetryIncrement: true,
          priorRetryCount: fresh.sessionCleanupRetryCount ?? 1,
          // Null status — never leave PENDING/NEEDS_REVIEW backlog for renewals.
          clearCleanupStatus: true,
        });
        return 'skipped';
      }

      // Late discovery: provider Session may exist before local ID was persisted.
      // Never recreate a Checkout Session; bind only a unique metadata match.
      if (!sessionId) {
        const discovered = await this.discoverSessionId(stripe, fresh);
        if (discovered.kind === 'retryable') {
          return await this.failOwned(fresh, leaseToken, null, {
            permanent: false,
            code: discovered.code,
          });
        }
        if (discovered.kind === 'unrecoverable') {
          return await this.failOwned(fresh, leaseToken, null, {
            permanent: true,
            code: discovered.code,
          });
        }
        const bound = await attempts.updateMany({
          where: {
            id: fresh.id,
            sessionCleanupOwnerId: leaseToken,
            sessionCleanupCompletedAt: null,
            stripeCheckoutSessionId: null,
            sessionCleanupLeaseExpiresAt: { gt: new Date() },
          },
          data: { stripeCheckoutSessionId: discovered.sessionId },
        });
        if (bound.count !== 1) {
          // Concurrent binder or stale lease — never overwrite another attempt's id.
          return 'skipped';
        }
        sessionId = discovered.sessionId;
      }

      const retrieved = await stripe.checkout.sessions.retrieve(sessionId);
      const proof = this.proveSessionIdentity(fresh, retrieved, sessionId);
      if (!proof.ok) {
        return await this.failOwned(fresh, leaseToken, sessionId, {
          permanent: proof.permanent,
          code: proof.code,
        });
      }

      if (proof.status === 'open') {
        let expiredSession: Stripe.Checkout.Session | null = null;
        try {
          expiredSession = await stripe.checkout.sessions.expire(sessionId);
        } catch (expireErr) {
          // Never treat bare resource_missing / ambiguous expire errors as done.
          // Re-retrieve and require an explicit identity-matched closed status.
          const rechecked = await this.recheckClosedAfterExpireError(
            stripe,
            fresh,
            sessionId,
            expireErr,
          );
          if (rechecked === 'already_closed') {
            const marked = await this.markCompleted(fresh.id, leaseToken, sessionId);
            return marked ? 'already_closed' : 'skipped';
          }
          if (rechecked === 'retryable') {
            return await this.failOwned(fresh, leaseToken, sessionId, {
              permanent: false,
              code: 'checkout_session_expire_uncertain',
            });
          }
          return await this.failOwned(fresh, leaseToken, sessionId, {
            permanent: true,
            code: 'checkout_session_expire_failed',
          });
        }

        const after = this.proveSessionIdentity(fresh, expiredSession, sessionId);
        if (!after.ok) {
          return await this.failOwned(fresh, leaseToken, sessionId, {
            permanent: after.permanent,
            code: after.code,
          });
        }
        // Expire must yield an explicit expired status (not arbitrary non-open).
        if (after.status !== 'expired') {
          return await this.failOwned(fresh, leaseToken, sessionId, {
            permanent: false,
            code:
              after.status === 'open'
                ? 'checkout_session_still_open'
                : 'checkout_session_expire_status_unexpected',
          });
        }
        const marked = await this.markCompleted(fresh.id, leaseToken, sessionId);
        return marked ? 'expired' : 'skipped';
      }

      // Explicit identity-matched complete/expired only — never arbitrary status.
      if (proof.status === 'complete' || proof.status === 'expired') {
        const marked = await this.markCompleted(fresh.id, leaseToken, sessionId);
        return marked ? 'already_closed' : 'skipped';
      }

      return await this.failOwned(fresh, leaseToken, sessionId, {
        permanent: false,
        code: 'checkout_session_status_unknown',
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(getErrorText(err));
      this.logger.warn(`Checkout session cleanup ${fresh.id} failed: ${msg}`);
      return await this.failOwned(fresh, leaseToken, fresh.stripeCheckoutSessionId, {
        permanent: isPermanentSessionCleanupError(err),
        code: classifyCleanupErrorCode(err),
      });
    }
  }

  /**
   * Discover a provider Checkout Session for an attempt whose local Session ID
   * was never persisted. Matches metadata + client_reference only; never creates.
   */
  private async discoverSessionId(
    stripe: NonNullable<typeof this.stripe>,
    attempt: CleanupCandidate,
  ): Promise<
    | { kind: 'found'; sessionId: string }
    | { kind: 'unrecoverable'; code: string }
    | { kind: 'retryable'; code: string }
  > {
    const customerId = attempt.invoice.billingAccount?.stripeCustomerId;
    if (!customerId) {
      return { kind: 'unrecoverable', code: 'cleanup_customer_missing' };
    }
    try {
      const listed = await stripe.checkout.sessions.list({
        customer: customerId,
        limit: 100,
      });
      const data = Array.isArray(listed?.data) ? listed.data : [];
      if (data.length === 0) {
        return { kind: 'unrecoverable', code: 'cleanup_session_not_found' };
      }
      const matches = data.filter((session) => {
        const proof = this.proveSessionIdentity(attempt, session, session?.id ?? null);
        return proof.ok;
      });
      if (matches.length === 0) {
        return { kind: 'unrecoverable', code: 'cleanup_session_identity_unrecoverable' };
      }
      if (matches.length > 1) {
        return { kind: 'unrecoverable', code: 'cleanup_session_ambiguous_match' };
      }
      const id = matches[0]?.id;
      if (typeof id !== 'string' || !id.startsWith('cs_')) {
        return { kind: 'retryable', code: 'cleanup_session_id_empty' };
      }
      return { kind: 'found', sessionId: id };
    } catch (err) {
      if (isRetryableProviderError(err)) {
        return { kind: 'retryable', code: 'cleanup_session_list_transient' };
      }
      return { kind: 'retryable', code: 'cleanup_session_list_failed' };
    }
  }

  /**
   * Strict identity proof before expire or completion. Empty/partial sessions fail.
   */
  proveSessionIdentity(
    attempt: CleanupCandidate,
    session: Stripe.Checkout.Session | null | undefined,
    expectedSessionId: string | null,
  ): IdentityProof {
    if (!session || typeof session !== 'object') {
      return { ok: false, code: 'checkout_session_empty', permanent: false };
    }
    if (typeof session.id !== 'string' || !session.id.startsWith('cs_')) {
      return { ok: false, code: 'checkout_session_id_missing', permanent: false };
    }
    if (expectedSessionId != null && session.id !== expectedSessionId) {
      return { ok: false, code: 'checkout_session_id_mismatch', permanent: true };
    }
    // When expectedSessionId is null (discovery), local row must not already
    // bind a different session.
    if (
      expectedSessionId == null &&
      attempt.stripeCheckoutSessionId != null &&
      attempt.stripeCheckoutSessionId !== session.id
    ) {
      return { ok: false, code: 'checkout_session_id_mismatch', permanent: true };
    }

    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return { ok: false, code: 'checkout_metadata_missing', permanent: true };
    }
    const period = formatUtcMonth(attempt.invoice.periodStart);
    if (
      metadata.invoiceId !== attempt.invoiceId ||
      metadata.attemptId !== attempt.id ||
      metadata.period !== period
    ) {
      return { ok: false, code: 'checkout_metadata_binding_mismatch', permanent: true };
    }
    if (session.client_reference_id !== attempt.invoiceId) {
      return { ok: false, code: 'checkout_client_reference_mismatch', permanent: true };
    }

    const customerId = providerCustomerId(session.customer);
    const expectedCustomer = attempt.invoice.billingAccount?.stripeCustomerId ?? null;
    if (!customerId || !expectedCustomer || customerId !== expectedCustomer) {
      return { ok: false, code: 'checkout_customer_mismatch', permanent: true };
    }

    if (
      typeof session.currency !== 'string' ||
      session.currency.toLowerCase() !== attempt.currency.toLowerCase()
    ) {
      return { ok: false, code: 'checkout_currency_mismatch', permanent: true };
    }
    const expectedCents = Number(attempt.amountMicros / MICROS_PER_CENT);
    if (
      !Number.isSafeInteger(expectedCents) ||
      typeof session.amount_total !== 'number' ||
      session.amount_total !== expectedCents
    ) {
      return { ok: false, code: 'checkout_amount_mismatch', permanent: true };
    }

    // Mode must match charge kind.
    if (attempt.stripeChargeKind === STRIPE_CHARGE_KIND_FIXED_FEE) {
      if (session.mode !== 'subscription') {
        return { ok: false, code: 'checkout_subscription_mode_required', permanent: true };
      }
    } else {
      if (session.mode !== 'payment') {
        return { ok: false, code: 'checkout_payment_mode_required', permanent: true };
      }
    }

    const status = typeof session.status === 'string' ? session.status : null;
    if (status === 'open' || status === 'complete' || status === 'expired') {
      return { ok: true, sessionId: session.id, status };
    }
    // Null/empty/arbitrary status is never a durable closed outcome.
    return { ok: false, code: 'checkout_session_status_unknown', permanent: false };
  }

  /**
   * After expire throws: re-retrieve and only finish on identity-matched
   * complete/expired. Bare resource_missing / ambiguous errors stay uncertain.
   */
  private async recheckClosedAfterExpireError(
    stripe: NonNullable<typeof this.stripe>,
    attempt: CleanupCandidate,
    sessionId: string,
    expireErr: unknown,
  ): Promise<'already_closed' | 'retryable' | 'permanent'> {
    try {
      const again = await stripe.checkout.sessions.retrieve(sessionId);
      const proof = this.proveSessionIdentity(attempt, again, sessionId);
      if (proof.ok && (proof.status === 'expired' || proof.status === 'complete')) {
        return 'already_closed';
      }
      if (proof.ok && proof.status === 'open') {
        return isRetryableProviderError(expireErr) ? 'retryable' : 'permanent';
      }
      // resource_missing on retrieve after expire is uncertain without identity.
      return 'retryable';
    } catch {
      return 'retryable';
    }
  }

  private async markCompleted(
    attemptId: string,
    leaseToken: string,
    sessionId: string,
  ): Promise<boolean> {
    const attempts = this.prisma.billingPaymentAttempt as any;
    const done = await attempts.updateMany({
      where: {
        id: attemptId,
        sessionCleanupOwnerId: leaseToken,
        sessionCleanupCompletedAt: null,
        stripeCheckoutSessionId: sessionId,
        sessionCleanupLeaseExpiresAt: { gt: new Date() },
      },
      data: {
        sessionCleanupStatus: SESSION_CLEANUP_STATUS_COMPLETED,
        sessionCleanupCompletedAt: new Date(),
        sessionCleanupOwnerId: null,
        sessionCleanupLeaseExpiresAt: null,
        sessionCleanupNextRetryAt: null,
      },
    });
    return done.count === 1;
  }

  private async failOwned(
    attempt: CleanupCandidate,
    leaseToken: string,
    sessionId: string | null,
    opts: { permanent: boolean; code: string },
  ): Promise<'needs_review' | 'retryable' | 'skipped'> {
    const attempts = this.prisma.billingPaymentAttempt as any;
    const retryCount = attempt.sessionCleanupRetryCount ?? 1;
    const exhausted = opts.permanent || retryCount >= STRIPE_SESSION_CLEANUP_MAX_RETRIES;
    const fence = {
      id: attempt.id,
      sessionCleanupOwnerId: leaseToken,
      sessionCleanupCompletedAt: null,
      sessionCleanupLeaseExpiresAt: { gt: new Date() },
      ...(sessionId != null ? { stripeCheckoutSessionId: sessionId } : {}),
    };

    if (exhausted) {
      const reviewed = await attempts.updateMany({
        where: fence,
        data: {
          sessionCleanupStatus: SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
          sessionCleanupOwnerId: null,
          sessionCleanupLeaseExpiresAt: null,
          sessionCleanupNextRetryAt: null,
          // Never mutate attempt payment status / paid invoice facts.
        },
      });
      if (reviewed.count === 1) {
        this.logger.warn(`Checkout session cleanup ${attempt.id} needs_review code=${opts.code}`);
        return 'needs_review';
      }
      return 'skipped';
    }

    const backoff = Math.min(
      STRIPE_SESSION_CLEANUP_BACKOFF_MS * 2 ** Math.min(retryCount, 6),
      24 * 60 * 60 * 1000,
    );
    const rescheduled = await attempts.updateMany({
      where: fence,
      data: {
        sessionCleanupStatus: SESSION_CLEANUP_STATUS_PENDING,
        sessionCleanupOwnerId: null,
        sessionCleanupLeaseExpiresAt: null,
        sessionCleanupNextRetryAt: new Date(Date.now() + backoff),
      },
    });
    return rescheduled.count === 1 ? 'retryable' : 'skipped';
  }

  private async releaseLease(
    attemptId: string,
    leaseToken: string,
    opts: {
      undoRetryIncrement: boolean;
      priorRetryCount: number;
      /** When true, clear status to null (no cleanup backlog). Default: pending. */
      clearCleanupStatus?: boolean;
    },
  ): Promise<void> {
    const attempts = this.prisma.billingPaymentAttempt as any;
    await attempts.updateMany({
      where: {
        id: attemptId,
        sessionCleanupOwnerId: leaseToken,
        sessionCleanupCompletedAt: null,
      },
      data: {
        sessionCleanupStatus: opts.clearCleanupStatus ? null : SESSION_CLEANUP_STATUS_PENDING,
        sessionCleanupOwnerId: null,
        sessionCleanupLeaseExpiresAt: null,
        sessionCleanupNextRetryAt: opts.clearCleanupStatus ? null : undefined,
        ...(opts.undoRetryIncrement
          ? { sessionCleanupRetryCount: Math.max(0, opts.priorRetryCount - 1) }
          : {}),
      },
    });
  }

  /**
   * Fully paid = settlement markers present AND cumulative coverage meets the
   * frozen total. Cleanup must never run on partial coverage.
   */
  isInvoiceFullyPaid(invoice: {
    paidAt: Date | null;
    settlementAttemptId: string | null;
    totalMicros: bigint;
    allocatedMicros: bigint | null;
  }): boolean {
    if (invoice.paidAt == null) return false;
    if (invoice.settlementAttemptId == null) return false;
    const allocated = invoice.allocatedMicros ?? 0n;
    return allocated >= invoice.totalMicros;
  }
}

function providerCustomerId(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('cus_')) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    const id = (value as { id: string }).id;
    return id.startsWith('cus_') ? id : null;
  }
  return null;
}

/**
 * BILL-014: normal recurring Stripe invoice renewals are identified by a bound
 * provider invoice + subscription with no Checkout Session. These attempts never
 * created a Checkout Session, so late Session discovery must not select them.
 *
 * Known `stripeCheckoutSessionId` rows remain eligible (Path A). Checkout-created
 * attempts missing a local session id (no invoice+subscription pair) remain
 * eligible for legitimate late-ID recovery (Path B).
 */
export const RECURRING_STRIPE_INVOICE_RENEWAL_WHERE = {
  AND: [{ stripeInvoiceId: { not: null } }, { stripeSubscriptionId: { not: null } }],
} as const;

export function isRecurringStripeInvoiceRenewalAttempt(attempt: {
  stripeCheckoutSessionId?: string | null;
  stripeInvoiceId?: string | null;
  stripeSubscriptionId?: string | null;
}): boolean {
  return (
    attempt.stripeCheckoutSessionId == null &&
    attempt.stripeInvoiceId != null &&
    attempt.stripeSubscriptionId != null
  );
}

export function isRetryableProviderError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    raw?: { code?: unknown; statusCode?: unknown };
  };
  const status = Number(e.statusCode ?? e.status ?? e.raw?.statusCode ?? 0);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = String(e.code ?? e.raw?.code ?? '');
  return code === 'rate_limit' || code === 'lock_timeout';
}

/**
 * Permanent cleanup failures (identity/validation) vs retryable 429/5xx.
 * Uncertain provider errors (including bare resource_missing) stay retryable
 * until the budget is exhausted — never auto-completed.
 */
export function isPermanentSessionCleanupError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    permanent?: unknown;
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    raw?: { code?: unknown; statusCode?: unknown };
  };
  if (e.permanent === true) return true;
  if (isRetryableProviderError(err)) return false;
  const code = String(e.code ?? e.raw?.code ?? '');
  // resource_missing alone is uncertain without a successful identity-matched
  // re-retrieve proving closed state.
  if (code === 'resource_missing') return false;
  if (
    code === 'checkout_session_id_mismatch' ||
    code === 'checkout_metadata_binding_mismatch' ||
    code === 'checkout_customer_mismatch' ||
    code === 'checkout_client_reference_mismatch' ||
    code === 'checkout_amount_mismatch' ||
    code === 'checkout_currency_mismatch' ||
    code === 'checkout_metadata_missing' ||
    code === 'checkout_payment_mode_required' ||
    code === 'checkout_subscription_mode_required' ||
    code === 'cleanup_session_identity_unrecoverable' ||
    code === 'cleanup_session_ambiguous_match' ||
    code === 'cleanup_session_not_found' ||
    code === 'cleanup_customer_missing'
  ) {
    return true;
  }
  return false;
}

export function classifyCleanupErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'cleanup_provider_error';
  const e = err as { code?: unknown; raw?: { code?: unknown } };
  const code = String(e.code ?? e.raw?.code ?? '');
  if (code) return code.slice(0, 80);
  return 'cleanup_provider_error';
}

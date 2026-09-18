import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import * as Stripe from 'stripe';
import { PrismaService } from '../../core/database/prisma.service';
import { getErrorText, sanitizeErrorMessage } from '../../common/utils/sanitize';
import { SecurityEventService } from '../security-events/security-event.service';
import { BillingService } from './billing.service';
import { formatUtcMonth } from './billing.utils';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingPlanChangeService } from './billing-plan-change.service';
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { StripeSubscriptionSyncService } from './stripe/stripe-subscription-sync.service';
import { StripeAutoSubscriptionService } from './stripe/stripe-auto-subscription.service';
import {
  STRIPE_CHARGE_KIND_OVERAGE,
  STRIPE_CLIENT,
  STRIPE_DEFERRED_BACKOFF_MS,
  STRIPE_DEFERRED_MAX_RETRIES,
} from './stripe/stripe.constants';

/** Accounts scanned per worker tick (keyset pagination page size). */
const ACCOUNT_PAGE_SIZE = 50;
/** Bounded reconciliation drain pages per account per tick. */
const RECONCILE_PAGES_PER_ACCOUNT = 5;
/** Bounded batch of due USDC claims per tick. */
const USDC_CLAIM_BATCH = 100;
/** Bounded batch of deferred Stripe events retried per tick. */
const STRIPE_DEFERRED_BATCH = 50;
/** Bounded batch of pending overage charges recovered per tick. */
const OVERAGE_RECOVERY_BATCH = 50;
/** Bounded automatic overage charges created per account per tick. */
const OVERAGE_CHARGE_PER_ACCOUNT = 5;
/**
 * Bounded number of distinct historical UTC periods (backed by posted usage-ledger
 * activity) whose open invoice is backfilled per account per tick. Keeps the
 * historical materialization bounded so a single account cannot monopolize a tick.
 */
const HISTORICAL_PERIOD_BACKFILL = 24;
/** Scheduler interval for the worker pass (5 minutes). */
const WORKER_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Aggregate success/failure contract of one bounded worker stage or one
 * account within a stage. `true` means every scoped attempt/period completed
 * successfully (or there was no scoped work at all); `false` means at least
 * one scoped failure occurred and the overall tick heartbeat must report
 * `failed` (and increment the consecutive-failure counter) while unrelated
 * accounts/stages keep processing. Scoped failures never throw out of the
 * scheduler for isolated account/item errors.
 */
type StageResult = boolean;

/**
 * Phase 1 billing worker seam (Oracle gate).
 *
 * A separate worker service (not a cron that merely iterates users) that
 * drains receipt reconciliation, runs invoice finalization catch-up, resumes
 * active USDC claims, and retries deferred Stripe renewal events. Enabled only
 * by an explicit env flag (default safely off). Cross-instance correctness
 * comes from the shared PostgreSQL period advisory lock (BillingService) plus
 * DB-backed run leases/heartbeats — never an in-memory lock or Redis. RPC and
 * Stripe calls are never inside a DB transaction.
 *
 * The worker is not a controller and exposes no route; it only reuses the
 * existing evidence-backed services (reconciliation, finalization, USDC claim
 * verification, Stripe webhook processing) rather than duplicating them.
 */
@Injectable()
export class BillingWorkerService implements OnModuleInit {
  private readonly logger = new Logger(BillingWorkerService.name);
  private readonly workerId = `billing-worker-${randomUUID().slice(0, 8)}`;
  private enabled = false;
  /** In-process single-flight guard: a second tick returns without overlapping. */
  private ticking = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly reconciliation: BillingReconciliationService,
    private readonly usdc: UsdcPaymentService,
    private readonly webhook: StripeWebhookService,
    private readonly securityEvents: SecurityEventService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
    @Optional() private readonly stripePayments?: StripePaymentService,
    @Optional() private readonly planChanges?: BillingPlanChangeService,
    @Optional() private readonly subscriptionSync?: StripeSubscriptionSyncService,
    @Optional() private readonly autoSubscription?: StripeAutoSubscriptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.enabled = this.config.get<boolean>('billing.worker.enabled') === true;
    if (this.enabled) {
      // Enabled module init may upsert `starting` so a freshly booted worker is
      // observable (but not yet healthy) before its first tick completes.
      await this.writeHeartbeat('starting');
      this.logger.log(
        `Billing worker enabled (workerId=${this.workerId}, interval=${WORKER_INTERVAL_MS}ms)`,
      );
    } else {
      this.logger.log('Billing worker is disabled (set BILLING_WORKER_ENABLED=true to enable)');
    }
  }

  /**
   * One worker pass: reconcile+finalize, USDC claim recovery, Stripe retry.
   *
   * Single-flight guard: a second concurrent tick returns immediately without
   * touching the database — the in-process guard guarantees no same-process
   * overlap. Cross-instance overlap is prevented by the DB-backed active-run
   * acquisition/lease in BillingReconciliationService.
   *
   * Health is aggregate: `healthy` (and the consecutive-failure reset) is only
   * written when EVERY bounded stage/account completed successfully. Scoped
   * failures (per account/item/period) are sanitized-logged at their own scope
   * and flip the aggregate instead of throwing, so unrelated accounts/stages
   * still process and the single-flight guard is released in `finally`.
   */
  @Interval(WORKER_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.ticking) {
      this.logger.warn('Billing worker tick skipped: a previous tick is still running');
      return;
    }
    this.ticking = true;
    try {
      // Immediately before the bounded tick work: mark running and refresh the
      // heartbeat/started markers so readiness can see an active-tick window.
      await this.writeHeartbeat('running', { started: true });
      // Every bounded stage reports an aggregate success/failure result. Scoped
      // failures never throw out of the scheduler; they only flip the aggregate
      // so the final heartbeat is `failed` while unrelated work still runs.
      // Subscription sync + first auto-subscription before lower-priority recovery.
      let ok = await this.processSubscriptionSync();
      ok = (await this.processAutoSubscriptions()) && ok;
      ok = (await this.reconcileAndFinalizeAll()) && ok;
      ok = (await this.applyDuePlanChanges()) && ok;
      ok = (await this.recoverUsdcClaims()) && ok;
      ok = (await this.recoverOverageCharges()) && ok;
      ok = (await this.retryDeferredStripeEvents()) && ok;
      if (this.stripePayments) {
        const checkout = await this.stripePayments.recoverPendingCheckouts(this.workerId);
        // A needs_review checkout (operator review required) or a retryable
        // checkout (this worker's recovery did not complete and rescheduled a
        // non-exhausted retry) means the recovery did not complete — the tick
        // must report failed. Benign lease/CAS misses are never counted.
        if (checkout && (checkout.needsReview > 0 || checkout.retryable > 0)) ok = false;
      }
      if (ok) {
        // Only after every bounded stage/account completed successfully: mark
        // healthy, record success, and reset the consecutive-failure counter.
        await this.writeHeartbeat('healthy', { success: true });
      } else {
        // At least one bounded stage did not complete: report failed and
        // increment the consecutive-failure counter. Unrelated accounts/stages
        // were already processed above; the single-flight guard is reset in
        // finally. A heartbeat DB write failure is sanitized inside
        // writeHeartbeat and never masks this aggregate result.
        await this.writeHeartbeat('failed', { failure: true });
        this.logger.error(
          'Billing worker tick failed: one or more bounded stages did not complete (see scoped sanitized logs above)',
        );
      }
    } catch (error) {
      // Mark failed, record failure, refresh heartbeat, increment failures.
      await this.writeHeartbeat('failed', { failure: true });
      // Top-level sanitized failure logging: an unexpected failure in one pass
      // must never kill the scheduler loop or leak secrets/account/user data.
      // Individual account/attempt scopes already log sanitized failures above;
      // this catch is the last-resort boundary for anything that escaped them.
      this.logger.error(`Billing worker tick failed: ${sanitizeErrorMessage(getErrorText(error))}`);
    } finally {
      this.ticking = false;
    }
  }

  // ── Reconciliation drain + finalization catch-up ───────────────────────────

  /**
   * Walks billing accounts with keyset pagination (id cursor, never `skip`),
   * drains each account's reconciliation backlog per explicit target period in
   * bounded pages, and then finalizes any eligible open period that is both
   * ended (+24h grace) and free of unresolved risk. A large confirmed backlog
   * is drained across ticks because reconciled transactions carry
   * `billingReconciledAt` and are excluded from later scans.
   */
  private async reconcileAndFinalizeAll(): Promise<StageResult> {
    let ok = true;
    let cursor: string | undefined;
    for (;;) {
      const accounts = await this.prisma.billingAccount.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take: ACCOUNT_PAGE_SIZE,
        select: { id: true, userId: true, billingBackfillCursor: true },
      });
      if (accounts.length === 0) break;
      for (const account of accounts) {
        try {
          // Scoped per-account failures (thrown or reported) flip the aggregate;
          // unrelated accounts still drain in this and later ticks.
          if (!(await this.drainAccount(account))) ok = false;
        } catch (error) {
          ok = false;
          this.logger.error(
            `Billing worker reconciliation failed for account ${account.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
          );
        }
      }
      cursor = accounts[accounts.length - 1].id;
      if (accounts.length < ACCOUNT_PAGE_SIZE) break;
    }
    return ok;
  }

  private async drainAccount(account: {
    id: string;
    userId: string;
    billingBackfillCursor?: Date | null;
  }): Promise<StageResult> {
    const now = new Date();
    const currentPeriodStart = this.monthStart(now);
    const currentPeriodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    // P0 leak fix: ensure this account has an open invoice for its current UTC
    // period (even when it has no prior finalized invoice) and for any bounded
    // historical period that has posted usage-ledger activity and NO invoice
    // yet, so reconciled outbound usage can never remain unbilled. Returns the
    // successfully materialized period targets so they can be carried into this
    // same tick's reconciliation and finalization candidates — even when the
    // independently capped invoice queries below would not surface them.
    // Failures are per-period fail-closed (Enterprise/custom/malformed plans
    // never produce a zero invoice) and per-account isolated; a failed period
    // is never returned and therefore never becomes a candidate.
    const materialization = await this.ensureOpenInvoicesForAccount(
      account,
      currentPeriodStart,
      currentPeriodEnd,
    );
    // A fail-closed materialization (Enterprise/custom/malformed plan) never
    // creates a zero invoice; it is isolated per period but the period's work
    // did not complete, so the account/tick reports failed.
    let ok = materialization.ok;
    const materialized = materialization.materialized;

    // Enumerate this account's eligible target periods: the current UTC period
    // plus every open invoice period, plus this tick's materialized periods.
    // Each period is reconciled with the explicit target scope so candidate
    // scans are account/period bounded and the worker never scans globally.
    const periods = new Map<string, { start: Date; end: Date }>();
    // Add current after loading historical invoices; iteration is explicitly
    // sorted below so older eligible periods drain before the current period.
    const openInvoices = await this.prisma.billingInvoice.findMany({
      where: {
        billingAccountId: account.id,
        status: 'open',
        purpose: 'usage_period',
      },
      select: { periodStart: true, periodEnd: true },
      orderBy: { periodStart: 'asc' },
      take: 20,
    });
    for (const invoice of openInvoices) {
      if (!invoice.periodEnd) continue;
      periods.set(invoice.periodStart.toISOString(), {
        start: invoice.periodStart,
        end: invoice.periodEnd,
      });
    }
    // Merge the successfully materialized periods (deduplicated by UTC period)
    // so same-tick reconciliation is guaranteed even when the open-invoice
    // query is capped below the materialized set.
    for (const { start, end } of materialized) {
      periods.set(start.toISOString(), { start, end });
    }
    periods.set(currentPeriodStart.toISOString(), {
      start: currentPeriodStart,
      end: currentPeriodEnd,
    });

    let lostOwnership = false;
    let unresolved = false;
    for (const { start, end } of [...periods.values()].sort(
      (a, b) => a.start.getTime() - b.start.getTime(),
    )) {
      for (let page = 0; page < RECONCILE_PAGES_PER_ACCOUNT; page++) {
        const result = await this.reconciliation.reconcile(account.userId, {
          limit: 200,
          workerId: this.workerId,
          targetPeriodStart: start,
          targetPeriodEnd: end,
        });
        // A live concurrent worker owns the active run for this period — never
        // overlap; another instance will finish the drain. Expected lease
        // ownership by another worker is NOT a failure.
        if (result.skipped) break;
        // This worker lost lease ownership mid-run (taken over by another
        // instance): STOP immediately and never finalize — the takeover owner
        // resumes from the persisted progress markers. Ownership loss is not a
        // failure; the takeover owner reports its own progress.
        if (result.ownershipLost) {
          lostOwnership = true;
          break;
        }
        if (result.scanned === 0) break;
        // Unresolved no-hash / notFound / transient / error / conflict work
        // blocks finalization; stop draining this period for this tick
        // (bounded retry). Unresolved reconciliation means the account's work
        // did not complete, so the tick reports failed.
        if (
          result.notFound > 0 ||
          result.transientError > 0 ||
          result.errors > 0 ||
          result.conflicts > 0 ||
          result.noHash > 0 ||
          result.quarantined > 0 ||
          result.retryable > 0
        ) {
          unresolved = true;
          break;
        }
        if (result.scanned < 200) break;
      }
      if (lostOwnership) break;
    }

    // Ownership was lost: never attempt finalization for this account. The
    // takeover owner owns the runs now and will finalize after its own clean
    // drain. Ownership loss is benign for heartbeat purposes.
    if (lostOwnership) {
      this.logger.warn(
        `Billing worker lost reconciliation ownership for account ${account.id}; skipping finalization`,
      );
      return ok;
    }

    ok = ok && !unresolved;
    ok = (await this.materializeDueRecurringPeriod(account, now)) && ok;
    ok = (await this.finalizeEligiblePeriods(account, materialized)) && ok;
    ok = (await this.recoverUnallocatedFixedFee(account)) && ok;
    ok = (await this.attemptRenewalOverage(account)) && ok;
    return ok;
  }

  // ── Open-invoice materialization (P0 unbilled-usage leak fix) ──────────────

  /**
   * Ensures this account has an open invoice for the current UTC period and for
   * a bounded, advancing set of historical periods that have posted
   * usage-ledger activity but no invoice yet. Uses the shared
   * `BillingService.ensureOpenInvoiceForPeriod` seam exclusively — never a
   * direct invoice create — so idempotency, the per-account/period advisory
   * lock, and the fail-closed plan gate (an Enterprise/custom/malformed plan
   * throws inside the seam BEFORE any write, so no zero invoice is ever
   * created) all come from the authority that owns invoice materialization.
   *
   * Historical selection is a parameterized `$queryRaw` missing-invoice query:
   * distinct UTC months (normalized via the EXPLICIT 3-arg Postgres
   * `date_trunc('month', ..., 'UTC')` — never the session-timezone-dependent
   * 2-arg form) with account-scoped `posted`/`usage` activity and NO invoice
   * for that account/month, bounded to 24 per account/tick. Because an existing
   * invoice for a normalized month excludes that month from the result,
   * periods that are already materialized never reappear.
   *
   * Selection is a deterministic circular traversal over the account's durable
   * `billingBackfillCursor` (a single DateTime used as a ring position): months
   * strictly AFTER the cursor first (oldest-first), then a wrap to months
   * at/before the cursor (oldest-first). After the selected periods are
   * attempted, the cursor is advanced to the LAST selected historical month in
   * that circular order — even when every selected month is at/before the read
   * cursor (a pure wrap) — via an optimistic CAS on the exact cursor value read
   * this tick. A numeric decrease across a wrap is intentional logical ring
   * movement, never a forbidden regression: it keeps the traversal rotating so
   * a permanently failing period cannot occupy the whole window and is instead
   * retried on a later lap, while newer valid months — including later wrapped
   * months when more than 24 remain missing — are all eventually reached.
   *
   * The current-period call is what closes the original leak: an account with
   * no prior finalized invoice (first billing period) was previously skipped by
   * `materializeDueRecurringPeriod` (which requires a finalized predecessor) and
   * therefore never got a current-period invoice, so its usage could never be
   * billed. The historical backfill additionally guarantees that reconciled
   * outbound usage from periods that predate the current month cannot remain
   * unbilled. Both are idempotent: already-existing invoices (open, finalized,
   * or otherwise) are returned unchanged by the seam, and repeated ticks never
   * create duplicates.
   *
   * Returns ONLY the successfully materialized period targets (start/end, and
   * the created invoice id when available). A period whose seam call fails
   * (e.g. Enterprise/custom/malformed plan) is logged, never returned, and
   * therefore never becomes a reconciliation or finalization candidate.
   * Materialization runs BEFORE the drain's candidate enumeration so a newly
   * materialized historical period is reconciled and finalized in the SAME tick
   * (see `drainAccount`).
   */
  private async ensureOpenInvoicesForAccount(
    account: { id: string; userId: string; billingBackfillCursor?: Date | null },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
  ): Promise<{ materialized: Array<{ start: Date; end: Date; invoiceId?: string }>; ok: boolean }> {
    const materialized: Array<{ start: Date; end: Date; invoiceId?: string }> = [];
    // Aggregates fail-closed materialization failures: a thrown seam call is
    // per-period isolated and never returned (so it never becomes a candidate),
    // but the period's work did not complete, so the account/tick reports
    // failed even though the other periods and accounts still processed.
    let ok = true;
    const readCursor = account.billingBackfillCursor ?? null;

    // Deterministic, bounded, ADVANCING selection of distinct historical UTC
    // months that have account-scoped posted usage and NO invoice yet. The
    // `NOT EXISTS` on the invoice's unique (billingAccountId, periodStart) key
    // excludes any month that already has an invoice for this account, so
    // already-materialized months never reappear.
    //
    // Circular cursor ordering (single CTE): months strictly AFTER the durable
    // cursor are selected first (oldest-first), then the selection WRAPS to
    // months at/before the cursor (still oldest-first). The cursor is a ring
    // position, not a high-water mark: it advances past selected months even
    // across the wrap, so a permanently failing older month cannot occupy the
    // whole window forever — the cursor rotates, later valid months are
    // reached, and the failed month is retried on a later lap.
    //
    // All month truncation uses the EXPLICIT 3-arg Postgres `date_trunc(...,
    // 'UTC')` form in SELECT, GROUP BY, ORDER BY, and the invoice NOT EXISTS
    // comparison — never the session-timezone-dependent 2-arg form.
    const historical = await this.prisma.$queryRaw<Array<{ period_start: Date }>>`
      WITH missing AS (
        SELECT date_trunc('month', u."period_start", 'UTC')::timestamptz AS m
        FROM "billing_usage_events" u
        WHERE u."billing_account_id" = ${account.id}::uuid
          AND u."status" = 'posted'
          AND u."entry_type" = 'usage'
          AND date_trunc('month', u."period_start", 'UTC') < ${currentPeriodStart}
          AND NOT EXISTS (
            SELECT 1 FROM "billing_invoices" i
            WHERE i."billing_account_id" = u."billing_account_id"
              AND i."period_start" = date_trunc('month', u."period_start", 'UTC')
              AND i."purpose" = 'usage_period'
          )
        GROUP BY date_trunc('month', u."period_start", 'UTC')
      ),
      ranked AS (
        SELECT m,
          CASE
            WHEN ${readCursor}::timestamptz IS NULL OR m > ${readCursor}::timestamptz THEN 0
            ELSE 1
          END AS grp
        FROM missing
      )
      SELECT m AS "period_start"
      FROM ranked
      ORDER BY grp ASC, m ASC
      LIMIT ${HISTORICAL_PERIOD_BACKFILL}`;

    // Candidate set: the current UTC period plus every normalized historical
    // month returned above. Normalization to UTC month boundaries is applied
    // defensively in TypeScript too (idempotent on already-normalized values)
    // so a raw row at a non-midnight instant still yields a clean [start, end).
    const candidates = new Map<string, { start: Date; end: Date }>();
    candidates.set(currentPeriodStart.toISOString(), {
      start: currentPeriodStart,
      end: currentPeriodEnd,
    });
    for (const row of historical) {
      const start = this.monthStart(row.period_start);
      candidates.set(start.toISOString(), {
        start,
        end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
      });
    }

    // Oldest first for deterministic ordering; each call is individually
    // fail-closed (a thrown seam error is logged and skipped) so one
    // Enterprise/custom/malformed plan period never aborts the other periods
    // of this account or any unrelated account.
    const sorted = [...candidates.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const { start, end } of sorted) {
      const period = formatUtcMonth(start);
      try {
        const invoice = await this.billing.ensureOpenInvoiceForPeriod(account.userId, period);
        materialized.push({ start, end, invoiceId: invoice?.id });
      } catch (error) {
        ok = false;
        this.logger.warn(
          `Billing worker could not materialize open invoice for user ${account.userId} period ${period}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }

    // Advance the durable circular cursor to the LAST historical month selected
    // this tick in the query's circular order. `$queryRaw` returns the rows in
    // that order (after-cursor oldest-first, then wrapped at/before-cursor
    // oldest-first), so the final row of the result is the traversal frontier.
    // Even a pure wrap-around selection (every selected month at/before the
    // read cursor) advances the cursor, so a wrapped region larger than the
    // 24-row bound can never repeat its same oldest 24 forever: the next tick
    // resumes just past the last processed month and the traversal keeps
    // rotating until every missing month is reached. A numeric decrease across
    // a wrap is intentional logical ring movement, not a regression — a
    // permanently failing period is retried on a later lap while newer valid
    // months are still reached. Never advanced when no historical rows were
    // selected. The update stays an optimistic CAS on the exact cursor value
    // read this tick (account id + cursor/null), so a concurrent worker that
    // already persisted a different cursor is never overwritten by a stale
    // worker.
    const lastSelected = historical[historical.length - 1]?.period_start ?? null;
    if (lastSelected) {
      await this.advanceBackfillCursor(account.id, readCursor, lastSelected);
    }

    return { materialized, ok };
  }

  /**
   * Optimistic CAS advance of the durable circular historical-backfill cursor.
   * The predicate pins `billingBackfillCursor` to the exact value this worker
   * originally read (account id + cursor/null), so a concurrent worker that
   * already persisted a DIFFERENT cursor — whether numerically newer or an
   * intentional wrap decrease — matches zero rows and is never overwritten by
   * this stale worker. `newCursor` may be numerically lower than `readCursor`
   * on a legitimate wrap; the CAS is what makes that ring movement safe across
   * instances. A thrown update (or a CAS miss) is sanitized/logged and never
   * creates invoices or aborts unrelated account processing.
   */
  private async advanceBackfillCursor(
    accountId: string,
    readCursor: Date | null,
    newCursor: Date,
  ): Promise<void> {
    try {
      await this.prisma.billingAccount.updateMany({
        where: {
          id: accountId,
          ...(readCursor === null
            ? { billingBackfillCursor: null }
            : { billingBackfillCursor: readCursor }),
        },
        data: { billingBackfillCursor: newCursor },
      });
    } catch (error) {
      this.logger.warn(
        `Billing worker could not advance backfill cursor for account ${accountId}: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
    }
  }

  // ── Renewal fixed-fee allocation catch-up ──────────────────────────────────

  /**
   * Finds finalized unpaid invoices whose succeeded fixed-fee attempt was
   * never allocated (the post-commit allocation in `finalizeInvoice` can fail
   * after the finalize transaction already committed) and retries the
   * allocation via the shared boundary. This makes the renewal flow resilient:
   * a transient post-commit failure never leaves an invoice permanently stuck
   * with a succeeded-but-unallocated fixed fee, and once allocated the overage
   * worker can collect the remainder. Idempotent and bounded per account/tick.
   */
  private async recoverUnallocatedFixedFee(account: {
    id: string;
    userId: string;
  }): Promise<StageResult> {
    const candidates = await this.prisma.billingInvoice.findMany({
      where: {
        billingAccountId: account.id,
        status: 'finalized',
        purpose: 'usage_period',
        paidAt: null,
        settlementAttemptId: null,
        paymentAttempts: {
          some: {
            method: 'stripe',
            stripeChargeKind: 'fixed_fee',
            status: 'succeeded',
            allocatedAt: null,
          },
        },
      },
      orderBy: { periodStart: 'asc' },
      take: OVERAGE_CHARGE_PER_ACCOUNT,
    });
    let ok = true;
    for (const invoice of candidates ?? []) {
      try {
        await this.billing.recoverRenewalAllocation(invoice.id);
      } catch (error) {
        // The fixed-fee allocation recovery did not complete — scoped failure.
        ok = false;
        this.logger.warn(
          `Billing worker fixed-fee allocation recovery failed for invoice ${invoice.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
    return ok;
  }

  // ── Renewal overage (automatic remainder collection) ──────────────────────

  /**
   * Triggers the automatic overage charge for this account's finalized renewal
   * invoices: after the local invoice is frozen and the fixed-fee renewal
   * coverage has been allocated, the remainder (`totalMicros - allocatedMicros`)
   * is charged off-session. All safety gates live in
   * `StripePaymentService.chargeRenewalOverage`; the worker only supplies the
   * candidate invoices (already filtered to finalized/unpaid renewal invoices
   * with allocated fixed-fee coverage) and sanitized audits. The amount is
   * persisted on the attempt at creation and never recomputed per tick.
   */
  private async attemptRenewalOverage(account: {
    id: string;
    userId: string;
  }): Promise<StageResult> {
    if (!this.stripePayments || !this.stripe) return true;
    const accountRow = await this.prisma.billingAccount.findUnique({
      where: { id: account.id },
    });
    if (!accountRow?.stripeCustomerId) return true;
    const candidates = await this.prisma.billingInvoice.findMany({
      where: {
        billingAccountId: account.id,
        status: 'finalized',
        purpose: 'usage_period',
        paidAt: null,
        settlementAttemptId: null,
        periodEnd: { lte: new Date() },
        paymentAttempts: {
          some: {
            method: 'stripe',
            stripeChargeKind: 'fixed_fee',
            status: 'succeeded',
            allocatedAt: { not: null },
          },
        },
      },
      orderBy: { periodStart: 'asc' },
      take: OVERAGE_CHARGE_PER_ACCOUNT,
    });
    let ok = true;
    for (const invoice of candidates) {
      const remainder = invoice.totalMicros - (invoice.allocatedMicros ?? 0n);
      if (remainder <= 0n) continue;
      try {
        const outcome = await this.stripePayments.chargeRenewalOverage(
          accountRow,
          invoice,
          this.workerId,
        );
        if (outcome === 'needs_review') {
          // Fail-closed: no default PM / requires_action / retries exhausted —
          // the overage charge did not complete.
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.stripe.overage.needs_review',
            userId: account.userId,
            riskLevel: 'high',
            result: 'denied',
            reason: 'overage_failed_closed',
            metadata: {
              invoiceId: invoice.id,
              period: formatUtcMonth(invoice.periodStart),
              remainderMicros: remainder.toString(),
              workerId: this.workerId,
            },
          });
        } else if (outcome === 'failed') {
          // Definitive charge failure — the remainder was not collected.
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.stripe.overage.failed',
            userId: account.userId,
            riskLevel: 'medium',
            result: 'denied',
            reason: 'overage_charge_failed',
            metadata: {
              invoiceId: invoice.id,
              period: formatUtcMonth(invoice.periodStart),
              remainderMicros: remainder.toString(),
              workerId: this.workerId,
            },
          });
        }
      } catch (error) {
        ok = false;
        this.logger.warn(
          `Billing worker overage charge skipped for invoice ${invoice.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
    return ok;
  }

  /**
   * Resumes interrupted automatic overage charges. Two recovery paths, both
   * bounded and lease/backoff-guarded (fail-closed in the DB query AND the
   * atomic claim CAS — an attempt whose backoff is still in the future is never
   * touched even when its 2-minute lease has expired):
   *   * a pending attempt WITHOUT a persisted PaymentIntent id is re-issued
   *     through `recoverOverageCharge` — the SAME attempt id and therefore the
   *     SAME Stripe idempotency key, so a retry can never produce a second
   *     charge;
   *   * a pending attempt WITH a persisted PaymentIntent id is actively
   *     reconciled through `StripeWebhookService.reconcileOveragePaymentIntent`
   *     (retrieve, never create) so a lost webhook can never leave the payment
   *     stuck: succeeded PIs are settled through the shared coverage boundary,
   *     failed/canceled/SCA/identity-mismatch PIs are surfaced with a safe
   *     state, and processing/transient PIs stay pending with a re-check
   *     backoff.
   */
  private async recoverOverageCharges(): Promise<StageResult> {
    if (!this.stripePayments || !this.stripe) return true;
    const now = new Date();
    const due = await this.prisma.billingPaymentAttempt.findMany({
      where: {
        method: 'stripe',
        stripeChargeKind: STRIPE_CHARGE_KIND_OVERAGE,
        status: 'pending',
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
      orderBy: { createdAt: 'asc' },
      take: OVERAGE_RECOVERY_BATCH,
    });
    let ok = true;
    for (const attempt of due) {
      try {
        const outcome = attempt.stripePaymentIntentId
          ? await this.webhook.reconcileOveragePaymentIntent(attempt, this.workerId)
          : await this.stripePayments.recoverOverageCharge(attempt, this.workerId);
        if (outcome === 'needs_review') {
          // Fail-closed recovery exhaustion — operator action required.
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.stripe.overage.needs_review',
            riskLevel: 'high',
            result: 'denied',
            reason: 'overage_recovery_exhausted',
            metadata: {
              paymentAttemptId: attempt.id,
              invoiceId: attempt.invoiceId,
              workerId: this.workerId,
            },
          });
        } else if (outcome === 'failed') {
          // The PI was definitively canceled/declined — recovery did not complete.
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.stripe.overage.failed',
            riskLevel: 'medium',
            result: 'denied',
            reason: 'overage_charge_failed',
            metadata: {
              paymentAttemptId: attempt.id,
              invoiceId: attempt.invoiceId,
              workerId: this.workerId,
            },
          });
        }
      } catch (error) {
        // A thrown recovery failure is a scoped failure for the tick heartbeat.
        ok = false;
        this.logger.warn(
          `Billing worker overage recovery failed for attempt ${attempt.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
    return ok;
  }

  /**
   * Advance a proven recurring account after its latest local invoice has
   * closed. BillingService remains the authority that builds the invoice and
   * applies the period lock; this worker only supplies the deterministic next
   * UTC period once it is due. No provider data or provider call is involved.
   */
  private async materializeDueRecurringPeriod(
    account: { id: string; userId: string },
    now: Date,
  ): Promise<StageResult> {
    const invoices = this.prisma.billingInvoice as typeof this.prisma.billingInvoice & {
      findFirst?: (args: unknown) => Promise<any>;
    };
    if (typeof invoices.findFirst !== 'function') return true;
    // Only usage_period invoices drive recurring materialization. A finalized
    // plan_charge upgrade invoice must never be treated as the latest billing
    // period or suppress the next open usage invoice.
    const latest = await invoices.findFirst({
      where: {
        billingAccountId: account.id,
        status: 'finalized',
        purpose: 'usage_period',
      },
      orderBy: { periodStart: 'desc' },
      select: { periodEnd: true },
    });
    if (!latest?.periodEnd || latest.periodEnd > now) return true;

    const nextStart = latest.periodEnd as Date;
    const nextEnd = new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth() + 2, 1));
    const existing = await invoices.findFirst({
      where: {
        billingAccountId: account.id,
        periodStart: nextStart,
        purpose: 'usage_period',
      },
      select: { id: true },
    });
    if (existing) return true;

    const period = formatUtcMonth(nextStart);
    try {
      await this.billing.ensureOpenInvoiceForPeriod(account.userId, period);
      await this.audit({
        actorType: 'system',
        eventType: 'billing.invoice.recurring_materialized',
        userId: account.userId,
        riskLevel: 'low',
        result: 'allowed',
        metadata: { period, nextPeriodEnd: nextEnd.toISOString(), workerId: this.workerId },
      });
      return true;
    } catch (error) {
      // The recurring period was not materialized — scoped failure for the tick.
      this.logger.warn(
        `Billing worker recurring period ${period} skipped for user ${account.userId}: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
      return false;
    }
  }

  /**
   * Finalizes every period whose open invoice — owned by THIS account — is
   * past the end + 24h UTC grace window. The candidate query is filtered by
   * `billingAccountId` and a defensive ownership check re-proves the invoice
   * belongs to the account before `finalizeInvoice` is called (which itself
   * re-checks eligibility and unresolved risk inside the period lock). An
   * overdue invoice of another account can never trigger work for this account.
   *
   * The independently capped (`take: 20`) query is merged with the successfully
   * materialized period targets returned by `ensureOpenInvoicesForAccount` —
   * deduplicated by normalized UTC month — so a historical period that was
   * materialized THIS tick is finalized in the same tick even when the capped
   * query would not surface it. Only materialized targets whose period has
   * already ended past the 24h grace cutoff are considered finalization
   * candidates (the current UTC period is never finalizable here).
   */
  private async finalizeEligiblePeriods(
    account: { id: string; userId: string },
    materialized: Array<{ start: Date; end: Date; invoiceId?: string }> = [],
  ): Promise<StageResult> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const openInvoices = await this.prisma.billingInvoice.findMany({
      where: {
        billingAccountId: account.id,
        status: 'open',
        purpose: 'usage_period',
        periodEnd: { lte: cutoff },
      },
      select: { id: true, billingAccountId: true, periodStart: true },
      orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
      take: 20,
    });

    // Merge the capped query with this tick's materialized periods, deduped by
    // normalized UTC month. A materialized target only becomes a candidate if
    // its period has fully ended past the grace cutoff (its invoice was created
    // this tick) and it has an invoice id (i.e. the seam succeeded).
    const candidates = new Map<
      string,
      { id: string; billingAccountId: string; periodStart: Date }
    >();
    for (const invoice of openInvoices) {
      // Ownership proof: only invoices owned by this account may be finalized.
      if (invoice.billingAccountId !== account.id) continue;
      candidates.set(formatUtcMonth(invoice.periodStart), {
        id: invoice.id,
        billingAccountId: invoice.billingAccountId,
        periodStart: invoice.periodStart,
      });
    }
    for (const { start, end, invoiceId } of materialized) {
      if (!invoiceId) continue;
      // A materialized target is only a finalization candidate once its period
      // has fully ended past the 24h grace cutoff. The current UTC period
      // (end in the future) is therefore never finalizable here.
      if (!end || end.getTime() > cutoff.getTime()) continue;
      candidates.set(formatUtcMonth(start), {
        id: invoiceId,
        billingAccountId: account.id,
        periodStart: start,
      });
    }

    const sorted = [...candidates.values()].sort(
      (a, b) => a.periodStart.getTime() - b.periodStart.getTime(),
    );
    let ok = true;
    for (const invoice of sorted) {
      const period = formatUtcMonth(invoice.periodStart);
      try {
        await this.billing.finalizeInvoice(account.userId, period);
        await this.audit({
          actorType: 'system',
          eventType: 'billing.invoice.finalized',
          userId: account.userId,
          riskLevel: 'low',
          result: 'allowed',
          metadata: {
            period,
            invoiceId: invoice.id,
            workerId: this.workerId,
          },
        });
      } catch (error) {
        // A finalization failure is a scoped failure: the period's invoice was
        // not closed, so the account/tick reports failed (never a healthy
        // heartbeat for incomplete work) while other candidates still run.
        ok = false;
        this.logger.warn(
          `Billing worker finalization skipped for user ${account.userId} period ${period}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
    return ok;
  }

  // ── USDC active-claim recovery ─────────────────────────────────────────────

  /**
   * Resumes pending/confirming USDC claims whose persisted submitted hash is
   * due (nextCheckAt <= now). It reuses the existing `UsdcPaymentService.claim`
   * verification path with the canonical persisted hash — it never invents or
   * scans chain events, never fabricates hashes/receipts, and is guarded by the
   * claim's evidence-aware CAS. Bounded batch per tick.
   */
  /**
   * Applies scheduled downgrade/lateral plan changes whose effectiveAt has been
   * reached. Uses BillingPlanChangeService CAS + period locks; failures are
   * scoped and do not abort the rest of the tick.
   */
  private async applyDuePlanChanges(): Promise<StageResult> {
    if (!this.planChanges) return true;
    try {
      await this.planChanges.applyDueScheduledChanges(new Date(), 50);
      return true;
    } catch (error) {
      this.logger.warn(
        `Billing worker could not apply due plan changes: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
      return false;
    }
  }

  /** Process durable Stripe subscription mirror sync intents (outside DB TX). */
  private async processSubscriptionSync(): Promise<StageResult> {
    if (!this.subscriptionSync) return true;
    try {
      const result = await this.subscriptionSync.processDue(this.workerId, 25);
      // needs_review requires operator attention; retryable means this tick did
      // not finish the sync — report failed for heartbeat while other work continues.
      if (result.needsReview > 0 || result.retryable > 0) return false;
      return true;
    } catch (error) {
      this.logger.warn(
        `Billing worker subscription sync failed: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
      return false;
    }
  }

  /**
   * Process durable first-subscription create intents (outside DB TX).
   * Enqueued by Stripe webhook after a successful one-time Card settlement of a
   * plan_charge or fixed monthly usage_period invoice. PM attach/default +
   * Subscriptions.create use stable idempotency keys; needs_review/retryable
   * fail the tick heartbeat without rolling back paid benefits.
   */
  private async processAutoSubscriptions(): Promise<StageResult> {
    if (!this.autoSubscription) return true;
    try {
      // processDue also runs recoverMissingPaidIntents (paid full attempt, no intent).
      const result = await this.autoSubscription.processDue(this.workerId, 25);
      if (result.needsReview > 0 || result.retryable > 0) {
        if (result.needsReview > 0) {
          this.logger.warn(
            `Billing worker auto-subscription needs_review count=${result.needsReview} recovered=${result.recovered} workerId=${this.workerId}`,
          );
        }
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `Billing worker auto-subscription failed: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
      return false;
    }
  }

  private async recoverUsdcClaims(): Promise<StageResult> {
    const due = await this.prisma.billingPaymentAttempt.findMany({
      where: {
        method: 'usdc',
        status: { in: ['pending', 'confirming'] },
        submittedTxHash: { not: null },
        nextCheckAt: { lte: new Date() },
      },
      orderBy: { nextCheckAt: 'asc' },
      take: USDC_CLAIM_BATCH,
      include: {
        invoice: { include: { billingAccount: { select: { userId: true } } } },
      },
    });
    let ok = true;
    for (const attempt of due) {
      const userId = attempt.invoice.billingAccount.userId;
      try {
        const result = await this.usdc.claim(userId, attempt.invoiceId, {
          paymentAttemptId: attempt.id,
          txHash: attempt.submittedTxHash ?? attempt.txHash ?? '',
        });
        if (
          result.status === 'needs_review' ||
          result.status === 'failed' ||
          (result.status === 'expired' && !result.retryable)
        ) {
          // Terminal needs_review / failed / non-retryable expiration means the
          // claim recovery did not complete — a scoped failure for the tick.
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.usdc.claim_recovered',
            userId,
            riskLevel: result.status === 'needs_review' ? 'high' : 'medium',
            result: result.status === 'needs_review' ? 'denied' : 'allowed',
            reason: result.reviewReason ?? result.status,
            metadata: {
              paymentAttemptId: attempt.id,
              invoiceId: attempt.invoiceId,
              status: result.status,
              workerId: this.workerId,
            },
          });
        }
      } catch (error) {
        // A thrown recovery failure is a scoped failure for the tick heartbeat
        // (the attempt remains retryable via nextCheckAt for later ticks).
        ok = false;
        this.logger.warn(
          `Billing worker USDC recovery failed for attempt ${attempt.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
    return ok;
  }

  // ── Deferred Stripe renewal retry ──────────────────────────────────────────

  /**
   * Retries deferred (unmatched) Stripe renewal events whose nextRetryAt is
   * due. The event is re-fetched from Stripe by id and re-applied through the
   * existing signature/idempotent webhook pipeline. Stripe calls happen outside
   * any DB transaction.
   *
   * Retries are BOUNDED: provider retrieval failures and processing failures
   * both count against the shared cap (`STRIPE_DEFERRED_MAX_RETRIES`). Once the
   * cap is exceeded the event transitions to `needs_review` for manual
   * intervention with a sanitized audit — never retried forever. Replay /
   * event-id / invoice-id / attempt-id idempotence is preserved by the webhook
   * pipeline (the worker never mutates an event it cannot attribute).
   */
  private async retryDeferredStripeEvents(): Promise<StageResult> {
    if (!this.stripe) return true;
    const due = await this.prisma.stripeWebhookEvent.findMany({
      where: { status: 'deferred', nextRetryAt: { lte: new Date() } },
      orderBy: { nextRetryAt: 'asc' },
      take: STRIPE_DEFERRED_BATCH,
    });
    // A retry that this worker could not complete (and that no concurrent
    // webhook completed either) fails the tick heartbeat.
    let ok = true;
    for (const eventRow of due) {
      const currentRetryCount = eventRow.retryCount ?? 0;
      const leaseNow = new Date();
      const claimed = await this.prisma.stripeWebhookEvent.updateMany({
        where: {
          id: eventRow.id,
          status: 'deferred',
          retryCount: currentRetryCount,
          nextRetryAt: eventRow.nextRetryAt,
          OR: [
            { retryOwnerId: null },
            { retryLeaseExpiresAt: null },
            { retryLeaseExpiresAt: { lt: leaseNow } },
          ],
        },
        data: {
          retryOwnerId: this.workerId,
          retryLeaseExpiresAt: new Date(leaseNow.getTime() + 2 * 60 * 1000),
        },
      });
      if (claimed.count !== 1) continue;
      try {
        const event = await this.stripe.events.retrieve(eventRow.stripeEventId);
        const outcome = await this.webhook.processEvent(event, { ownerId: this.workerId });
        // A normally-returning needs_review (preflight rejected / deferred retry
        // exhausted) or deferred (the pipeline rescheduled a still-unmatched
        // renewal) means THIS worker's deferred retry did not complete — fail
        // the tick. Processed/ignored outcomes are success. A benign concurrent
        // CAS miss is reported by the pipeline as a completed outcome and never
        // fails the tick.
        if (outcome === 'needs_review' || outcome === 'deferred') {
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.stripe.renewal_deferred_needs_review',
            riskLevel: 'high',
            result: 'denied',
            reason: 'deferred_retry_needs_review',
            metadata: {
              stripeEventId: eventRow.stripeEventId,
              type: eventRow.type,
              outcome,
            },
          });
        }
        const cleared = await this.prisma.stripeWebhookEvent.updateMany({
          where: {
            id: eventRow.id,
            status: { in: ['processed', 'ignored', 'needs_review'] },
            retryOwnerId: this.workerId,
            retryLeaseExpiresAt: { gt: new Date() },
          },
          data: { retryOwnerId: null, retryLeaseExpiresAt: null },
        });
        if (cleared.count > 1) throw new Error('Stripe retry lease clear affected multiple events');
      } catch (error) {
        // Provider retrieval and processing failures both count against the
        // bounded retry budget. Exceeding the cap marks the event for manual
        // review instead of retrying forever.
        //
        // Every retry write is a status-guarded CAS on `status = 'deferred'`:
        // a concurrent live webhook that already processed/settled the event
        // (status no longer deferred) can never be overwritten by this stale
        // worker update.
        const retryCount = currentRetryCount + 1;
        if (retryCount > STRIPE_DEFERRED_MAX_RETRIES) {
          const updated = await this.prisma.stripeWebhookEvent.updateMany({
            where: {
              id: eventRow.id,
              status: 'deferred',
              retryCount: currentRetryCount,
              nextRetryAt: eventRow.nextRetryAt,
              retryOwnerId: this.workerId,
            },
            data: {
              status: 'needs_review',
              retryCount,
              nextRetryAt: null,
              errorType: 'deferred_retry_exhausted',
            },
          });
          if (updated.count === 0) {
            // A concurrent webhook processed the event — never demote it. The
            // work completed (by the other processor), so this is not a failure.
            this.logger.warn(
              `Deferred Stripe event ${eventRow.stripeEventId} was already processed concurrently; skipping exhaustion transition`,
            );
            continue;
          }
          // The retry budget is exhausted and the event needs operator action —
          // this worker's retry did not complete.
          ok = false;
          await this.audit({
            actorType: 'system',
            eventType: 'billing.stripe.renewal_deferred_exhausted',
            riskLevel: 'high',
            result: 'denied',
            reason: 'deferred_retry_exhausted',
            metadata: {
              stripeEventId: eventRow.stripeEventId,
              type: eventRow.type,
              retryCount,
            },
          });
        } else {
          const backoff = Math.min(
            STRIPE_DEFERRED_BACKOFF_MS * 2 ** retryCount,
            24 * 60 * 60 * 1000, // hard cap: never schedule further than 24h out
          );
          const updated = await this.prisma.stripeWebhookEvent.updateMany({
            where: {
              id: eventRow.id,
              status: 'deferred',
              retryCount: currentRetryCount,
              nextRetryAt: eventRow.nextRetryAt,
              retryOwnerId: this.workerId,
            },
            data: {
              retryCount,
              nextRetryAt: new Date(Date.now() + backoff),
              retryOwnerId: null,
              retryLeaseExpiresAt: null,
            },
          });
          if (updated.count === 0) {
            // A concurrent webhook processed the event — never reschedule it.
            // The work completed (by the other processor), so this is not a
            // failure.
            this.logger.warn(
              `Deferred Stripe event ${eventRow.stripeEventId} was already processed concurrently; skipping retry bump`,
            );
            continue;
          }
          // This worker's retry failed this tick — scoped failure.
          ok = false;
        }
        this.logger.warn(
          `Billing worker deferred Stripe retry failed for event ${eventRow.stripeEventId}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
    return ok;
  }

  private monthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  // ── Sanitized audit ────────────────────────────────────────────────────────

  /**
   * Writes a sanitized material-transition audit through the existing
   * SecurityEventService. Notification/SIEM failures are isolated inside that
   * service; never include full Stripe payloads, receipts, RPC URLs, calldata,
   * or credentials.
   */
  private async audit(input: Parameters<SecurityEventService['record']>[0]): Promise<void> {
    try {
      await this.securityEvents.record({
        actorType: input.actorType,
        eventType: input.eventType,
        userId: input.userId ?? null,
        riskLevel: input.riskLevel ?? 'low',
        result: input.result ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? undefined,
      });
    } catch (error) {
      // Audit/notification/SIEM isolation: a failing audit must never break
      // the billing transition it describes.
      this.logger.error(
        `Billing audit write failed for ${input.eventType}: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
    }
  }

  // ── Worker heartbeat / readiness telemetry ────────────────────────────────

  /**
   * Upserts the non-sensitive `BillingWorkerHeartbeat` row keyed by this
   * process's `workerId`. The row stores only lifecycle state — no error text,
   * account/user data, secrets, or provider identifiers.
   *
   * Heartbeat writes are telemetry: a write failure is sanitized/logged and
   * NEVER rethrown, so it can never mask the original billing result or abort
   * unrelated work.
   */
  private async writeHeartbeat(
    status: 'starting' | 'running' | 'healthy' | 'failed',
    opts: { started?: boolean; success?: boolean; failure?: boolean } = {},
  ): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.billingWorkerHeartbeat.upsert({
        where: { workerId: this.workerId },
        create: {
          workerId: this.workerId,
          status,
          lastHeartbeatAt: now,
          lastStartedAt: opts.started ? now : null,
          lastSuccessAt: opts.success ? now : null,
          lastFailureAt: opts.failure ? now : null,
          consecutiveFailures: opts.failure ? 1 : 0,
        },
        update: {
          status,
          lastHeartbeatAt: now,
          ...(opts.started ? { lastStartedAt: now } : {}),
          ...(opts.success ? { lastSuccessAt: now, consecutiveFailures: 0 } : {}),
          ...(opts.failure ? { lastFailureAt: now, consecutiveFailures: { increment: 1 } } : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        `Billing worker heartbeat write failed: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
    }
  }
}

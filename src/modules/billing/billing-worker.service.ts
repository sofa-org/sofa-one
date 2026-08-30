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
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import {
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
/** Scheduler interval for the worker pass (5 minutes). */
const WORKER_INTERVAL_MS = 5 * 60 * 1000;

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
  ) {}

  onModuleInit(): void {
    this.enabled = this.config.get<boolean>('billing.worker.enabled') === true;
    if (this.enabled) {
      this.logger.log(
        `Billing worker enabled (workerId=${this.workerId}, interval=${WORKER_INTERVAL_MS}ms)`,
      );
    } else {
      this.logger.log(
        'Billing worker is disabled (set BILLING_WORKER_ENABLED=true to enable)',
      );
    }
  }

  /**
   * One worker pass: reconcile+finalize, USDC claim recovery, Stripe retry.
   *
   * Single-flight guard: a second concurrent tick returns immediately without
   * touching the database — the in-process guard guarantees no same-process
   * overlap. Cross-instance overlap is prevented by the DB-backed active-run
   * acquisition/lease in BillingReconciliationService.
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
      await this.reconcileAndFinalizeAll();
      await this.recoverUsdcClaims();
      await this.retryDeferredStripeEvents();
      if (this.stripePayments) await this.stripePayments.recoverPendingCheckouts(this.workerId);
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
  private async reconcileAndFinalizeAll(): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const accounts = await this.prisma.billingAccount.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take: ACCOUNT_PAGE_SIZE,
        select: { id: true, userId: true },
      });
      if (accounts.length === 0) break;
      for (const account of accounts) {
        try {
          await this.drainAccount(account);
        } catch (error) {
          this.logger.error(
            `Billing worker reconciliation failed for account ${account.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
          );
        }
      }
      cursor = accounts[accounts.length - 1].id;
      if (accounts.length < ACCOUNT_PAGE_SIZE) break;
    }
  }

  private async drainAccount(account: { id: string; userId: string }): Promise<void> {
    const now = new Date();
    const currentPeriodStart = this.monthStart(now);
    const currentPeriodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    // Enumerate this account's eligible target periods: the current UTC period
    // plus every open invoice period. Each period is reconciled with the
    // explicit target scope so candidate scans are account/period bounded and
    // the worker never scans globally.
    const periods = new Map<string, { start: Date; end: Date }>();
    // Add current after loading historical invoices; iteration is explicitly
    // sorted below so older eligible periods drain before the current period.
    const openInvoices = await this.prisma.billingInvoice.findMany({
      where: { billingAccountId: account.id, status: 'open' },
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
    periods.set(currentPeriodStart.toISOString(), { start: currentPeriodStart, end: currentPeriodEnd });

    let lostOwnership = false;
    for (const { start, end } of [...periods.values()].sort((a, b) => a.start.getTime() - b.start.getTime())) {
      for (let page = 0; page < RECONCILE_PAGES_PER_ACCOUNT; page++) {
        const result = await this.reconciliation.reconcile(account.userId, {
          limit: 200,
          workerId: this.workerId,
          targetPeriodStart: start,
          targetPeriodEnd: end,
        });
        // A live concurrent worker owns the active run for this period — never
        // overlap; another instance will finish the drain.
        if (result.skipped) break;
        // This worker lost lease ownership mid-run (taken over by another
        // instance): STOP immediately and never finalize — the takeover owner
        // resumes from the persisted progress markers.
        if (result.ownershipLost) {
          lostOwnership = true;
          break;
        }
        if (result.scanned === 0) break;
        // Unresolved no-hash / notFound / transient / error / conflict work
        // blocks finalization; stop draining this period for this tick
        // (bounded retry).
        if (
          result.notFound > 0 ||
          result.transientError > 0 ||
          result.errors > 0 ||
          result.conflicts > 0 ||
          result.noHash > 0 ||
          result.quarantined > 0 ||
          result.retryable > 0
        ) {
          break;
        }
        if (result.scanned < 200) break;
      }
      if (lostOwnership) break;
    }

    // Ownership was lost: never attempt finalization for this account. The
    // takeover owner owns the runs now and will finalize after its own clean
    // drain.
    if (lostOwnership) {
      this.logger.warn(
        `Billing worker lost reconciliation ownership for account ${account.id}; skipping finalization`,
      );
      return;
    }

    await this.materializeDueRecurringPeriod(account, now);
    await this.finalizeEligiblePeriods(account);
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
  ): Promise<void> {
    const invoices = this.prisma.billingInvoice as typeof this.prisma.billingInvoice & {
      findFirst?: (args: unknown) => Promise<any>;
    };
    if (typeof invoices.findFirst !== 'function') return;
    const latest = await invoices.findFirst({
      where: { billingAccountId: account.id, status: 'finalized' },
      orderBy: { periodStart: 'desc' },
      select: { periodEnd: true },
    });
    if (!latest?.periodEnd || latest.periodEnd > now) return;

    const nextStart = latest.periodEnd as Date;
    const nextEnd = new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth() + 2, 1));
    const existing = await invoices.findFirst({
      where: { billingAccountId: account.id, periodStart: nextStart },
      select: { id: true },
    });
    if (existing) return;

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
    } catch (error) {
      this.logger.warn(
        `Billing worker recurring period ${period} skipped for user ${account.userId}: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
    }
  }

  /**
   * Finalizes every period whose open invoice — owned by THIS account — is
   * past the end + 24h UTC grace window. The candidate query is filtered by
   * `billingAccountId` and a defensive ownership check re-proves the invoice
   * belongs to the account before `finalizeInvoice` is called (which itself
   * re-checks eligibility and unresolved risk inside the period lock). An
   * overdue invoice of another account can never trigger work for this account.
   */
  private async finalizeEligiblePeriods(account: { id: string; userId: string }): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const openInvoices = await this.prisma.billingInvoice.findMany({
      where: { billingAccountId: account.id, status: 'open', periodEnd: { lte: cutoff } },
      select: { id: true, billingAccountId: true, periodStart: true },
      orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    for (const invoice of openInvoices) {
      // Ownership proof: only invoices owned by this account may be finalized.
      if (invoice.billingAccountId !== account.id) continue;
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
        this.logger.warn(
          `Billing worker finalization skipped for user ${account.userId} period ${period}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
  }

  // ── USDC active-claim recovery ─────────────────────────────────────────────

  /**
   * Resumes pending/confirming USDC claims whose persisted submitted hash is
   * due (nextCheckAt <= now). It reuses the existing `UsdcPaymentService.claim`
   * verification path with the canonical persisted hash — it never invents or
   * scans chain events, never fabricates hashes/receipts, and is guarded by the
   * claim's evidence-aware CAS. Bounded batch per tick.
   */
  private async recoverUsdcClaims(): Promise<void> {
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
        // Transient recovery failures are retryable via nextCheckAt; never fail
        // the whole tick.
        this.logger.warn(
          `Billing worker USDC recovery failed for attempt ${attempt.id}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
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
  private async retryDeferredStripeEvents(): Promise<void> {
    if (!this.stripe) return;
    const due = await this.prisma.stripeWebhookEvent.findMany({
      where: { status: 'deferred', nextRetryAt: { lte: new Date() } },
      orderBy: { nextRetryAt: 'asc' },
      take: STRIPE_DEFERRED_BATCH,
    });
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
        await this.webhook.processEvent(event, { ownerId: this.workerId });
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
            // A concurrent webhook processed the event — never demote it.
            this.logger.warn(
              `Deferred Stripe event ${eventRow.stripeEventId} was already processed concurrently; skipping exhaustion transition`,
            );
            continue;
          }
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
            data: { retryCount, nextRetryAt: new Date(Date.now() + backoff), retryOwnerId: null, retryLeaseExpiresAt: null },
          });
          if (updated.count === 0) {
            // A concurrent webhook processed the event — never reschedule it.
            this.logger.warn(
              `Deferred Stripe event ${eventRow.stripeEventId} was already processed concurrently; skipping retry bump`,
            );
            continue;
          }
        }
        this.logger.warn(
          `Billing worker deferred Stripe retry failed for event ${eventRow.stripeEventId}: ${sanitizeErrorMessage(getErrorText(error))}`,
        );
      }
    }
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
  private async audit(
    input: Parameters<SecurityEventService['record']>[0],
  ): Promise<void> {
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
}

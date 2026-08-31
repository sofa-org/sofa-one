import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import {
  OpenfortService,
  type SanitizedReceipt,
  type SanitizedReceiptLog,
} from '../../core/openfort/openfort.service';
import { BillingService, type ReceiptUsageEvidence } from './billing.service';
import { evaluatePricing } from './billing-pricing';
import { SUPPORTED_CHAINS } from '../../common/chains/supported-chains';
import { sanitizeErrorMessage } from '../../common/utils/sanitize';

/** ERC-20 `Transfer(address,address,uint256)` topic0. */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';/** A uint256 amount is exactly 32 bytes (64 hex chars) after the 0x prefix. */
const AMOUNT_DATA_REGEX = /^0x[0-9a-fA-F]{64}$/;
/** An indexed address topic is exactly 32 bytes (64 hex chars) after 0x. */
const INDEXED_ADDRESS_REGEX = /^0x[0-9a-fA-F]{64}$/;
/** A token contract address is exactly 20 bytes (40 hex chars) after 0x. */
const TOKEN_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/** How long a reconciliation run's worker lease is valid before it is stale. */
export const RECONCILE_LEASE_MS = 5 * 60 * 1000;

/** Lease renewal grace: a run is renewed while at least this much lease remains. */
export const RECONCILE_LEASE_RENEW_GRACE_MS = 60 * 1000;

/** Run type used for every receipt reconciliation run. */
export const RECONCILE_RUN_TYPE = 'receipt_outbound';

type TransactionRow = {
  id: string;
  userId: string;
  chainId: bigint;
  txHash: string | null;
  userOpHash?: string | null;
  userOpSuccess?: boolean | null;
  billingPeriodStart?: Date | null;
  walletAddress: string;
  operationType: string | null;
  status: string;
  details: Prisma.JsonValue | null;
  /** Optional for defensive highWaterMark derivation (mocks may omit it). */
  createdAt?: Date;
};

export interface ReconcileOptions {
  limit?: number;
  /**
   * Lease owner id for this run. When omitted, a fresh owner id is generated
   * (`reconcile-<uuid>`) so EVERY invocation — including dashboard calls — owns
   * its run with a real, owner-checked lease. Never null.
   */
  workerId?: string;
  /**
   * Explicit target accounting period for the scan (UTC month start). The
   * worker always passes the period of each eligible open invoice it drains;
   * dashboard callers may default to the current UTC period. Candidate scans
   * are bounded by `createdAt < targetPeriodEnd`.
   */
  targetPeriodStart?: Date;
  targetPeriodEnd?: Date;
}

export interface ReconcileResult {
  runId: string;
  scanned: number;
  notFound: number;
  transientError: number;
  reverted: number;
  posted: number;
  quarantined: number;
  updated: number;
  errors: number;
  conflicts: number;
  replayed: number;
  casNoops: number;
  /** Rows still in a non-final state with no txHash yet (retryable work). */
  noHash: number;
  /** Recoverable provider/ownership work that prevents closure. */
  retryable: number;
  /** True when a concurrent worker owned the active run, so this call skipped. */
  skipped: boolean;
  /** True when this worker lost lease ownership mid-run (taken over). */
  ownershipLost: boolean;
}

type Summary = {
  scanned: number;
  notFound: number;
  transientError: number;
  reverted: number;
  posted: number;
  quarantined: number;
  updated: number;
  errors: number;
  conflicts: number;
  replayed: number;
  casNoops: number;
  noHash: number;
  retryable: number;
  ownershipLost: boolean;
};

type AcquiredRun = {
  id: string;
  workerId: string;
  billingAccountId: string;
};

/**
 * Receipt-confirmed outbound reconciliation (Commercial Billing Phase 1D).
 *
 * Scans persisted Transaction rows for one account and one explicit target
 * accounting period, fetches sanitized receipts via OpenfortService, and
 * appends evidence-backed `posted`/`quarantined` ledger events through
 * BillingService.recordSuccessfulOutbound. Metering is idempotent on the
 * deterministic sourceKey / receipt-component unique index, so re-scanning
 * confirmed rows is safe and concurrent workers cannot double-count.
 *
 * Cross-instance correctness (Oracle Gate 1 remediation):
 * - Runs are acquired account + target-period scoped inside the shared
 *   billing-period advisory lock. A partial unique index on
 *   (billing_account_id, period_start, run_type) WHERE status = 'running'
 *   guarantees at most one active run per account/period/runType.
 * - A concurrent worker that finds a live running run (valid lease) skips
 *   without overlapping. A stale running run (expired lease) is taken over via
 *   an owner-checked compare-and-set; the takeover owner renews the lease with
 *   heartbeats and the previous owner's completion/failure updates can no
 *   longer match (owner-checked), so an old owner can never complete a run it
 *   no longer owns.
 * - No interactive DB transaction spans Openfort RPC calls: the acquisition
 *   transaction commits before any RPC, heartbeats are single updates, and
 *   completion/failure are single owner-checked updates.
 *
 * This is a protected internal trigger seam (dashboard-only + worker), not a
 * public API-key route, and never schedules itself.
 */
@Injectable()
export class BillingReconciliationService {
  private readonly logger = new Logger(BillingReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly billing: BillingService,
  ) {}

  async reconcile(userId: string, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // Every invocation gets a real owner id (dashboard + worker alike) so every
    // run is lease/owner-checked end to end.
    const workerId = opts.workerId ?? `reconcile-${randomUUID()}`;
    const now = new Date();
    const targetPeriodStart = opts.targetPeriodStart ?? this.monthStart(now);
    const targetPeriodEnd =
      opts.targetPeriodEnd ??
      new Date(
        Date.UTC(
          targetPeriodStart.getUTCFullYear(),
          targetPeriodStart.getUTCMonth() + 1,
          1,
        ),
      );

    const summary: Summary = {
      scanned: 0,
      notFound: 0,
      transientError: 0,
      reverted: 0,
      posted: 0,
      quarantined: 0,
      updated: 0,
      errors: 0,
      conflicts: 0,
      replayed: 0,
      casNoops: 0,
      noHash: 0,
      retryable: 0,
      ownershipLost: false,
    };

    // Account + target-period run acquisition (DB-backed, takeover-aware). The
    // shared advisory lock serializes acquisition against finalization; a live
    // competing run makes this call skip without overlapping.
    const acquired = await this.acquireRun(
      userId,
      targetPeriodStart,
      targetPeriodEnd,
      workerId,
    );
    if (acquired.kind === 'skip') {
      return {
        runId: acquired.runId ?? '',
        ...zeroCounters(),
        skipped: true,
        ownershipLost: false,
      };
    }
    const run = acquired.run;

    try {
      const candidates = await this.selectCandidates(userId, targetPeriodStart, targetPeriodEnd, limit);

      summary.scanned = candidates.length;

      // A candidate with missing/invalid createdAt cannot prove the high-water
      // contract; surface it as a safe error so the run is never treated as
      // clean exhaustive.
      const invalidCreatedAtCount = candidates.filter((c) => !isValidCreatedAt(c.createdAt))
        .length;
      if (invalidCreatedAtCount > 0) {
        summary.errors += invalidCreatedAtCount;
        this.logger.warn(
          `Reconciliation found ${invalidCreatedAtCount} candidate(s) with missing/invalid createdAt for user ${userId}`,
        );
      }

      // Deterministic scan-boundary evidence: the true max (createdAt, id)
      // across ALL selected candidates — never the last row in priority order.
      // Never BigInt, logs, calldata, or secrets.
      const highWaterMark = this.buildHighWaterMark(candidates);
      const accountingPeriods = this.buildAccountingPeriods(candidates);

      for (const tx of candidates) {
        // Owner-checked heartbeat renewal before each candidate, refreshed with
        // a fresh timestamp every heartbeat. Losing the lease (a concurrent
        // takeover) stops this worker immediately; the takeover owner resumes
        // from the persisted progress markers.
        const owned = await this.renewLease(run);
        if (!owned) {
          summary.ownershipLost = true;
          break;
        }
        try {
          await this.processTransaction(
            userId, tx, summary, run.id, run.workerId, run.billingAccountId,
            targetPeriodStart, targetPeriodEnd,
          );
          if (summary.ownershipLost) break;
        } catch (error) {
          if (error instanceof ConflictException) {
            summary.conflicts++;
          } else {
            summary.errors++;
            summary.retryable++;
          }
          this.logger.error(
            `Reconciliation failed for transaction ${tx.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      // Final DB exhaustion check for the exact account/period: the run is
      // clean only when NO unresolved candidate remains after this scan. This
      // is the durable closure proof (the JSON high-water mark alone is
      // coverage metadata, never a closure proof).
      const remaining = await this.countUnresolvedCandidates(userId, targetPeriodStart, targetPeriodEnd);
      const exhausted = remaining === 0;

      const complete = this.isCompleteRun(summary, invalidCreatedAtCount, exhausted);
      const persistedSummary = this.buildPersistedSummary(
        summary,
        userId,
        complete,
        highWaterMark,
        accountingPeriods,
        remaining,
        run.id,
        run.billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
        RECONCILE_RUN_TYPE,
      );

      // Owner-checked completion: only the current lease owner may complete
      // the run. A taken-over run (different workerId) never matches, so an
      // old owner can never overwrite the takeover owner's state.
      //
      // The completion CAS count is captured and propagated: if ownership was
      // lost AFTER the last heartbeat (e.g. a takeover landed between the
      // heartbeat and this write), the CAS matches zero rows and ownershipLost
      // is set so callers (the worker) never finalize a period they no longer
      // own.
      const completionNow = new Date();
      const completed = await this.prisma.billingReconciliationRun.updateMany({
        where: {
          id: run.id,
          status: 'running',
          workerId: run.workerId,
          leaseExpiresAt: { gt: completionNow },
        },
        data: {
          status: 'completed',
          completedAt: completionNow,
          summary: persistedSummary as any,
        },
      });
      if (completed.count === 0) {
        summary.ownershipLost = true;
      }
    } catch (error) {
      // A failed run is never complete; userId/complete are still persisted.
      // Owner-checked so a takeover owner's state is never clobbered.
      const persistedSummary = this.buildPersistedSummary(
        summary, userId, false, null, [], null, run.id, run.billingAccountId,
        targetPeriodStart, targetPeriodEnd, RECONCILE_RUN_TYPE,
      );
      const failureNow = new Date();
      const failed = await this.prisma.billingReconciliationRun.updateMany({
        where: {
          id: run.id,
          status: 'running',
          workerId: run.workerId,
          leaseExpiresAt: { gt: failureNow },
        },
        data: {
          status: 'failed',
          completedAt: failureNow,
          errorDetails: sanitizeErrorMessage(
            error instanceof Error ? error.message : String(error),
          ),
          summary: persistedSummary as any,
        },
      });
      if (failed.count === 0) {
        // Ownership was lost before the failure — the takeover owner owns the
        // run now. Do not throw a misleading error; return the partial summary.
        this.logger.warn(
          `Reconciliation run ${run.id} was taken over before it could be marked failed`,
        );
        return { runId: run.id, ...summary, skipped: false, ownershipLost: true };
      }
      throw error;
    }

    return { runId: run.id, ...summary, skipped: false, ownershipLost: summary.ownershipLost };
  }

  /**
   * Acquires the account + target-period run inside the shared billing-period
   * advisory lock. A live running run (valid lease) makes this caller skip; a
   * stale running run is taken over with an owner-checked compare-and-set; a
   * free slot is created. A concurrent create is absorbed by the partial
   * unique active-run index (P2002 → skip).
   */
  private async acquireRun(
    userId: string,
    targetPeriodStart: Date,
    targetPeriodEnd: Date,
    workerId: string,
  ): Promise<{ kind: 'acquired'; run: AcquiredRun } | { kind: 'skip'; runId: string | null }> {
    return this.billing.withBillingPeriodLock(
      userId,
      targetPeriodStart,
      async (tx, billingAccountId) => {
        const existing = await tx.billingReconciliationRun.findFirst({
          where: {
            billingAccountId,
            periodStart: targetPeriodStart,
            runType: RECONCILE_RUN_TYPE,
            status: 'running',
          },
          select: {
            id: true,
            workerId: true,
            leaseExpiresAt: true,
            billingAccountId: true,
          },
        });

        if (existing) {
          const leaseValid =
            existing.leaseExpiresAt !== null && existing.leaseExpiresAt.getTime() > Date.now();
          if (leaseValid) {
            // A live concurrent worker owns this run — skip, never overlap.
            return { kind: 'skip', runId: existing.id } as const;
          }
          // Stale running run (expired lease OR a legacy row with a NULL lease):
          // takeover with an owner-checked compare-and-set that only matches
          // while the run is still running with the same stale/null lease.
          const taken = await tx.billingReconciliationRun.updateMany({
            where: {
              id: existing.id,
              status: 'running',
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
            },
            data: {
              workerId,
              leaseExpiresAt: new Date(Date.now() + RECONCILE_LEASE_MS),
              heartbeatAt: new Date(),
            },
          });
          if (taken.count === 0) {
            // A concurrent worker won the takeover — skip.
            return { kind: 'skip', runId: existing.id } as const;
          }
          return {
            kind: 'acquired',
            run: {
              id: existing.id,
              workerId,
              billingAccountId: existing.billingAccountId ?? billingAccountId,
            },
          } as const;
        }

        try {
          const run = await tx.billingReconciliationRun.create({
            data: {
              status: 'running',
              runType: RECONCILE_RUN_TYPE,
              periodStart: targetPeriodStart,
              periodEnd: targetPeriodEnd,
              source: 'openfort_receipt',
              billingAccountId,
              accountUserId: userId,
              workerId,
              leaseExpiresAt: new Date(Date.now() + RECONCILE_LEASE_MS),
              heartbeatAt: new Date(),
            },
            select: { id: true, workerId: true, billingAccountId: true },
          });
          return {
            kind: 'acquired',
            run: { id: run.id, workerId, billingAccountId: run.billingAccountId ?? billingAccountId },
          } as const;
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            // A concurrent worker created the active run first — skip.
            const winner = await tx.billingReconciliationRun.findFirst({
              where: {
                billingAccountId,
                periodStart: targetPeriodStart,
                runType: RECONCILE_RUN_TYPE,
                status: 'running',
              },
              select: { id: true },
            });
            return { kind: 'skip', runId: winner?.id ?? null } as const;
          }
          throw err;
        }
      },
    );
  }

  /**
   * Owner-checked lease heartbeat. Only the recorded owner may renew; a
   * takeover changes `workerId`, so the old owner's renewal matches zero rows
   * and the caller stops doing work. The heartbeat timestamp is refreshed with
   * a FRESH `new Date()` on every call (never a stale captured time). Returns
   * false when ownership was lost.
   */
  private async renewLease(run: AcquiredRun): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.billingReconciliationRun.updateMany({
      where: {
        id: run.id,
        status: 'running',
        workerId: run.workerId,
        leaseExpiresAt: { gt: now },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + RECONCILE_LEASE_MS),
      },
    });
    return result.count > 0;
  }

  /**
   * JSON-safe persisted summary: all existing counters plus the completion
   * marker (`userId`, `complete`, `highWaterMark`), the `accountingPeriods`
   * this scan's candidates may affect, and the `remainingUnresolved` count of
   * the final DB exhaustion check. `highWaterMark` is always present — null
   * for an empty candidate set or when no valid candidate exists. Never
   * serializes BigInt, receipt logs, calldata, API keys, or provider objects.
   */
  private buildPersistedSummary(
    summary: Summary,
    userId: string,
    complete: boolean,
    highWaterMark: { createdAt: string; id: string } | null,
    accountingPeriods: string[],
    remainingUnresolved: number | null,
    runId?: string,
    billingAccountId?: string,
    periodStart?: Date,
    periodEnd?: Date,
    runType?: string,
  ): Record<string, unknown> {
    return {
      ...summary,
      userId,
      complete,
      highWaterMark,
      accountingPeriods,
      remainingUnresolved,
      runId,
      billingAccountId,
      periodStart: periodStart?.toISOString(),
      periodEnd: periodEnd?.toISOString(),
      runType,
    };
  }

  /**
   * UTC month-start strings for the accounting periods this scan's candidates
   * MAY affect, derived from candidate createdAt. This is scan-coverage
   * metadata only — it is NOT proof of the receipt block timestamp's accounting
   * month (a cross-month pending transaction may be mined in a later month).
   * The billing consumer treats missing/malformed coverage as conservatively
   * risky and never uses createdAt-derived coverage to clear unresolved risk.
   * Sorted and deduplicated; empty for an empty set.
   */
  private buildAccountingPeriods(candidates: TransactionRow[]): string[] {
    const periods = new Set<string>();
    for (const candidate of candidates) {
      if (!isValidCreatedAt(candidate.createdAt)) continue;
      periods.add(this.monthStart(candidate.createdAt).toISOString());
    }
    return [...periods].sort();
  }

  /**
   * A run is complete only when the final DB exhaustion check found zero
   * unresolved candidates for the exact account/period, every selected
   * candidate has a valid createdAt (the high-water contract is provable), and
   * there are no retryable/error/conflict/no-hash counters.
   */
  private isCompleteRun(
    summary: Summary,
    invalidCreatedAtCount: number,
    exhausted: boolean,
  ): boolean {
    const counters = [
      summary.scanned, summary.notFound, summary.transientError, summary.reverted,
      summary.posted, summary.quarantined, summary.updated, summary.errors,
      summary.conflicts, summary.replayed, summary.casNoops, summary.noHash,
      summary.retryable,
    ];
    return (
      exhausted &&
      invalidCreatedAtCount === 0 &&
      counters.every((value) => Number.isSafeInteger(value) && value >= 0) &&
      summary.notFound === 0 &&
      summary.transientError === 0 &&
      summary.errors === 0 &&
      summary.conflicts === 0 &&
      summary.noHash === 0 &&
      summary.retryable === 0 &&
      summary.quarantined === 0
    );
  }

  /**
   * True max `(createdAt, id)` across ALL selected candidates — never the last
   * row in pending-first/confirmed-fill priority order. createdAt is compared
   * by UTC time (ISO strings sort chronologically), ties broken by the
   * lexicographically largest id. Candidates with missing/invalid createdAt are
   * skipped here (they are surfaced separately as a completeness error).
   */
  private buildHighWaterMark(
    candidates: TransactionRow[],
  ): { createdAt: string; id: string } | null {
    let best: { createdAt: string; id: string } | null = null;
    for (const candidate of candidates) {
      if (!isValidCreatedAt(candidate.createdAt)) continue;
      const key = { createdAt: candidate.createdAt.toISOString(), id: candidate.id };
      if (!best || compareHighWaterMark(key, best) > 0) best = key;
    }
    return best;
  }

  /**
   * Fair two-stage candidate selection scoped to the account and the target
   * close cutoff (`createdAt < targetPeriodEnd`). Non-confirmed candidates
   * (including rows with no txHash yet, which are unresolved work) get a
   * guaranteed slice; confirmed backlog gets a guaranteed slice too, so a
   * >200-row unresolved backlog can never starve confirmed work. A row with
   * `status = 'confirmed'` but a NULL `txHash` is data-integrity anomalous and
   * is treated as unresolved: it is scanned with the confirmed slice, counted
   * as noHash (never RPC'd — there is no hash), and blocks closure. The
   * persisted `billingReconciledAt` marker is the durable progress cursor for
   * confirmed rows; the final DB exhaustion check is the closure proof.
   */
  private async selectCandidates(
    userId: string,
    targetPeriodStart: Date,
    targetPeriodEndOrLimit: Date | number,
    limit?: number,
  ): Promise<TransactionRow[]> {
    // Keep the private seam tolerant for older unit callers; production always
    // supplies the explicit target period end.
    const targetPeriodEnd = targetPeriodEndOrLimit instanceof Date
      ? targetPeriodEndOrLimit
      : new Date(Date.UTC(targetPeriodStart.getUTCFullYear(), targetPeriodStart.getUTCMonth() + 1, 1));
    const pageLimit = typeof targetPeriodEndOrLimit === 'number' ? targetPeriodEndOrLimit : limit ?? 50;
    if (pageLimit <= 0) return [];

    // A one-row page still probes both queues.  Choosing the confirmed row
    // when both are present prevents an unresolved pending/unknown head from
    // permanently hiding confirmed backlog; when no confirmed row exists the
    // pending probe supplies the one available slot.  Larger pages reserve a
    // slot for each queue and then distribute the remainder to confirmed work.
    const confirmedSlice = Math.max(1, Math.floor(pageLimit / 2));
    const nonConfirmedSlice = pageLimit - confirmedSlice;

    const nonConfirmed = await this.prisma.transaction.findMany({
      where: {
        userId,
        operationType: { in: ['send', 'withdraw'] },
        status: { in: ['submitting', 'pending', 'unknown'] },
        billingPeriodStart: targetPeriodStart,
        createdAt: { lt: targetPeriodEnd },
      },
      orderBy: [{ billingLastAttemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, nonConfirmedSlice),
    });

    // Slots left over from a sparse non-confirmed set roll into the confirmed
    // slice so a small pending set never wastes the bounded scan budget.
    const confirmedTake = confirmedSlice + Math.max(0, nonConfirmedSlice - nonConfirmed.length);

    // A confirmed row is unresolved when it has NO txHash (data-integrity
    // anomalous) OR it lacks the durable `billingReconciledAt` marker. The
    // `txHash IS NULL` branch deliberately ignores the marker: a confirmed row
    // with a NULL hash can never be reconciled and must keep the run/period
    // from closing even if a marker was (incorrectly) set.
    const confirmed = await this.prisma.transaction.findMany({
      where: {
        userId,
        operationType: { in: ['send', 'withdraw'] },
        status: 'confirmed',
        AND: [
          { OR: [{ txHash: null }, { billingReconciledAt: null }] },
          { billingPeriodStart: targetPeriodStart },
          { createdAt: { lt: targetPeriodEnd } },
        ],
        id: { notIn: nonConfirmed.map((tx) => tx.id) },
      },
      orderBy: [{ billingLastAttemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: confirmedTake,
    });

    if (pageLimit === 1) {
      if (confirmed.length === 0) return nonConfirmed.slice(0, 1);
      if (nonConfirmed.length === 0) return [confirmed[0]];
      const pending = nonConfirmed[0] as TransactionRow & { billingLastAttemptedAt?: Date | null };
      const done = confirmed[0] as TransactionRow & { billingLastAttemptedAt?: Date | null };
      const pendingAt = pending.billingLastAttemptedAt?.getTime() ?? null;
      const confirmedAt = done.billingLastAttemptedAt?.getTime() ?? null;
      // Null timestamps are the initial fair turn. Keep confirmed first on
      // the initial tie; the touch-before-RPC CAS then makes the other lane's
      // null timestamp win on the next tick.
      if (pendingAt === null && confirmedAt === null) return [done];
      if (pendingAt === null) return [pending];
      if (confirmedAt === null) return [done];
      return [pendingAt <= confirmedAt ? pending : done];
    }
    return [...nonConfirmed, ...confirmed].slice(0, pageLimit);
  }

  /**
   * Final DB exhaustion check: counts every unresolved candidate for the exact
   * account (via the 1:1 user) and target close cutoff that a clean run must
   * have consumed. Rows still pending (notFound/transient/no-hash), and
   * confirmed rows that are unresolved — no `billingReconciledAt` marker, OR
   * a NULL `txHash` REGARDLESS of marker (a confirmed row without a hash can
   * never be reconciled) — keep the count above zero, so a run is only clean
   * when the scan was exhaustive.
   */
  private async countUnresolvedCandidates(userId: string, targetPeriodStart: Date, targetPeriodEnd: Date): Promise<number> {
    const [nonConfirmed, confirmed] = await Promise.all([
      this.prisma.transaction.count({
        where: {
          userId,
          operationType: { in: ['send', 'withdraw'] },
          status: { in: ['submitting', 'pending', 'unknown'] },
          billingPeriodStart: targetPeriodStart,
          createdAt: { lt: targetPeriodEnd },
        },
      }),
      this.prisma.transaction.count({
        where: {
          userId,
          operationType: { in: ['send', 'withdraw'] },
          status: 'confirmed',
          AND: [
            { OR: [{ txHash: null }, { billingReconciledAt: null }] },
            { billingPeriodStart: targetPeriodStart },
            { createdAt: { lt: targetPeriodEnd } },
          ],
        },
      }),
    ]);
    return nonConfirmed + confirmed;
  }

  private async processTransaction(
    userId: string,
    tx: TransactionRow,
    summary: Summary,
    runId: string,
    workerId: string,
    billingAccountId: string,
    targetPeriodStart: Date,
    targetPeriodEnd: Date,
  ): Promise<void> {
    // Legacy rows without typed membership are ambiguous. They are selected so
    // the run remains visibly blocked, but never assigned to whichever period
    // happens to scan them first.
    if (tx.billingPeriodStart === null) {
      summary.conflicts++;
      return;
    }
    const chainId = Number(tx.chainId);

    const touched = await this.fencedStateUpdate(
      tx,
      { billingLastAttemptedAt: new Date() },
      runId,
      workerId,
      billingAccountId,
      targetPeriodStart,
      targetPeriodEnd,
    );
    if (touched !== 1) {
      summary.conflicts++;
      return;
    }

    const txDetails = tx.details && typeof tx.details === 'object' && !Array.isArray(tx.details)
      ? tx.details as Record<string, unknown> : {};
    const storedUserOpHash = tx.userOpHash ?? (typeof txDetails.userOpHash === 'string' ? txDetails.userOpHash : null);
    const isUserOperation = Boolean(
      storedUserOpHash ||
      txDetails.executionMode === 'session_key' ||
      txDetails.execution === 'calibur_agent_user_operation',
    );

    if (isUserOperation && tx.userOpSuccess === false) {
      const terminal = await this.fencedStateUpdate(
        tx,
        { status: 'failed', billingReconciledAt: new Date() },
        runId, workerId, billingAccountId, targetPeriodStart, targetPeriodEnd,
      );
      if (terminal !== 1) summary.conflicts++;
      else summary.reverted++;
      return;
    }

    // A UserOperation can be included in a successful bundle transaction while
    // its own execution reverted. The inner result is persisted separately by
    // TransactionsService; never treat the enclosing receipt as billable.
    if (isUserOperation && txDetails.userOperationSuccess === false) {
      summary.conflicts++;
      return;
    }

    // A stored UserOperation hash remains recoverable even when an enclosing
    // bundle transaction hash is already present. The inner result is the only
    // authority for membership; never meter the outer bundle while unresolved.
    if (isUserOperation && tx.userOpSuccess !== true) {
      if (!storedUserOpHash) {
        summary.transientError++;
        return;
      }
      try {
        const recovered = await this.openfort.waitForUserOperationReceipt({
          chainId,
          userOpHash: storedUserOpHash,
        });
        if (recovered.success === false) {
          const terminal = await this.fencedStateUpdate(
            tx,
            { userOpSuccess: false, status: 'failed', billingReconciledAt: new Date() },
            runId, workerId, billingAccountId, targetPeriodStart, targetPeriodEnd,
          );
          if (terminal === 1) summary.reverted++;
          else summary.conflicts++;
          return;
        }
        if (recovered.success === true && recovered.transactionHash) {
          const recoveredUpdate = await this.fencedStateUpdate(
            tx,
            { userOpSuccess: true, txHash: recovered.transactionHash, status: 'pending' },
            runId, workerId, billingAccountId, targetPeriodStart, targetPeriodEnd,
          );
          if (recoveredUpdate !== 1) {
            summary.conflicts++;
            return;
          }
          tx.txHash = recovered.transactionHash;
          tx.userOpSuccess = true;
        }
      } catch {
        summary.transientError++;
        return;
      }
      if (tx.userOpSuccess !== true) {
        summary.transientError++;
        return;
      }
    }

    // A row still in a non-final state with no txHash is unresolved work: it
    // is scanned but never queried on the RPC (no hash to query). It blocks
    // closure via the noHash counter so a clean run is never claimed over
    // unresolved work.
    if (!tx.txHash) {
      summary.noHash++;
      return;
    }
    const txHash = tx.txHash;

    // A persisted chain no longer in the supported config can never be priced.
    if (!SUPPORTED_CHAINS[chainId]) {
      const outcome = await this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:unsupported_chain`,
          receiptRef: `${txHash}:unsupported_chain`,
          receiptLogIndex: null,
          periodStart: targetPeriodStart,
          // No receipt exists for an unsupported chain, so the occurrence time
          // is never fabricated from `now`. Use the real persisted transaction
          // creation time as the conservative occurrence evidence; the explicit
          // unknown block sentinels below are NOT receipt/block facts.
          occurredAt: tx.createdAt ?? new Date(),
          assetId: null,
          receipt: {
            txHash,
            receiptRef: `${txHash}:unsupported_chain`,
            receiptLogIndex: null,
            // Explicit "no receipt available" sentinels — never real block
            // facts (the chain cannot be queried, so no block evidence exists).
            // They satisfy the schema's evidence-shape requirement for the
            // quarantine row and are never used as an actual block timestamp.
            receiptBlockNumber: 0n,
            receiptBlockHash: '',
            receiptBlockTimestamp: 0n,
            receiptStatus: 'unknown',
            receiptData: { txHash, chainId: tx.chainId.toString(), evidence: 'none_unsupported_chain' },
            reconciledAt: new Date(),
          },
          metadata: { reason: 'unsupported_chain' },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
      if (outcome === 'replayed') summary.replayed++;
      else summary.quarantined++;
      return;
    }

    const result = await this.openfort.getTransactionReceipt(chainId, txHash);

    if (result.status === 'not_found') {
      summary.notFound++;
      return; // keep pending, retryable
    }
    if (result.status === 'error') {
      summary.transientError++;
      return; // keep pending, retryable
    }

    const receipt = result.receipt;

    // txHash must match the receipt's transactionHash (case-insensitive).
    if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
      // Receipt evidence mismatch: never meter, never confirm. Surface as a
      // conflict with safe diagnostic info (no calldata/secrets).
      summary.conflicts++;
      this.logger.warn(
        `Receipt txHash mismatch for transaction ${tx.id}: expected ${txHash}, got ${receipt.transactionHash}`,
      );
      return;
    }

    // A reverted receipt is never metered.
    if (result.status === 'reverted') {
      const count = await this.markReverted(
        tx, receipt, runId, workerId, billingAccountId, targetPeriodStart, targetPeriodEnd,
      );
      if (count > 0) summary.reverted++;
      else summary.casNoops++;
      return;
    }

    // success
    const blockDate = this.blockDate(receipt);
    const periodStart = this.monthStart(blockDate);

    const details = (tx.details ?? {}) as Record<string, unknown>;
    const isBackendEoa = details.execution === 'backend_eoa' || details.executionMode === 'eoa';

    // EOA sends must originate from the transaction's wallet address. A sender
    // mismatch is quarantined (zero volume) and never marks the tx confirmed.
    if (isBackendEoa && receipt.from.toLowerCase() !== tx.walletAddress.toLowerCase()) {
      const outcome = await this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:eoa_sender_mismatch`,
          receiptRef: `${receipt.transactionHash}:eoa_sender_mismatch`,
          receiptLogIndex: null,
          periodStart,
          occurredAt: blockDate,
          assetId: null,
          receipt: this.buildReceiptEvidence(
            receipt,
            null,
            `${receipt.transactionHash}:eoa_sender_mismatch`,
          ),
          metadata: {
            reason: 'eoa_sender_mismatch',
            expectedSender: tx.walletAddress,
            actualSender: receipt.from,
          },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
      if (outcome === 'replayed') summary.replayed++;
      else summary.quarantined++;
      return; // never meter, never mark confirmed
    }

    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    const walletAddresses = new Set<string>();
    if (wallet?.walletAddress) walletAddresses.add(wallet.walletAddress.toLowerCase());
    walletAddresses.add(tx.walletAddress.toLowerCase());

    const isNativeWithdrawal =
      tx.operationType === 'withdraw' &&
      (details.token === 'NATIVE' || details.contractAddress === null);

    if (isNativeWithdrawal) {
      const outcome = await this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:native`,
          receiptRef: `${receipt.transactionHash}:native`,
          receiptLogIndex: null,
          periodStart,
          occurredAt: blockDate,
          assetId: null,
          receipt: this.buildReceiptEvidence(receipt, null, `${receipt.transactionHash}:native`),
          metadata: {
            reason: 'native_asset',
            amount:
              typeof details.amount === 'string' ? details.amount : String(details.amount ?? ''),
          },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
      if (outcome === 'replayed') summary.replayed++;
      else summary.quarantined++;
      // The receipt is unsafe for usage metering: STOP processing this
      // receipt/log set entirely. Subsequent wallet-originated ERC-20 Transfer
      // logs from the same native-withdrawal receipt must never be metered
      // (and the transaction is never marked confirmed from this unsafe
      // receipt). The quarantined event blocks closure until manual review.
      return;
    }

    // Process each wallet-originated ERC-20 Transfer log independently. The
    // runtime shape of receipt.logs is never trusted: a non-array is a safe
    // error outcome and never reaches a for...of.
    if (!Array.isArray(receipt.logs)) {
      summary.errors++;
      this.logger.warn(`Receipt logs is not an array for transaction ${tx.id}`);
      return; // malformed receipt: never confirm
    }

    const outcome = await this.processReceiptLogs(
      userId,
      tx,
      receipt,
      walletAddresses,
       periodStart,
      blockDate,
      runId,
      workerId,
      billingAccountId,
      targetPeriodStart,
      targetPeriodEnd,
    );
    if (outcome === 'posted') summary.posted++;
    else if (outcome === 'quarantined') summary.quarantined++;
    else if (outcome === 'replayed') summary.replayed++;
    if (outcome === 'posted' || outcome === 'replayed') summary.updated++;

  }

  /**
   * Validates the complete receipt before writing accounting evidence. A
   * receipt is one reconciliation unit: multiple Transfer logs are aggregated
   * into one append and the transaction is confirmed once, after the append.
   * Mixed assets/prices cannot be represented by one canonical usage row and
   * are therefore quarantined rather than approximated.
   */
  private async processReceiptLogs(
    userId: string,
    tx: TransactionRow,
    receipt: SanitizedReceipt,
    walletAddresses: Set<string>,
    periodStart: Date,
    blockDate: Date,
    runId: string,
    workerId: string,
    billingAccountId: string,
    targetPeriodStart: Date,
    targetPeriodEnd: Date,
  ): Promise<'posted' | 'quarantined' | 'replayed' | 'skipped'> {
    // Preserve the canonical per-log evidence identity for the single-log
    // receipt case. Multi-log receipts use the aggregate path below so they
    // cannot perform multiple usage appends or transaction transitions.
    if (receipt.logs.length === 1) {
      const outcome = await this.processLog(
        userId,
        tx,
        receipt,
        receipt.logs[0],
        walletAddresses,
         periodStart,
        blockDate,
        runId,
        0,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
      if (outcome === 'skipped') {
        await this.markConfirmed(
          tx,
          receipt,
          runId,
          workerId,
          billingAccountId,
          targetPeriodStart,
          targetPeriodEnd,
        );
      }
      return outcome;
    }
    const transfers: Array<{ address: string; amount: bigint; log: SanitizedReceiptLog }> = [];
    for (let i = 0; i < receipt.logs.length; i++) {
      const parsed = parseReceiptLog(receipt.logs[i], i);
      if (parsed.kind === 'not_transfer') continue;
      if (parsed.kind === 'invalid') {
        return this.quarantine(
          userId,
          tx,
          {
            sourceKey: `tx:${tx.id}:receipt`,
            receiptRef: `${receipt.transactionHash}:receipt`,
            receiptLogIndex: null,
            periodStart,
            occurredAt: blockDate,
            assetId: null,
            receipt: this.buildReceiptEvidence(receipt, null, `${receipt.transactionHash}:receipt`),
            metadata: { reason: parsed.reason, logIndex: parsed.arrayIndex },
          },
          runId,
          workerId,
          billingAccountId,
          targetPeriodStart,
          targetPeriodEnd,
        );
      }
      if (parsed.removed) {
        return this.quarantine(
          userId,
          tx,
          {
            sourceKey: `tx:${tx.id}:receipt`,
            receiptRef: `${receipt.transactionHash}:receipt`,
            receiptLogIndex: null,
            periodStart,
            occurredAt: blockDate,
            assetId: parsed.address,
            receipt: this.buildReceiptEvidence(receipt, null, `${receipt.transactionHash}:receipt`),
            metadata: { reason: 'removed_log', logIndex: parsed.logIndex },
          },
          runId,
          workerId,
          billingAccountId,
          targetPeriodStart,
          targetPeriodEnd,
        );
      }
      if (parsed.kind === 'transfer' && walletAddresses.has(parsed.from)) {
        transfers.push({
          address: parsed.address,
          amount: parsed.amount,
          log: { address: parsed.address, topics: parsed.topics, data: parsed.data, logIndex: parsed.logIndex, removed: false },
        });
      }
    }
    if (transfers.length === 0) {
      // A receipt with no billable outbound evidence still gets one fenced
      // terminal transaction transition, after the complete receipt scan.
      // Unsafe/quarantined receipts return earlier and deliberately remain
      // unresolved for operator review.
      await this.markConfirmed(
        tx,
        receipt,
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
      return 'skipped';
    }

    const first = transfers[0];
    const pricing = transfers.map((item) => evaluatePricing({
      chainId: Number(tx.chainId),
      tokenAddress: item.address,
      amountBaseUnits: item.amount,
      observedAt: blockDate,
    }));
    if (pricing.some((item) => item.status !== 'priced')) {
      const reason = pricing.find((item) => item.status !== 'priced');
      return this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:receipt`,
          receiptRef: `${receipt.transactionHash}:receipt`,
          receiptLogIndex: null,
          periodStart,
          occurredAt: blockDate,
          assetId: first.address,
          receipt: this.buildReceiptEvidence(receipt, null, `${receipt.transactionHash}:receipt`),
          metadata: { reason: reason?.status === 'quarantined' ? reason.reason : 'mixed_receipt_evidence', logCount: transfers.length },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
    }
    const priced = pricing as Array<Extract<(typeof pricing)[number], { status: 'priced' }>>;
    if (priced.some((item) => item.tokenAddress !== priced[0].tokenAddress || item.priceUsdMicros !== priced[0].priceUsdMicros || item.tokenDecimals !== priced[0].tokenDecimals)) {
      return this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:receipt`,
          receiptRef: `${receipt.transactionHash}:receipt`,
          receiptLogIndex: null,
          periodStart,
          occurredAt: blockDate,
          assetId: first.address,
          receipt: this.buildReceiptEvidence(receipt, null, `${receipt.transactionHash}:receipt`),
          metadata: { reason: 'mixed_receipt_assets', logCount: transfers.length },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
    }
    const amount = priced.reduce((sum, item) => sum + BigInt(item.amountUsdMicros), 0n);
    const baseAmount = transfers.reduce((sum, item) => sum + item.amount, 0n);
    const result = await this.billing.recordSuccessfulOutbound({
      userId,
      transactionId: tx.id,
      sourceKey: `tx:${tx.id}:receipt`,
      status: 'posted',
      periodStart: targetPeriodStart,
      occurredAt: blockDate,
      amountUsdMicros: amount,
      quantity: BigInt(transfers.length),
      chainId: tx.chainId,
      walletAddress: tx.walletAddress,
      assetId: priced[0].tokenAddress,
      assetDecimals: priced[0].tokenDecimals,
      baseUnitAmount: baseAmount,
      unitPriceMicros: BigInt(priced[0].priceUsdMicros),
      priceSource: priced[0].priceSource,
      receipt: this.buildReceiptEvidence(
        receipt,
        null,
        `${receipt.transactionHash}:receipt`,
        transfers.map((item) => item.log),
      ),
      metadata: { policyVersion: priced[0].policyVersion, logCount: transfers.length },
      reconciliationRunId: runId,
      reconciliationRunType: RECONCILE_RUN_TYPE,
      reconciliationOwnerId: workerId,
      reconciliationAccountId: billingAccountId,
      reconciliationPeriodStart: targetPeriodStart,
      reconciliationPeriodEnd: targetPeriodEnd,
      reconciliationExpectedTransactionStatus: tx.status,
      reconciliationExpectedTxHash: tx.txHash!,
      reconciliationExpectedChainId: tx.chainId,
      reconciliationExpectedWalletAddress: tx.walletAddress,
      reconciliationTransactionStatus: 'confirmed',
    });
    return result.outcome === 'replayed' ? 'replayed' : 'posted';
  }

  private async processLog(
    userId: string,
    tx: TransactionRow,
    receipt: SanitizedReceipt,
    log: unknown,
    walletAddresses: Set<string>,
    periodStart: Date,
    blockDate: Date,
    runId: string,
    arrayIndex: number,
    workerId: string,
    billingAccountId: string,
    targetPeriodStart: Date,
    targetPeriodEnd: Date,
  ): Promise<'posted' | 'quarantined' | 'replayed' | 'skipped'> {
    const parsed = parseReceiptLog(log, arrayIndex);

    // A valid non-Transfer log is unrelated and safely ignored.
    if (parsed.kind === 'not_transfer') return 'skipped';

    if (parsed.kind === 'invalid') {
      if (parsed.reason === 'invalid_log_index') {
        // No canonical sourceKey can be built from a malformed log index. Use a
        // deterministic safe identity based on the receipt log array index so
        // multiple malformed logs stay individually diagnosable.
        const sourceKey = `tx:${tx.id}:log:invalid:${parsed.arrayIndex}`;
        const receiptRef = `${receipt.transactionHash}:log:invalid:${parsed.arrayIndex}`;
        return this.quarantine(
          userId,
          tx,
          {
            sourceKey,
            receiptRef,
            receiptLogIndex: null,
            periodStart,
            occurredAt: blockDate,
            assetId: null,
            receipt: this.buildReceiptEvidence(receipt, null, receiptRef),
            metadata: { reason: 'invalid_log_index' },
          },
          runId,
          workerId,
          billingAccountId,
          targetPeriodStart,
          targetPeriodEnd,
        );
      }

      // A Transfer log whose removal flag is missing/non-boolean/true is unsafe
      // evidence: it is quarantined with the canonical component identity and
      // never metered.
      if (parsed.reason === 'unsafe_removed') {
        const sourceKey = `tx:${tx.id}:log:${parsed.logIndex}`;
        const receiptRef = `${receipt.transactionHash}:log:${parsed.logIndex}`;
        return this.quarantine(
          userId,
          tx,
          {
            sourceKey,
            receiptRef,
            receiptLogIndex: parsed.logIndex,
            periodStart,
            occurredAt: blockDate,
            assetId: safeLogAddress(log),
            receipt: this.buildReceiptEvidence(receipt, null, receiptRef),
            metadata: { reason: 'unsafe_removed' },
          },
          runId,
          workerId,
          billingAccountId,
          targetPeriodStart,
          targetPeriodEnd,
        );
      }

      // Malformed topic/address/data with a valid log index: quarantine with
      // the canonical component identity.
      const sourceKey = `tx:${tx.id}:log:${parsed.logIndex}`;
      const receiptRef = `${receipt.transactionHash}:log:${parsed.logIndex}`;
      return this.quarantine(
        userId,
        tx,
        {
          sourceKey,
          receiptRef,
          receiptLogIndex: parsed.logIndex,
          periodStart,
          occurredAt: blockDate,
          assetId: null,
          receipt: this.buildReceiptEvidence(receipt, null, receiptRef),
          metadata: { reason: 'incomplete_log' },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
    }

    // parsed.kind === 'transfer'
    const { from, amount, logIndex, address, data, removed, topics } = parsed;
    const evidenceLog: SanitizedReceiptLog = {
      address,
      topics,
      data,
      logIndex,
      removed,
    };

    // Shape validation happens before removed handling: a valid removed log is
    // quarantined (zero volume). If existing posted evidence conflicts, the
    // BillingService ConflictException bubbles up and the tx is never confirmed.
    if (removed) {
      const sourceKey = `tx:${tx.id}:log:${logIndex}`;
      const receiptRef = `${receipt.transactionHash}:log:${logIndex}`;
      return this.quarantine(
        userId,
        tx,
        {
          sourceKey,
          receiptRef,
          receiptLogIndex: logIndex,
          periodStart,
          occurredAt: blockDate,
          assetId: address,
          receipt: this.buildReceiptEvidence(receipt, evidenceLog, receiptRef),
          metadata: { reason: 'removed_log' },
        },
        runId,
        workerId,
        billingAccountId,
        targetPeriodStart,
        targetPeriodEnd,
      );
    }

    // Only wallet-originated (outbound) logs are counted.
    if (!walletAddresses.has(from)) return 'skipped';

    const sourceKey = `tx:${tx.id}:log:${logIndex}`;
    const receiptRef = `${receipt.transactionHash}:log:${logIndex}`;

    const pricing = evaluatePricing({
      chainId: Number(tx.chainId),
      tokenAddress: address,
      amountBaseUnits: amount,
      observedAt: blockDate,
    });

    if (pricing.status === 'priced') {
      const outcome = await this.billing.recordSuccessfulOutbound({
        userId,
        transactionId: tx.id,
        sourceKey,
        status: 'posted',
        periodStart: targetPeriodStart,
        occurredAt: blockDate,
        amountUsdMicros: BigInt(pricing.amountUsdMicros),
        chainId: tx.chainId,
        walletAddress: tx.walletAddress,
        assetId: pricing.tokenAddress,
        assetDecimals: pricing.tokenDecimals,
        baseUnitAmount: amount,
        unitPriceMicros: BigInt(pricing.priceUsdMicros),
        priceSource: pricing.priceSource,
        receipt: this.buildReceiptEvidence(receipt, evidenceLog, receiptRef),
        metadata: { policyVersion: pricing.policyVersion },
        reconciliationRunId: runId,
        reconciliationRunType: RECONCILE_RUN_TYPE,
        reconciliationOwnerId: workerId,
        reconciliationAccountId: billingAccountId,
        reconciliationPeriodStart: targetPeriodStart,
        reconciliationPeriodEnd: targetPeriodEnd,
        reconciliationExpectedTransactionStatus: tx.status,
        reconciliationExpectedTxHash: tx.txHash!,
        reconciliationExpectedChainId: tx.chainId,
        reconciliationExpectedWalletAddress: tx.walletAddress,
        reconciliationTransactionStatus: 'confirmed',
      });
      return outcome.outcome === 'replayed' ? 'replayed' : 'posted';
    }

    return this.quarantine(
      userId,
      tx,
      {
        sourceKey,
        receiptRef,
        receiptLogIndex: logIndex,
        periodStart,
        occurredAt: blockDate,
        assetId: pricing.tokenAddress ?? null,
        receipt: this.buildReceiptEvidence(receipt, evidenceLog, receiptRef),
        metadata: { reason: pricing.reason, ...(pricing.details ?? {}) },
      },
      runId,
      workerId,
      billingAccountId,
      targetPeriodStart,
      targetPeriodEnd,
    );
  }

  private async quarantine(
    userId: string,
    tx: TransactionRow,
    opts: {
      sourceKey: string;
      receiptRef: string;
      receiptLogIndex: number | null;
      periodStart: Date;
      occurredAt: Date;
      assetId?: string | null;
      receipt: ReceiptUsageEvidence;
      metadata: Record<string, unknown>;
    },
    reconciliationRunId: string,
    reconciliationOwnerId: string,
    reconciliationAccountId: string,
    reconciliationPeriodStart: Date,
    reconciliationPeriodEnd: Date,
  ): Promise<'quarantined' | 'replayed'> {
    const outcome = await this.billing.recordSuccessfulOutbound({
      userId,
      transactionId: tx.id,
      sourceKey: opts.sourceKey,
      status: 'quarantined',
      // The worker target, not receipt block time, determines ledger period.
      periodStart: reconciliationPeriodStart,
      occurredAt: opts.occurredAt,
      amountUsdMicros: 0n,
      chainId: tx.chainId,
      walletAddress: tx.walletAddress,
      assetId: opts.assetId ?? null,
      receipt: opts.receipt,
      metadata: opts.metadata,
      reconciliationRunId,
      reconciliationRunType: RECONCILE_RUN_TYPE,
      reconciliationOwnerId,
      reconciliationAccountId,
      reconciliationPeriodStart,
      reconciliationPeriodEnd,
      reconciliationExpectedTransactionStatus: tx.status,
      reconciliationExpectedTxHash: tx.txHash!,
      reconciliationExpectedChainId: tx.chainId,
      reconciliationExpectedWalletAddress: tx.walletAddress,
      reconciliationTransactionStatus: 'quarantined',
    });
    return outcome.outcome === 'replayed' ? 'replayed' : 'quarantined';
  }

  private async assertCurrentOwnership(runId: string, workerId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.billingReconciliationRun.updateMany({
      where: {
        id: runId,
        status: 'running',
        workerId,
        leaseExpiresAt: { gt: now },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + RECONCILE_LEASE_MS),
      },
    });
    return result.count > 0;
  }

  /**
   * Fenced state-only transaction mutation. This is used before/after UO
   * recovery where no receipt exists yet, and for the fairness touch. The run
   * lease fence and the transaction evidence predicates share one DB
   * transaction, so a takeover cannot interleave with the state transition.
   */
  private async fencedStateUpdate(
    tx: TransactionRow,
    data: Prisma.TransactionUncheckedUpdateInput,
    runId: string,
    workerId: string,
    billingAccountId: string,
    targetPeriodStart: Date,
    targetPeriodEnd: Date,
  ): Promise<number> {
    return this.prisma.$transaction(async (db) => {
      const now = new Date();
      const fence = await db.billingReconciliationRun.updateMany({
        where: {
          id: runId,
          billingAccountId,
          accountUserId: tx.userId,
          runType: RECONCILE_RUN_TYPE,
          periodStart: targetPeriodStart,
          periodEnd: targetPeriodEnd,
          status: 'running',
          workerId,
          leaseExpiresAt: { gt: now },
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + RECONCILE_LEASE_MS),
        },
      });
      if (fence.count !== 1) return 0;

      const result = await db.transaction.updateMany({
        where: {
          id: tx.id,
          userId: tx.userId,
          status: tx.status,
          txHash: tx.txHash,
          userOpHash: tx.userOpHash ?? null,
          userOpSuccess: tx.userOpSuccess ?? null,
          billingPeriodStart: targetPeriodStart,
          billingReconciledAt: null,
          chainId: tx.chainId,
          walletAddress: tx.walletAddress,
        },
        data,
      });
      return result.count;
    });
  }

  private buildReceiptEvidence(
    receipt: SanitizedReceipt,
    log: SanitizedReceiptLog | null,
    receiptRef: string,
    logs: SanitizedReceiptLog[] = [],
  ): ReceiptUsageEvidence {
    const completeLogs = log ? [log] : logs;
    const serializedLogs = completeLogs.map((item) => ({
      address: item.address,
      topics: item.topics,
      data: item.data,
      logIndex: item.logIndex,
      removed: item.removed,
    }));
    return {
      txHash: receipt.transactionHash,
      receiptRef,
      receiptLogIndex: log?.logIndex ?? null,
      receiptBlockNumber: receipt.blockNumber,
      receiptBlockHash: receipt.blockHash,
      receiptBlockTimestamp: receipt.blockTimestamp,
      receiptStatus: receipt.status,
      receiptData: {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: receipt.status,
        blockTimestamp: receipt.blockTimestamp.toString(),
        from: receipt.from,
        to: receipt.to,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
        ...(log ? { logIndex: log.logIndex, tokenAddress: log.address, logData: log.data } : {}),
        ...(serializedLogs.length > 0
          ? {
              logs: serializedLogs,
              logDigest: createHash('sha256').update(JSON.stringify(serializedLogs)).digest('hex'),
            }
          : {}),
      },
      reconciledAt: new Date(),
    };
  }

  private blockDate(receipt: SanitizedReceipt): Date {
    return new Date(Number(receipt.blockTimestamp) * 1000);
  }

  private async markReverted(
    tx: TransactionRow,
    receipt: SanitizedReceipt,
    runId?: string,
    workerId?: string,
    billingAccountId?: string,
    targetPeriodStart?: Date,
    targetPeriodEnd?: Date,
  ): Promise<number> {
    // Preserve safe receipt evidence (hash/block/status/timestamp/reconciledAt;
    // never logs or calldata) in the same CAS update that marks the transaction
    // failed. A reverted receipt is never metered. Returns the number of rows
    // actually updated (0 = a concurrent worker already moved the row).
    const receiptDetails = {
      receipt: {
        hash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: receipt.status,
        timestamp: receipt.blockTimestamp.toString(),
        reconciledAt: new Date().toISOString(),
      },
    };
    return this.fencedTransactionUpdate(tx, receipt, {
      status: 'failed',
      failureReason: 'receipt_reverted',
      completedAt: new Date(),
      billingReconciledAt: new Date(),
      details: { ...((tx.details as Record<string, unknown>) ?? {}), ...receiptDetails } as any,
    }, runId, workerId, billingAccountId, targetPeriodStart, targetPeriodEnd);
  }

  private async markConfirmed(
    tx: TransactionRow,
    receipt: SanitizedReceipt,
    runId?: string,
    workerId?: string,
    billingAccountId?: string,
    targetPeriodStart?: Date,
    targetPeriodEnd?: Date,
  ): Promise<number> {
    const receiptDetails = {
      receipt: {
        hash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: receipt.status,
        timestamp: receipt.blockTimestamp.toString(),
        reconciledAt: new Date().toISOString(),
      },
    };
    return this.fencedTransactionUpdate(tx, receipt, {
      status: 'confirmed',
      completedAt: new Date(),
      billingReconciledAt: new Date(),
      details: { ...((tx.details as Record<string, unknown>) ?? {}), ...receiptDetails } as any,
    }, runId, workerId, billingAccountId, targetPeriodStart, targetPeriodEnd);
  }

  /**
   * Fenced post-RPC transaction transition. The lease CAS and transaction CAS
   * deliberately share one short DB transaction: a takeover cannot land
   * between an ownership check and this write. Provider calls never enter this
   * boundary.
   */
  private async fencedTransactionUpdate(
    tx: TransactionRow,
    receipt: SanitizedReceipt,
    data: Prisma.TransactionUncheckedUpdateInput,
    runId: string | undefined,
    workerId: string | undefined,
    billingAccountId: string | undefined,
    targetPeriodStart: Date | undefined,
    targetPeriodEnd: Date | undefined,
  ): Promise<number> {
    if (
      !runId || !workerId || !billingAccountId || !targetPeriodStart || !targetPeriodEnd ||
      tx.txHash === null || tx.txHash === undefined || tx.walletAddress === null || tx.walletAddress === undefined ||
      tx.chainId === null || tx.chainId === undefined
    ) {
      return 0;
    }
    return this.prisma.$transaction(async (db) => {
      const now = new Date();
      const fence = await db.billingReconciliationRun.updateMany({
        where: {
          id: runId,
          billingAccountId,
          accountUserId: tx.userId,
          runType: RECONCILE_RUN_TYPE,
          periodStart: targetPeriodStart,
          periodEnd: targetPeriodEnd,
          status: 'running',
          workerId,
          leaseExpiresAt: { gt: now },
        },
        data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + RECONCILE_LEASE_MS) },
      });
      if (fence.count === 0) return 0;
      const result = await db.transaction.updateMany({
        where: {
          id: tx.id,
          userId: tx.userId,
          status: tx.status,
          txHash: tx.txHash,
          chainId: tx.chainId,
          walletAddress: tx.walletAddress,
        },
        data,
      });
      return result.count;
    });
  }

  private monthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
}

/** Zeroed counter map for a skipped (non-overlapping) reconcile call. */
function zeroCounters(): Summary {
  return {
    scanned: 0,
    notFound: 0,
    transientError: 0,
    reverted: 0,
    posted: 0,
    quarantined: 0,
    updated: 0,
    errors: 0,
    conflicts: 0,
    replayed: 0,
    casNoops: 0,
    noHash: 0,
    retryable: 0,
    ownershipLost: false,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

type ParsedLogResult =
  | {
      kind: 'transfer';
      from: string;
      to: string;
      amount: bigint;
      logIndex: number;
      address: string;
      data: string;
      removed: boolean;
      topics: string[];
      arrayIndex: number;
    }
  | { kind: 'not_transfer' }
  | {
      kind: 'invalid';
      reason: 'invalid_log_index' | 'incomplete_log' | 'unsafe_removed';
      logIndex: number | null;
      arrayIndex: number;
    };

/**
 * Runtime-validated parsing of a single receipt log. The TypeScript shape of
 * SanitizedReceiptLog is never trusted: providers/tests may return arbitrary
 * values at runtime. Every field is validated before use so no TypeError can
 * escape (topics[0], topics.length, logIndex, address, data, ...).
 *
 * A Transfer log is only postable when its removal flag is the explicit
 * boolean `false`; a missing/non-boolean/true `removed` is `unsafe_removed`
 * and is quarantined — usage is never metered from an unsafe log.
 */
function parseReceiptLog(log: unknown, arrayIndex: number): ParsedLogResult {
  if (typeof log !== 'object' || log === null) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex: null, arrayIndex };
  }
  const l = log as Record<string, unknown>;

  // logIndex must be a non-negative safe integer (number | bigint | decimal
  // string). Invalid/missing indexes never enter a canonical sourceKey.
  const logIndex = parseLogIndex(l.logIndex);
  if (logIndex === null) {
    return { kind: 'invalid', reason: 'invalid_log_index', logIndex: null, arrayIndex };
  }

  // A Transfer log is postable only when `removed === false` (strict boolean).
  // Missing/non-boolean removal flags are unsafe evidence and are quarantined.
  const removed = l.removed;
  const removedIsFalse = removed === false;

  // topics must be an array with at least 3 elements.
  if (!Array.isArray(l.topics) || l.topics.length !== 3) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }

  // topic0 must be exactly 32-byte hex; only the ERC-20 Transfer topic enters
  // Transfer parsing. A valid non-Transfer topic is safely ignored.
  const topic0 = l.topics[0];
  if (typeof topic0 !== 'string' || !INDEXED_ADDRESS_REGEX.test(topic0)) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }
  if (topic0.toLowerCase() !== TRANSFER_TOPIC0) {
    return { kind: 'not_transfer' };
  }

  // topics[1]/topics[2] must be strictly 0x+64 hex with zero ABI padding.
  const from = parseIndexedAddressStrict(l.topics[1]);
  const to = parseIndexedAddressStrict(l.topics[2]);
  if (!from || !to) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }

  // log.address must be strictly 20-byte hex.
  if (typeof l.address !== 'string' || !TOKEN_ADDRESS_REGEX.test(l.address)) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }

  // data must be strictly 0x+64 hex uint256; parsed with BigInt, never Number.
  if (typeof l.data !== 'string' || !AMOUNT_DATA_REGEX.test(l.data)) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }
  const amount = BigInt(l.data);

  // A removal flag that is missing, non-boolean, or true makes the log unsafe.
  // It must never be metered, even when the log is otherwise well-formed.
  if (!removedIsFalse) {
    return { kind: 'invalid', reason: 'unsafe_removed', logIndex, arrayIndex };
  }

  return {
    kind: 'transfer',
    from,
    to,
    amount,
    logIndex,
    address: l.address,
    data: l.data,
    removed: false,
    topics: [topic0, l.topics[1] as string, l.topics[2] as string],
    arrayIndex,
  };
}

/**
 * Parses a log index that may arrive as a number, bigint, or decimal string.
 * Returns a non-negative safe integer or null when invalid.
 */
function parseLogIndex(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * Extracts the 20-byte address from a 32-byte indexed topic, or null when the
 * topic is malformed. ABI address topics are left-padded with 24 zero bytes
 * (48 hex chars): non-zero padding, missing elements, non-strings, and invalid
 * hex are all rejected — never sliced/truncated into an address.
 */
function parseIndexedAddressStrict(topic: unknown): string | null {
  if (typeof topic !== 'string' || !INDEXED_ADDRESS_REGEX.test(topic)) return null;
  if (!/^0x0{24}/.test(topic)) return null;
  return '0x' + topic.slice(-40).toLowerCase();
}

/** True when `value` is a parseable Date (never NaN). */
function isValidCreatedAt(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Best-effort safe token address from a runtime log object for evidence
 * identity purposes. Never throws and never fabricates an address: returns
 * null unless the log carries a valid 20-byte hex `address`.
 */
function safeLogAddress(log: unknown): string | null {
  if (typeof log !== 'object' || log === null) return null;
  const address = (log as Record<string, unknown>).address;
  return typeof address === 'string' && TOKEN_ADDRESS_REGEX.test(address) ? address : null;
}

/**
 * Compares two high-water keys. createdAt ISO strings sort chronologically for
 * UTC; ties are broken by the lexicographically largest id.
 */
function compareHighWaterMark(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

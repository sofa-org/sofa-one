import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  BillingInvoicePurpose,
  BillingPlanChangeKind,
  BillingPlanChangeStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { canonicalBillingJson } from './billing-json';
import { formatUtcMonth, microsToDecimalUsd } from './billing.utils';
import { calculateUpgradeProrationMicros } from './billing-plan-change.proration';
import { acquireBillingPeriodAdvisoryLock } from './billing-period-lock';
import { StripeSubscriptionSyncService } from './stripe/stripe-subscription-sync.service';
import { StripeAutoSubscriptionService } from './stripe/stripe-auto-subscription.service';

type Tx = Prisma.TransactionClient;
type PlanVersion = Prisma.BillingPlanVersionGetPayload<Record<string, never>>;
type PlanChangeRow = Prisma.BillingPlanChangeGetPayload<{
  include: { toPlanVersion: true; fromPlanVersion: true; chargeInvoice: true };
}>;

/**
 * JSON-safe plan-change request outcomes.
 *
 * `requiresPostCommitStripeSync` is an internal signal for BillingService only —
 * never map it onto the HTTP AssignPlanResult DTO.
 */
export type PlanChangeRequestResult =
  | {
      outcome: 'unchanged';
      planCode: string;
      planName: string;
      effectivePeriod: string;
      effectiveFrom: string;
      /** Internal: schedule was canceled; run best-effort Stripe sync after commit. */
      requiresPostCommitStripeSync?: boolean;
    }
  | {
      outcome: 'payment_required';
      planCode: string;
      planName: string;
      changeId: string;
      invoiceId: string;
      amount: string;
      currency: string;
      effectivePeriod: string;
      effectiveFrom: string;
      kind: 'upgrade';
      requiresPostCommitStripeSync?: boolean;
    }
  | {
      outcome: 'scheduled';
      planCode: string;
      planName: string;
      changeId: string;
      effectivePeriod: string;
      effectiveFrom: string;
      kind: 'downgrade';
      requiresPostCommitStripeSync?: boolean;
    };

/**
 * Result of an explicit next-period schedule cancel.
 *
 * `requiresPostCommitStripeSync` is internal — never map onto the HTTP DTO.
 */
export type CancelScheduledPlanChangeResult = {
  outcome: 'canceled' | 'unchanged';
  planCode: string;
  planName: string;
  effectivePeriod: string;
  effectiveFrom: string;
  /** Internal: schedule was canceled; run best-effort Stripe sync after commit. */
  requiresPostCommitStripeSync?: boolean;
};

/**
 * Result of canceling an unpaid pending_payment upgrade.
 * Never carries internal sync flags or BigInt.
 */
export type CancelPendingUpgradeResult = {
  outcome: 'canceled' | 'unchanged';
  planCode: string;
  planName: string;
  effectivePeriod: string;
  effectiveFrom: string;
};

/**
 * Payment-aware plan-change boundary.
 *
 * Upgrade: pending_payment + finalized plan_charge with server proration.
 * Current usage_period invoice/plan anchor stays untouched; entitlements change
 * only after first full settlement while validUntil is still in the future.
 *
 * Downgrade: schedules next UTC month without rewriting current usage invoice.
 */
@Injectable()
export class BillingPlanChangeService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly subscriptionSync?: StripeSubscriptionSyncService,
    @Optional() private readonly autoSubscription?: StripeAutoSubscriptionService,
  ) {}

  /**
   * Explicit cancel of next-period scheduled downgrade/lateral only.
   *
   * Caller must hold the current-period billing lock (same as assignPlan).
   * Acquires the next-period advisory lock, cancels `scheduled` rows, removes
   * only `downgrade_schedule` projections, and enqueues corrective Stripe /
   * auto-subscription sync targeting the currently entitled plan.
   *
   * Does not touch `pending_payment` upgrades or `renewal` / `upgrade_payment`
   * assignments. Idempotent no-op when nothing is scheduled.
   *
   * `requiresPostCommitStripeSync` is internal — BillingService must strip it
   * before mapping onto the public HTTP DTO.
   */
  async cancelScheduledPlanChange(args: {
    billingAccountId: string;
    currentPlanVersion: PlanVersion;
    now?: Date;
    tx: Tx;
  }): Promise<CancelScheduledPlanChangeResult> {
    const now = args.now ?? new Date();
    const currentMonthStart = monthStartUtc(now);
    const nextMonthStart = monthEndUtc(now);
    const { tx, billingAccountId, currentPlanVersion: current } = args;

    // Next-period lock before any schedule read/mutation (current-period lock
    // is already held by BillingService.cancelScheduledPlan).
    await acquireBillingPeriodAdvisoryLock(tx, billingAccountId, nextMonthStart);

    const canceledId = await this.cancelScheduledForNextPeriod(
      tx,
      billingAccountId,
      nextMonthStart,
      now,
    );

    if (canceledId) {
      await this.enqueueCorrectiveStripeSync(tx, {
        billingAccountId,
        sourcePlanChangeId: canceledId,
        entitledPlanVersionId: current.id,
        now,
      });
    }

    return {
      outcome: canceledId ? 'canceled' : 'unchanged',
      planCode: current.code,
      planName: current.name,
      effectivePeriod: formatUtcMonth(currentMonthStart),
      effectiveFrom: currentMonthStart.toISOString(),
      ...(canceledId ? { requiresPostCommitStripeSync: true } : {}),
    };
  }

  /**
   * Cancel an unpaid `pending_payment` upgrade for the account.
   *
   * Caller must hold the billing-period advisory lock for `expectedPeriodStart`
   * (from BillingService soft-read of the specific change id — never blindly
   * "now", never "latest pending" under the lock).
   *
   * Lock order (deadlock-safe with settlement): period (held) → payment
   * attempts FOR UPDATE (id asc) → invoice FOR UPDATE. Then fail-closed
   * inspection, CAS-cancel the expected change only, void the unpaid
   * plan_charge, and release only clean evidence-free pending attempts.
   *
   * Any Stripe payment-attempt row rejects cancel without writes (local status
   * never proves remote Checkout inactivity; only zero Stripe rows are safe).
   * USDC pending with submitted hash / receipt evidence likewise rejects;
   * evidence-free pending USDC may be released after CAS.
   *
   * Never mutates confirming/succeeded attempts, plan assignments, or Stripe
   * sync state. No assignment reads/writes. Idempotent when the expected
   * change is already gone/canceled.
   */
  async cancelPendingUpgrade(args: {
    billingAccountId: string;
    /**
     * Exact pending upgrade id from the soft-read. Null = no pending upgrade
     * was observed; return unchanged without selecting a replacement row.
     */
    expectedChangeId: string | null;
    /** Period of the expected change; must match the held period lock. */
    expectedPeriodStart: Date | null;
    now?: Date;
    tx: Tx;
  }): Promise<CancelPendingUpgradeResult> {
    const now = args.now ?? new Date();
    const { tx, billingAccountId, expectedChangeId, expectedPeriodStart } = args;
    const fallbackPeriod = expectedPeriodStart ?? monthStartUtc(now);

    const unchanged = (
      plan?: {
        code: string;
        name: string;
      } | null,
      periodStart = fallbackPeriod,
      effectiveFrom = fallbackPeriod,
    ): CancelPendingUpgradeResult => ({
      outcome: 'unchanged',
      planCode: plan?.code ?? 'free',
      planName: plan?.name ?? 'Free',
      effectivePeriod: formatUtcMonth(periodStart),
      effectiveFrom: effectiveFrom.toISOString(),
    });

    // No soft-read identity: do not pick an unrelated latest pending under lock.
    if (!expectedChangeId || !expectedPeriodStart) {
      return unchanged();
    }

    const pending = await tx.billingPlanChange.findUnique({
      where: { id: expectedChangeId },
      include: {
        fromPlanVersion: true,
        toPlanVersion: true,
        chargeInvoice: true,
      },
    });

    // Disappeared or already canceled by another actor → established no-op.
    if (!pending || pending.billingAccountId !== billingAccountId) {
      return unchanged();
    }
    if (pending.status === BillingPlanChangeStatus.canceled) {
      return unchanged(pending.fromPlanVersion, pending.periodStart, pending.effectiveAt);
    }
    if (
      pending.status !== BillingPlanChangeStatus.pending_payment ||
      pending.kind !== BillingPlanChangeKind.upgrade
    ) {
      throw new ConflictException(
        'Pending upgrade is no longer cancelable; retry or complete payment first',
      );
    }
    // Holding the old period lock must never cancel a different-period replacement.
    if (pending.periodStart.getTime() !== expectedPeriodStart.getTime()) {
      throw new ConflictException(
        'Pending upgrade period changed under lock; retry the cancellation',
      );
    }

    const invoiceId = pending.chargeInvoiceId ?? pending.chargeInvoice?.id;
    if (!invoiceId) {
      throw new ConflictException('Pending upgrade is missing its charge invoice');
    }

    // 1) Lock all payment attempts for this invoice (stable id order) BEFORE the
    //    invoice row — matches settlement's attempt-before-invoice discipline and
    //    serializes with claim hash persistence / Stripe checkout writers.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_payment_attempts"
      WHERE "invoice_id" = ${invoiceId}
      ORDER BY "id" ASC
      FOR UPDATE`;

    const attempts = await tx.billingPaymentAttempt.findMany({
      where: { invoiceId },
      orderBy: { id: 'asc' },
    });

    // Fail closed BEFORE any cancel/void writes.
    // Maximally conservative Stripe policy: ANY Stripe payment-attempt row
    // (pending/confirming/succeeded/needs_review/failed/expired/canceled) blocks
    // cancel. Local status never proves remote Checkout inactivity; the only
    // Stripe-safe path is zero Stripe attempt records on the plan_charge invoice.
    for (const attempt of attempts) {
      if (attempt.method === 'stripe') {
        throw new ConflictException(
          'Cannot cancel an upgrade while a Stripe payment attempt exists for the charge invoice',
        );
      }
      if (attempt.status === 'confirming' || attempt.status === 'succeeded') {
        throw new ConflictException(
          'Cannot cancel an upgrade while a payment attempt is confirming or succeeded',
        );
      }
      // Phase 2B: wallet-payment reservation is active across rails at any status
      // (including needs_review/unknown) — never cancel/void while reserved.
      if ((attempt as { walletPaymentReserved?: boolean }).walletPaymentReserved === true) {
        throw new ConflictException(
          'Cannot cancel an upgrade while a wallet payment reservation is active',
        );
      }
      // USDC (or any non-Stripe rail): evidence/hash markers on a still-pending
      // row mean a claim is in flight — reject without writes so cancel cannot
      // race hash CAS. Evidence-free pending USDC may be released after CAS.
      if (attempt.status === 'pending' && paymentAttemptHasEvidence(attempt)) {
        throw new ConflictException(
          'Cannot cancel an upgrade while a payment attempt has submitted evidence',
        );
      }
    }

    // 2) Invoice row lock after attempts.
    const lockedInvoice = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    if (lockedInvoice.length === 0) {
      throw new ConflictException('Upgrade charge invoice is no longer available');
    }

    const invoice = await tx.billingInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      throw new ConflictException('Upgrade charge invoice is no longer available');
    }

    if (invoice.purpose !== BillingInvoicePurpose.plan_charge) {
      throw new ConflictException('Pending upgrade charge invoice has an unexpected purpose');
    }
    if (invoice.status !== 'finalized') {
      throw new ConflictException('Pending upgrade charge invoice is not in a cancelable state');
    }
    if (invoice.paidAt != null) {
      throw new ConflictException('Cannot cancel an upgrade that has already been paid');
    }
    if (invoice.settlementAttemptId != null) {
      throw new ConflictException('Cannot cancel an upgrade that has a settlement marker');
    }
    if ((invoice.allocatedMicros ?? 0n) > 0n) {
      throw new ConflictException('Cannot cancel an upgrade that already has allocated coverage');
    }

    // CAS: only the expected id while still pending_payment.
    const cas = await tx.billingPlanChange.updateMany({
      where: {
        id: pending.id,
        status: BillingPlanChangeStatus.pending_payment,
      },
      data: {
        status: BillingPlanChangeStatus.canceled,
        canceledAt: now,
      },
    });
    if (cas.count !== 1) {
      const again = await tx.billingPlanChange.findUnique({ where: { id: pending.id } });
      if (again?.status === BillingPlanChangeStatus.canceled) {
        return unchanged(pending.fromPlanVersion, pending.periodStart, pending.effectiveAt);
      }
      throw new ConflictException('Pending upgrade could not be canceled; retry or pay it first');
    }

    const voided = await tx.billingInvoice.updateMany({
      where: {
        id: invoice.id,
        purpose: BillingInvoicePurpose.plan_charge,
        status: 'finalized',
        paidAt: null,
        settlementAttemptId: null,
        allocatedMicros: 0n,
      },
      data: { status: 'void' },
    });
    if (voided.count !== 1) {
      throw new ConflictException('Upgrade charge invoice could not be voided safely');
    }

    // Release only evidence-free pending attempts (USDC quotes with no hash).
    // Never release wallet-payment reservations (B2). Stripe pending never reaches here.
    const releasableIds = attempts
      .filter(
        (a) =>
          a.status === 'pending' &&
          !(a as { walletPaymentReserved?: boolean }).walletPaymentReserved &&
          !paymentAttemptHasEvidence(a),
      )
      .map((a) => a.id);
    if (releasableIds.length > 0) {
      await tx.billingPaymentAttempt.updateMany({
        where: {
          id: { in: releasableIds },
          status: 'pending',
          submittedTxHash: null,
          txHash: null,
          walletPaymentReserved: false,
        },
        data: {
          status: 'failed',
          failedAt: now,
          failureCode: 'upgrade_canceled',
          failureMessage: 'Plan upgrade canceled by user',
        },
      });
    }

    const entitled = pending.fromPlanVersion;
    return {
      outcome: 'canceled',
      planCode: entitled?.code ?? 'free',
      planName: entitled?.name ?? 'Free',
      effectivePeriod: formatUtcMonth(pending.periodStart),
      effectiveFrom: pending.effectiveAt.toISOString(),
    };
  }

  async requestPlanChange(args: {
    billingAccountId: string;
    userId: string;
    targetPlanVersion: PlanVersion;
    currentPlanVersion: PlanVersion;
    now?: Date;
    tx: Tx;
  }): Promise<PlanChangeRequestResult> {
    const now = args.now ?? new Date();
    const currentMonthStart = monthStartUtc(now);
    const currentMonthEnd = monthEndUtc(now);
    const nextMonthStart = currentMonthEnd;
    const nextMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));

    const target = args.targetPlanVersion;
    const current = args.currentPlanVersion;
    const { tx, billingAccountId } = args;

    // Retire stale pending upgrades so a new target can proceed.
    await this.retireStalePendingUpgrades(tx, billingAccountId, now);

    // Next-period lock before any schedule read/mutation (current-period lock
    // is already held by BillingService.assignPlan).
    await acquireBillingPeriodAdvisoryLock(tx, billingAccountId, nextMonthStart);

    // Inspect ALL next-period scheduled rows (DB does not enforce one per
    // account/period). Same-target idempotency only when every scheduled row
    // targets this plan — a matching row plus a conflicting target must not
    // short-circuit and leave the conflict worker-eligible.
    const scheduledNext = await tx.billingPlanChange.findMany({
      where: {
        billingAccountId,
        status: BillingPlanChangeStatus.scheduled,
        periodStart: nextMonthStart,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        toPlanVersion: true,
        fromPlanVersion: true,
        chargeInvoice: true,
      },
    });
    const sameTargetSchedules = scheduledNext.filter((row) => row.toPlanVersionId === target.id);
    const hasConflictingSchedule = scheduledNext.some((row) => row.toPlanVersionId !== target.id);
    if (sameTargetSchedules.length > 0 && !hasConflictingSchedule) {
      return this.toScheduled(sameTargetSchedules[0]!);
    }
    // Matching + conflict (or only conflicts / empty): fall through so
    // cancelScheduledForNextPeriod clears every scheduled row + projection,
    // then the request path recreates or returns unchanged.

    // Already on target for the current entitlement window.
    if (target.id === current.id) {
      // A different next-period schedule: cancel it and stay on current plan.
      const canceledId = await this.cancelScheduledForNextPeriod(
        tx,
        billingAccountId,
        nextMonthStart,
        now,
      );
      if (canceledId) {
        await this.enqueueCorrectiveStripeSync(tx, {
          billingAccountId,
          sourcePlanChangeId: canceledId,
          entitledPlanVersionId: current.id,
          now,
        });
      }
      return {
        outcome: 'unchanged',
        planCode: target.code,
        planName: target.name,
        effectivePeriod: formatUtcMonth(currentMonthStart),
        effectiveFrom: currentMonthStart.toISOString(),
        ...(canceledId ? { requiresPostCommitStripeSync: true } : {}),
      };
    }

    const currentFee = current.monthlyFeeMicros ?? 0n;
    const targetFee = target.monthlyFeeMicros;
    if (targetFee === null) {
      throw new ConflictException(
        'Cannot change plan: target plan has Enterprise custom/null terms',
      );
    }

    if (targetFee > currentFee) {
      // Cancel any scheduled downgrade/lateral first (same TX). If the upgrade
      // later conflicts on a different pending payment, full TX rollback
      // restores the old schedule + projection.
      const canceledId = await this.cancelScheduledForNextPeriod(
        tx,
        billingAccountId,
        nextMonthStart,
        now,
      );
      if (canceledId) {
        // Corrective sync targets the currently entitled plan — never the
        // unpaid upgrade target. Upgrade mirror sync happens only on apply.
        await this.enqueueCorrectiveStripeSync(tx, {
          billingAccountId,
          sourcePlanChangeId: canceledId,
          entitledPlanVersionId: current.id,
          now,
        });
      }
      const upgradeResult = await this.requestUpgrade({
        tx,
        billingAccountId,
        current,
        target,
        currentFee,
        targetFee,
        now,
        periodStart: currentMonthStart,
        periodEnd: currentMonthEnd,
      });
      if (canceledId && upgradeResult.outcome === 'payment_required') {
        return { ...upgradeResult, requiresPostCommitStripeSync: true };
      }
      return upgradeResult;
    }

    return this.requestDowngradeOrLateral({
      tx,
      billingAccountId,
      current,
      target,
      effectiveAt: nextMonthStart,
      periodStart: nextMonthStart,
      periodEnd: nextMonthEnd,
      now,
    });
  }

  /**
   * Apply a fully paid plan_charge upgrade inside the caller's settlement TX.
   *
   * When called from InvoiceSettlementService, pass `{ periodLockAlreadyHeld: true }`
   * — settlement already took attempt → invoice → period locks. Standalone
   * callers (recovery) acquire the period lock first (no attempt row held).
   * Expired validUntil → needs_review, payment stays recorded, no activation.
   */
  async applyPaidPlanCharge(
    tx: Tx,
    invoiceId: string,
    now = new Date(),
    opts?: { periodLockAlreadyHeld?: boolean },
  ): Promise<void> {
    const invoice = await tx.billingInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return;
    if (invoice.purpose !== BillingInvoicePurpose.plan_charge) return;
    if (invoice.paidAt == null) return;
    if (invoice.allocatedMicros < invoice.totalMicros) return;

    if (!opts?.periodLockAlreadyHeld) {
      // Standalone path: period lock before any entitlement mutation (no
      // attempt/invoice row locks are held by this helper).
      await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
    }

    const change = await tx.billingPlanChange.findFirst({
      where: {
        chargeInvoiceId: invoice.id,
        billingAccountId: invoice.billingAccountId,
      },
      include: { toPlanVersion: true },
    });
    if (!change) {
      throw new ConflictException('Paid plan_charge invoice has no linked BillingPlanChange');
    }
    if (change.status === BillingPlanChangeStatus.applied) return;
    if (change.status === BillingPlanChangeStatus.needs_review) return;
    if (change.status === BillingPlanChangeStatus.canceled) return;

    if (change.status !== BillingPlanChangeStatus.pending_payment) {
      throw new ConflictException(`Cannot apply plan change in status ${change.status}`);
    }
    if (change.kind !== BillingPlanChangeKind.upgrade) {
      throw new ConflictException('Only upgrade plan changes are payment-activated');
    }

    // Late payment after the UTC period window: keep paid invoice, do not activate.
    if (change.validUntil.getTime() <= now.getTime()) {
      await tx.billingPlanChange.updateMany({
        where: {
          id: change.id,
          status: BillingPlanChangeStatus.pending_payment,
        },
        data: {
          status: BillingPlanChangeStatus.needs_review,
        },
      });
      return;
    }

    // Entitlement only — never rewrite usage_period invoice plan/amount.
    const expiresAt = change.validUntil;
    await this.upsertAssignment(tx, {
      billingAccountId: change.billingAccountId,
      planVersionId: change.toPlanVersionId,
      periodStart: change.periodStart,
      expiresAt,
      source: 'upgrade_payment',
    });

    const applied = await tx.billingPlanChange.updateMany({
      where: {
        id: change.id,
        status: BillingPlanChangeStatus.pending_payment,
        chargeInvoiceId: invoice.id,
      },
      data: {
        status: BillingPlanChangeStatus.applied,
        appliedAt: now,
      },
    });
    if (applied.count !== 1) {
      const again = await tx.billingPlanChange.findUnique({ where: { id: change.id } });
      if (
        again?.status === BillingPlanChangeStatus.applied ||
        again?.status === BillingPlanChangeStatus.needs_review
      ) {
        return;
      }
      throw new ConflictException('Plan change apply CAS lost');
    }

    // Durable Stripe mirror sync intent (same TX). Provider call is post-commit.
    // Also retarget any never-dispatched first-subscription intent so a delayed
    // create does not charge a superseded plan.
    if (this.autoSubscription) {
      await this.autoSubscription.retargetPendingAutoIntentInTx(tx, {
        billingAccountId: change.billingAccountId,
        targetPlanVersionId: change.toPlanVersionId,
        sourcePlanChangeId: change.id,
        now,
      });
    }
    if (this.subscriptionSync) {
      await this.subscriptionSync.enqueueFromPlanChangeInTx(tx, {
        billingAccountId: change.billingAccountId,
        sourcePlanChangeId: change.id,
        defaultTargetPlanVersionId: change.toPlanVersionId,
        now,
      });
    }
  }

  /**
   * After a usage_period invoice is fully paid (renewal/fixed-fee/full), create
   * or extend a bounded assignment for that invoice period. Unpaid periods fall
   * Free at the boundary via expiresAt. Independent of Stripe subscription mirror.
   */
  async extendEntitlementForPaidUsageInvoice(
    tx: Tx,
    invoiceId: string,
    now = new Date(),
    opts?: { periodLockAlreadyHeld?: boolean },
  ): Promise<void> {
    const invoice = await tx.billingInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return;
    if (invoice.purpose !== BillingInvoicePurpose.usage_period) return;
    if (invoice.paidAt == null) return;
    if (invoice.allocatedMicros < invoice.totalMicros) return;

    const plan = await tx.billingPlanVersion.findUnique({
      where: { id: invoice.planVersionId },
    });
    if (!plan) {
      throw new ConflictException('Paid usage invoice plan version missing');
    }

    // Free / zero-fee: open-ended Free assignment for the period is enough.
    const fee = plan.monthlyFeeMicros ?? 0n;
    const expiresAt = fee > 0n ? invoice.periodEnd : null;
    if (fee > 0n && invoice.periodEnd.getTime() <= now.getTime()) {
      // Late payment for an already-ended period: record only, do not resurrect.
      return;
    }

    if (!opts?.periodLockAlreadyHeld) {
      await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
    }

    await this.upsertAssignment(tx, {
      billingAccountId: invoice.billingAccountId,
      planVersionId: plan.id,
      periodStart: invoice.periodStart,
      expiresAt,
      source: fee > 0n ? 'renewal' : 'default',
    });
  }

  /**
   * Apply due scheduled downgrades (worker). Race-safe CAS + period lock.
   */
  async applyDueScheduledChanges(now = new Date(), limit = 50): Promise<number> {
    const due = await this.prisma.billingPlanChange.findMany({
      where: {
        status: BillingPlanChangeStatus.scheduled,
        effectiveAt: { lte: now },
      },
      orderBy: { effectiveAt: 'asc' },
      take: limit,
    });
    let applied = 0;
    for (const row of due) {
      const ok = await this.prisma.$transaction(
        async (tx) => this.applyScheduledIfDue(tx, row.id, now),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (ok) applied += 1;
    }
    return applied;
  }

  async applyScheduledIfDue(tx: Tx, changeId: string, now = new Date()): Promise<boolean> {
    // Coherent single-TX path: soft read → period lock → re-read/CAS → assignment.
    // Stale/canceled/applied rows never write assignments after the re-read.
    const change = await tx.billingPlanChange.findUnique({ where: { id: changeId } });
    if (!change) return false;
    if (change.status !== BillingPlanChangeStatus.scheduled) return false;
    if (change.effectiveAt.getTime() > now.getTime()) return false;

    // Period lock first (no payment attempt/invoice row locks on this path).
    await acquireBillingPeriodAdvisoryLock(tx, change.billingAccountId, change.periodStart);

    const fresh = await tx.billingPlanChange.findUnique({ where: { id: changeId } });
    if (!fresh || fresh.status !== BillingPlanChangeStatus.scheduled) return false;
    if (fresh.effectiveAt.getTime() > now.getTime()) return false;

    const toPlan = await tx.billingPlanVersion.findUnique({
      where: { id: fresh.toPlanVersionId },
    });
    if (!toPlan) {
      throw new ConflictException('Scheduled plan change target missing');
    }
    const fee = toPlan.monthlyFeeMicros ?? 0n;

    // Re-read projection ownership under the period lock for ALL targets
    // (including Free). A delayed schedule must never overwrite a later
    // authoritative paid projection (upgrade_payment / renewal).
    const existing = await tx.billingPlanAssignment.findUnique({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: fresh.billingAccountId,
          periodStart: fresh.periodStart,
        },
      },
    });
    if (
      existing &&
      (existing.source === 'upgrade_payment' || existing.source === 'renewal') &&
      existing.planVersionId !== fresh.toPlanVersionId
    ) {
      const casSkip = await tx.billingPlanChange.updateMany({
        where: { id: fresh.id, status: BillingPlanChangeStatus.scheduled },
        data: { status: BillingPlanChangeStatus.applied, appliedAt: now },
      });
      return casSkip.count === 1;
    }

    // Same-target already projected: complete schedule without a rewrite race.
    if (
      existing &&
      existing.planVersionId === fresh.toPlanVersionId &&
      (existing.source === 'downgrade_schedule' ||
        existing.source === 'renewal' ||
        existing.source === 'upgrade_payment' ||
        (fee === 0n && existing.source === 'default'))
    ) {
      const casSame = await tx.billingPlanChange.updateMany({
        where: { id: fresh.id, status: BillingPlanChangeStatus.scheduled },
        data: { status: BillingPlanChangeStatus.applied, appliedAt: now },
      });
      return casSame.count === 1;
    }

    // Paid schedule: only project assignment when usage_period renewal is paid.
    // Collection/schedule intent alone never grants unpaid paid targets.
    if (fee > 0n) {
      const usageInv = await tx.billingInvoice.findFirst({
        where: {
          billingAccountId: fresh.billingAccountId,
          periodStart: fresh.periodStart,
          purpose: BillingInvoicePurpose.usage_period,
          paidAt: { not: null },
        },
      });
      if (!usageInv || (usageInv.allocatedMicros ?? 0n) < usageInv.totalMicros) {
        // Unpaid — leave scheduled; do not grant paid target.
        return false;
      }
    }

    const expiresAt = fee > 0n ? fresh.validUntil : null;

    // CAS status first so a concurrent cancel/apply cannot lose to a stale write.
    const cas = await tx.billingPlanChange.updateMany({
      where: { id: fresh.id, status: BillingPlanChangeStatus.scheduled },
      data: {
        status: BillingPlanChangeStatus.applied,
        appliedAt: now,
      },
    });
    if (cas.count !== 1) return false;

    await this.upsertAssignment(tx, {
      billingAccountId: fresh.billingAccountId,
      planVersionId: fresh.toPlanVersionId,
      periodStart: fresh.periodStart,
      expiresAt,
      source: fee > 0n ? 'renewal' : 'downgrade_schedule',
    });
    return true;
  }

  /**
   * Fixed-fee subscription renewal coverage: extends a bounded assignment for
   * the invoice period when a fixed_fee attempt has succeeded — independent of
   * dynamic usage invoice allocation/finalization. Open invoices stay open;
   * settlement/overage remain separate. Exactly-once via assignment projection
   * + attempt identity proof when attemptId is supplied.
   */
  async applyFixedFeeRenewalCoverage(
    tx: Tx,
    args: {
      invoiceId: string;
      planVersionId: string;
      amountMicros: bigint;
      /** Succeeded fixed_fee attempt proving this coverage (preferred). */
      attemptId?: string;
      now?: Date;
      periodLockAlreadyHeld?: boolean;
    },
  ): Promise<boolean> {
    const invoice = await tx.billingInvoice.findUnique({ where: { id: args.invoiceId } });
    if (!invoice || invoice.purpose !== BillingInvoicePurpose.usage_period) return false;
    // Open or finalized are both valid — never rewrite totals/status here.
    if (invoice.status !== 'open' && invoice.status !== 'finalized') return false;

    const plan = await tx.billingPlanVersion.findUnique({ where: { id: args.planVersionId } });
    if (!plan || plan.monthlyFeeMicros == null || plan.monthlyFeeMicros <= 0n) return false;
    // Fail closed: amount and plan identity must match server plan fee and
    // the invoice's frozen planVersionId when present.
    if (args.amountMicros !== plan.monthlyFeeMicros) return false;
    if (invoice.planVersionId && invoice.planVersionId !== plan.id) return false;
    if (invoice.monthlyFeeMicros != null && invoice.monthlyFeeMicros !== args.amountMicros) {
      return false;
    }
    if (invoice.periodStart.getTime() >= invoice.periodEnd.getTime()) return false;

    if (args.attemptId) {
      const attempt = await tx.billingPaymentAttempt.findUnique({
        where: { id: args.attemptId },
      });
      if (
        !attempt ||
        attempt.invoiceId !== invoice.id ||
        attempt.method !== 'stripe' ||
        attempt.status !== 'succeeded' ||
        attempt.stripeChargeKind !== 'fixed_fee' ||
        attempt.amountMicros !== args.amountMicros ||
        attempt.currency !== invoice.currency
      ) {
        return false;
      }
    }

    const now = args.now ?? new Date();
    if (!args.periodLockAlreadyHeld) {
      await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
    }

    const existing = await tx.billingPlanAssignment.findUnique({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: invoice.billingAccountId,
          periodStart: invoice.periodStart,
        },
      },
    });

    // Idempotent replay: same paid plan already covers this period.
    if (
      existing &&
      existing.planVersionId === plan.id &&
      existing.expiresAt != null &&
      existing.expiresAt.getTime() === invoice.periodEnd.getTime() &&
      (existing.source === 'renewal' || existing.source === 'upgrade_payment')
    ) {
      return true;
    }

    // Never roll back a newer authoritative paid projection for this period
    // (e.g. mid-period upgrade_payment, or a later renewal with a different plan).
    if (
      existing &&
      existing.planVersionId !== plan.id &&
      (existing.source === 'upgrade_payment' || existing.source === 'renewal')
    ) {
      return true;
    }

    await this.upsertAssignment(tx, {
      billingAccountId: invoice.billingAccountId,
      planVersionId: plan.id,
      periodStart: invoice.periodStart,
      expiresAt: invoice.periodEnd,
      source: 'renewal',
    });

    // Mark matching scheduled change to this plan as applied (CAS).
    await tx.billingPlanChange.updateMany({
      where: {
        billingAccountId: invoice.billingAccountId,
        periodStart: invoice.periodStart,
        toPlanVersionId: plan.id,
        status: BillingPlanChangeStatus.scheduled,
      },
      data: { status: BillingPlanChangeStatus.applied, appliedAt: now },
    });
    return true;
  }

  /**
   * Assert a plan_charge invoice is still within its change validUntil window
   * before opening checkout/quote. Expired pending → needs_review and reject.
   */
  async assertPlanChargePayable(
    tx: Tx | PrismaService,
    invoiceId: string,
    now = new Date(),
  ): Promise<void> {
    const invoice = await tx.billingInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.purpose !== BillingInvoicePurpose.plan_charge) return;

    // Voided / non-finalized plan_charge invoices are never payable (covers
    // post-cancel races where checkout/quote re-reads under the invoice lock).
    if (invoice.status !== 'finalized') {
      throw new ConflictException('Plan upgrade is no longer payable');
    }
    if (invoice.paidAt != null || invoice.settlementAttemptId != null) {
      throw new ConflictException('Plan upgrade is no longer payable');
    }

    const change = await tx.billingPlanChange.findFirst({
      where: { chargeInvoiceId: invoiceId },
    });
    if (!change) {
      throw new ConflictException('Plan charge invoice is missing its plan change');
    }
    if (
      change.status === BillingPlanChangeStatus.canceled ||
      change.status === BillingPlanChangeStatus.needs_review
    ) {
      throw new ConflictException('Plan upgrade is no longer payable');
    }
    if (change.status === BillingPlanChangeStatus.applied) {
      throw new ConflictException('Plan upgrade is already applied');
    }
    if (change.validUntil.getTime() <= now.getTime()) {
      if (change.status === BillingPlanChangeStatus.pending_payment) {
        await tx.billingPlanChange.updateMany({
          where: {
            id: change.id,
            status: BillingPlanChangeStatus.pending_payment,
          },
          data: { status: BillingPlanChangeStatus.needs_review },
        });
      }
      throw new ConflictException('Plan upgrade payment window has ended for this billing period');
    }
  }

  private async retireStalePendingUpgrades(
    tx: Tx,
    billingAccountId: string,
    now: Date,
  ): Promise<void> {
    await tx.billingPlanChange.updateMany({
      where: {
        billingAccountId,
        status: BillingPlanChangeStatus.pending_payment,
        validUntil: { lte: now },
      },
      data: { status: BillingPlanChangeStatus.needs_review },
    });
  }

  /**
   * Cancel all next-period `scheduled` plan changes and remove only
   * `downgrade_schedule` assignment projections. Never touches
   * `pending_payment` upgrades or `renewal` / `upgrade_payment` assignments.
   *
   * @returns id of the latest canceled change (Stripe attribution), or null.
   */
  private async cancelScheduledForNextPeriod(
    tx: Tx,
    billingAccountId: string,
    periodStart: Date,
    now: Date,
  ): Promise<string | null> {
    const latest = await tx.billingPlanChange.findFirst({
      where: {
        billingAccountId,
        periodStart,
        status: BillingPlanChangeStatus.scheduled,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!latest) return null;

    await tx.billingPlanChange.updateMany({
      where: {
        billingAccountId,
        periodStart,
        status: BillingPlanChangeStatus.scheduled,
      },
      data: {
        status: BillingPlanChangeStatus.canceled,
        canceledAt: now,
      },
    });

    // Projection cleanup: only schedule-owned Free/stale rows — never delete
    // renewal or upgrade_payment assignments for this future period.
    await tx.billingPlanAssignment.deleteMany({
      where: {
        billingAccountId,
        periodStart,
        source: 'downgrade_schedule',
      },
    });

    return latest.id;
  }

  /**
   * Corrective Stripe mirror sync after a schedule cancel. Target is the
   * currently entitled plan (not an unpaid upgrade). No-op without sync service.
   */
  private async enqueueCorrectiveStripeSync(
    tx: Tx,
    args: {
      billingAccountId: string;
      sourcePlanChangeId: string;
      entitledPlanVersionId: string;
      now: Date;
    },
  ): Promise<void> {
    if (this.autoSubscription) {
      await this.autoSubscription.retargetPendingAutoIntentInTx(tx, {
        billingAccountId: args.billingAccountId,
        targetPlanVersionId: args.entitledPlanVersionId,
        sourcePlanChangeId: args.sourcePlanChangeId,
        now: args.now,
      });
    }
    if (!this.subscriptionSync) return;
    await this.subscriptionSync.enqueueFromPlanChangeInTx(tx, {
      billingAccountId: args.billingAccountId,
      sourcePlanChangeId: args.sourcePlanChangeId,
      defaultTargetPlanVersionId: args.entitledPlanVersionId,
      now: args.now,
    });
  }

  private async requestUpgrade(args: {
    tx: Tx;
    billingAccountId: string;
    current: PlanVersion;
    target: PlanVersion;
    currentFee: bigint;
    targetFee: bigint;
    now: Date;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<PlanChangeRequestResult> {
    const { tx, billingAccountId, current, target, now, periodStart, periodEnd } = args;

    if (periodEnd.getTime() <= now.getTime()) {
      throw new ConflictException(
        'Cannot start an upgrade charge after the current billing period has ended',
      );
    }

    const pending = await tx.billingPlanChange.findFirst({
      where: {
        billingAccountId,
        status: BillingPlanChangeStatus.pending_payment,
      },
      include: {
        toPlanVersion: true,
        fromPlanVersion: true,
        chargeInvoice: true,
      },
    });

    if (pending) {
      if (pending.validUntil.getTime() <= now.getTime()) {
        await tx.billingPlanChange.updateMany({
          where: { id: pending.id, status: BillingPlanChangeStatus.pending_payment },
          data: { status: BillingPlanChangeStatus.needs_review },
        });
      } else if (pending.toPlanVersionId === target.id) {
        return this.toPaymentRequired(pending);
      } else {
        throw new ConflictException(
          'A different upgrade is already pending payment; pay or wait for it to expire first',
        );
      }
    }

    // Incremental proration against the current entitlement fee (supports
    // multiple sequential upgrades in one month after prior ones settle).
    const amountMicros = calculateUpgradeProrationMicros({
      currentMonthlyFeeMicros: args.currentFee,
      targetMonthlyFeeMicros: args.targetFee,
      now,
      periodStart,
      periodEnd,
    });
    if (amountMicros === null || amountMicros <= 0n) {
      throw new ConflictException(
        'Upgrade charge requires a positive prorated amount for the remaining period',
      );
    }

    const snapshot = {
      version: 1,
      purpose: 'plan_charge',
      kind: 'upgrade',
      period: formatUtcMonth(periodStart),
      fromPlanVersionId: current.id,
      toPlanVersionId: target.id,
      fromPlanCode: current.code,
      toPlanCode: target.code,
      currentMonthlyFeeMicros: microsToDecimalUsd(args.currentFee),
      targetMonthlyFeeMicros: microsToDecimalUsd(args.targetFee),
      proratedChargeMicros: microsToDecimalUsd(amountMicros),
      validUntil: periodEnd.toISOString(),
      computedAt: now.toISOString(),
    };
    const snapshotHash = createHash('sha256').update(canonicalBillingJson(snapshot)).digest('hex');

    const invoice = await tx.billingInvoice.create({
      data: {
        billingAccountId,
        planVersionId: target.id,
        periodStart,
        periodEnd,
        purpose: BillingInvoicePurpose.plan_charge,
        status: 'finalized',
        currency: 'USD',
        grossOutboundMicros: 0n,
        includedOutboundMicros: target.includedOutboundMicros,
        billableOutboundMicros: 0n,
        apiCalls: 0n,
        includedApiCalls: target.includedApiCalls,
        activeWallets: 0,
        includedWallets: target.includedWallets,
        monthlyFeeMicros: amountMicros,
        outboundOverageMicros: 0n,
        apiOverageMicros: 0n,
        walletOverageMicros: 0n,
        totalMicros: amountMicros,
        snapshotJson: snapshot as Prisma.InputJsonValue,
        snapshotHash,
        finalizedAt: now,
      },
    });

    await tx.billingInvoiceLine.create({
      data: {
        invoiceId: invoice.id,
        lineType: 'plan_upgrade_proration',
        description: `Plan upgrade proration — ${current.name} → ${target.name}`,
        quantity: 1n,
        unitAmountMicros: amountMicros,
        amountMicros,
        metadata: {
          fromPlanVersionId: current.id,
          toPlanVersionId: target.id,
        } as Prisma.InputJsonValue,
      },
    });

    try {
      const change = await tx.billingPlanChange.create({
        data: {
          billingAccountId,
          fromPlanVersionId: current.id,
          toPlanVersionId: target.id,
          kind: BillingPlanChangeKind.upgrade,
          status: BillingPlanChangeStatus.pending_payment,
          effectiveAt: periodStart,
          periodStart,
          validUntil: periodEnd,
          chargeInvoiceId: invoice.id,
        },
        include: {
          toPlanVersion: true,
          fromPlanVersion: true,
          chargeInvoice: true,
        },
      });
      return this.toPaymentRequired(change);
    } catch (err) {
      // P2002 aborts the interactive transaction in Postgres — do NOT re-query
      // the winner inside this same aborted TX. Surface conflict for outer retry.
      if (isUniqueConstraintError(err)) {
        throw new ConflictException('A concurrent upgrade request is already pending payment');
      }
      throw err;
    }
  }

  private async requestDowngradeOrLateral(args: {
    tx: Tx;
    billingAccountId: string;
    current: PlanVersion;
    target: PlanVersion;
    effectiveAt: Date;
    periodStart: Date;
    periodEnd: Date;
    now: Date;
  }): Promise<PlanChangeRequestResult> {
    const { tx, billingAccountId, current, target, effectiveAt, periodStart, periodEnd } = args;

    // Next-period lock + same-target schedule idempotency already handled in
    // requestPlanChange. Replace any remaining different scheduled row here.
    await this.cancelScheduledForNextPeriod(tx, billingAccountId, periodStart, args.now);

    const existingAssignment = await tx.billingPlanAssignment.findUnique({
      where: {
        billingAccountId_periodStart: { billingAccountId, periodStart },
      },
    });

    const targetFee = target.monthlyFeeMicros ?? 0n;

    // Paid targets are schedule/collection intent only — never write a paid
    // assignment for next month before verified renewal coverage. Free may be
    // projected immediately when no authoritative paid projection exists.
    // (cancelScheduledForNextPeriod already removed downgrade_schedule rows.)
    if (targetFee <= 0n) {
      const expiresAt = null;
      if (!existingAssignment) {
        await tx.billingPlanAssignment.create({
          data: {
            billingAccountId,
            planVersionId: target.id,
            periodStart,
            expiresAt,
            source: 'downgrade_schedule',
          },
        });
      } else if (
        existingAssignment.source !== 'upgrade_payment' &&
        existingAssignment.source !== 'renewal'
      ) {
        // Never overwrite renewal / upgrade_payment; other residual sources
        // (e.g. default) may be replaced by the Free schedule projection.
        await tx.billingPlanAssignment.update({
          where: {
            billingAccountId_periodStart: { billingAccountId, periodStart },
          },
          data: {
            planVersionId: target.id,
            expiresAt,
            source: 'downgrade_schedule',
          },
        });
      }
    }
    // Paid target: leave any remaining non-schedule assignment alone; do not
    // create an unpaid paid assignment for the future period.

    const change = await tx.billingPlanChange.create({
      data: {
        billingAccountId,
        fromPlanVersionId: current.id,
        toPlanVersionId: target.id,
        kind: BillingPlanChangeKind.downgrade,
        status: BillingPlanChangeStatus.scheduled,
        effectiveAt,
        periodStart,
        validUntil: periodEnd,
      },
      include: {
        toPlanVersion: true,
        fromPlanVersion: true,
        chargeInvoice: true,
      },
    });

    // Retarget never-dispatched first-sub intent, then enqueue mirror sync for
    // the scheduled target (Free → cancel_at_period_end).
    if (this.autoSubscription) {
      await this.autoSubscription.retargetPendingAutoIntentInTx(tx, {
        billingAccountId,
        targetPlanVersionId: target.id,
        sourcePlanChangeId: change.id,
        now: args.now,
      });
    }
    if (this.subscriptionSync) {
      await this.subscriptionSync.enqueueFromPlanChangeInTx(tx, {
        billingAccountId,
        sourcePlanChangeId: change.id,
        defaultTargetPlanVersionId: target.id,
        now: args.now,
      });
    }

    return this.toScheduled(change);
  }

  private async upsertAssignment(
    tx: Tx,
    args: {
      billingAccountId: string;
      planVersionId: string;
      periodStart: Date;
      expiresAt: Date | null;
      source: string;
    },
  ): Promise<void> {
    const existing = await tx.billingPlanAssignment.findUnique({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: args.billingAccountId,
          periodStart: args.periodStart,
        },
      },
    });
    if (existing) {
      await tx.billingPlanAssignment.update({
        where: { id: existing.id },
        data: {
          planVersionId: args.planVersionId,
          expiresAt: args.expiresAt,
          source: args.source,
        },
      });
      return;
    }
    await tx.billingPlanAssignment.create({
      data: {
        billingAccountId: args.billingAccountId,
        planVersionId: args.planVersionId,
        periodStart: args.periodStart,
        expiresAt: args.expiresAt,
        source: args.source,
      },
    });
  }

  private toPaymentRequired(change: PlanChangeRow): PlanChangeRequestResult {
    const invoice = change.chargeInvoice;
    if (!invoice) {
      throw new ConflictException('Pending upgrade is missing its charge invoice');
    }
    return {
      outcome: 'payment_required',
      planCode: change.toPlanVersion.code,
      planName: change.toPlanVersion.name,
      changeId: change.id,
      invoiceId: invoice.id,
      amount: microsToDecimalUsd(invoice.totalMicros),
      currency: invoice.currency,
      effectivePeriod: formatUtcMonth(change.periodStart),
      effectiveFrom: change.effectiveAt.toISOString(),
      kind: 'upgrade',
    };
  }

  private toScheduled(change: PlanChangeRow): PlanChangeRequestResult {
    return {
      outcome: 'scheduled',
      planCode: change.toPlanVersion.code,
      planName: change.toPlanVersion.name,
      changeId: change.id,
      effectivePeriod: formatUtcMonth(change.periodStart),
      effectiveFrom: change.effectiveAt.toISOString(),
      kind: 'downgrade',
    };
  }
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthEndUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * True when a payment attempt carries any submitted/on-chain evidence marker.
 * A still-`pending` row with evidence must block upgrade cancel (claim in flight).
 */
function paymentAttemptHasEvidence(attempt: {
  submittedTxHash: string | null;
  txHash: string | null;
  receiptEvidence: unknown;
  blockNumber: bigint | null;
  blockHash: string | null;
  blockTimestamp: bigint | null;
  actualBaseUnits: bigint | null;
  logIndex: number | null;
  payerAddress: string | null;
  allocatedAt: Date | null;
  succeededAt: Date | null;
  walletPaymentReserved?: boolean;
}): boolean {
  if (attempt.walletPaymentReserved === true) return true;
  return (
    attempt.submittedTxHash != null ||
    attempt.txHash != null ||
    attempt.receiptEvidence != null ||
    attempt.blockNumber != null ||
    attempt.blockHash != null ||
    attempt.blockTimestamp != null ||
    attempt.actualBaseUnits != null ||
    attempt.logIndex != null ||
    attempt.payerAddress != null ||
    attempt.allocatedAt != null ||
    attempt.succeededAt != null
  );
}

/** Locate the single usage_period invoice for an account+period (if any). */
export async function findUsagePeriodInvoice(
  tx: Tx | PrismaService,
  billingAccountId: string,
  periodStart: Date,
) {
  return tx.billingInvoice.findFirst({
    where: {
      billingAccountId,
      periodStart,
      purpose: BillingInvoicePurpose.usage_period,
    },
  });
}

export async function findUsagePeriodInvoiceOrThrow(
  tx: Tx | PrismaService,
  billingAccountId: string,
  periodStart: Date,
) {
  const row = await findUsagePeriodInvoice(tx, billingAccountId, periodStart);
  if (!row) throw new NotFoundException('Invoice not found');
  return row;
}

/**
 * Valid assignment filter at instant `at`.
 * - Non-expired paid windows: expiresAt > at
 * - Open-ended only via expiresAt null (Free default / free downgrade only;
 *   callers must reject paid plans that lack expiresAt after load).
 */
export function validAssignmentWhere(at: Date): Prisma.BillingPlanAssignmentWhereInput {
  return {
    OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
  };
}

/**
 * After loading an assignment+plan, reject paid plans without a bounded
 * expiresAt (legacy indefinite paid rows must not grant access forever).
 */
export function isAssignmentEntitlementValid(
  assignment: { expiresAt: Date | null; source: string | null },
  plan: { monthlyFeeMicros: bigint | null; code: string } | null | undefined,
  at: Date,
): boolean {
  if (!plan) return false;
  const fee = plan.monthlyFeeMicros ?? 0n;
  if (assignment.expiresAt != null) {
    return assignment.expiresAt.getTime() > at.getTime();
  }
  // Open-ended (null expiresAt) is only allowed for zero-fee rows. Paid plans
  // without a bound never grant indefinite access. Zero-fee unknown codes are
  // still returned so callers can fail closed via validatePlanVersion.
  if (fee > 0n) return false;
  return true;
}

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  BillingAutoSubscriptionStatus,
  Prisma,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import * as Stripe from 'stripe';
import { PrismaService } from '../../../core/database/prisma.service';
import { getErrorText, sanitizeErrorMessage } from '../../../common/utils/sanitize';
import { STRIPE_CHARGE_KIND_FULL, STRIPE_CLIENT } from './stripe.constants';
import {
  readStripeSubscriptionPeriodBounds,
  stripePeriodBoundsToDates,
} from './stripe-subscription-period';
import { StripeSubscriptionSyncService } from './stripe-subscription-sync.service';

type Tx = Prisma.TransactionClient;
type AutoIntent = Prisma.BillingAutoSubscriptionIntentGetPayload<Record<string, never>>;
type InvoiceRow = Prisma.BillingInvoiceGetPayload<Record<string, never>>;
type AttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;
type AccountRow = Prisma.BillingAccountGetPayload<Record<string, never>>;
type PlanRow = Prisma.BillingPlanVersionGetPayload<Record<string, never>>;

const MICROS_PER_CENT = 10_000n;
const MAX_RETRIES = 5;
const BACKOFF_MS = 60_000;
const LEASE_MS = 2 * 60 * 1000;
const BATCH = 25;
const RECOVERY_BATCH = 25;
/** Stripe idempotency keys are retained ~24h; after that replaying create is unsafe. */
const STRIPE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Never-dispatched Free retarget supersede — recoverable when paid target returns. */
const FREE_SUPERSEDE_CODE = 'scheduled_free_no_subscription';

export type AutoSubProcessResult = {
  attempted: number;
  completed: number;
  needsReview: number;
  retryable: number;
  recovered: number;
};

/**
 * First recurring Stripe subscription after a successful one-time Card payment.
 *
 * - enqueueAfterPaidCardInTx: durable outbox row inside the settlement TX (throws
 *   on write failure so the webhook TX rolls back and Stripe retries — never
 *   catch-and-continue after a Postgres error in the same interactive TX).
 * - recoverMissingPaidIntents: bounded worker scan for paid eligible attempts
 *   missing an intent (local anomaly compensation).
 * - processDue: provider work OUTSIDE DB transactions with unique lease tokens.
 * - Starts billing at the next UTC month (never the paid invoice's periodStart).
 * - USDC / Free / custom / dynamic-overage invoices never enqueue.
 * - Any account with a stripeSubscriptionId binding blocks a second create.
 * - Dispatched needs_review still occupies the account slot (partial unique).
 */
@Injectable()
export class StripeAutoSubscriptionService {
  private readonly logger = new Logger(StripeAutoSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
    @Optional() private readonly subscriptionSync?: StripeSubscriptionSyncService,
  ) {}

  /**
   * Deterministic short Stripe idempotency key (≤67 chars).
   * Material binds account/attempt/plan/cents/effective start; digest is SHA-256.
   * Product create uses `${key}:p` (still well under Stripe's 255 limit).
   */
  static buildOperationIdempotencyKey(input: {
    billingAccountId: string;
    sourceAttemptId: string;
    planVersionId: string;
    unitAmountCents: number;
    effectivePeriodStart: Date;
  }): string {
    const material = [
      'v1',
      input.billingAccountId,
      input.sourceAttemptId,
      input.planVersionId,
      String(input.unitAmountCents),
      input.effectivePeriodStart.toISOString(),
    ].join('|');
    const digest = createHash('sha256').update(material, 'utf8').digest('hex');
    return `as1_${digest}`;
  }

  /**
   * Persist a durable first-subscription intent inside the caller's paid-settlement
   * TX (atomic outbox). Throws on write failure so the webhook TX rolls back and
   * Stripe retries. Idempotent returns for same attempt / blocking slot reuse.
   *
   * Callers must pass a re-read succeeded attempt and a fully paid invoice
   * (paidAt + settlementAttemptId evidence) from the same TX.
   */
  async enqueueAfterPaidCardInTx(
    tx: Tx,
    args: {
      account: AccountRow;
      invoice: InvoiceRow;
      /** Must reflect succeeded status under the current TX (re-read after CAS). */
      attempt: AttemptRow;
      now?: Date;
    },
  ): Promise<{ intentId: string; enqueued: boolean } | null> {
    const { account, invoice, attempt } = args;
    const now = args.now ?? new Date();

    // Settlement evidence — never trust a stale pre-CAS attempt snapshot alone.
    if (attempt.method !== 'stripe') return null;
    if (attempt.stripeChargeKind !== STRIPE_CHARGE_KIND_FULL) return null;
    if (attempt.status !== 'succeeded') return null;
    if (!account.stripeCustomerId) return null;
    if (invoice.paidAt == null) return null;
    if (invoice.settlementAttemptId !== attempt.id) return null;
    if ((invoice.allocatedMicros ?? 0n) < invoice.totalMicros) return null;

    // Any existing subscription binding blocks a second remote create.
    if (account.stripeSubscriptionId) {
      return null;
    }

    // Invoice must be an eligible paid Card charge shape; the *subscription*
    // target plan may differ when a next-month schedule already wins.
    if (!(await this.isEligiblePaidInvoiceRow(tx, invoice))) return null;

    const targetPlan = await this.resolveRenewalTargetPlanInTx(tx, {
      billingAccountId: account.id,
      fallbackPlanVersionId: invoice.planVersionId,
      now,
    });
    if (!targetPlan) return null;

    // Same attempt already has an intent (webhook replay) — idempotent.
    // Free-superseded never-dispatched rows can be revived to a paid target
    // (or re-parked as Free) via retarget.
    const existingByAttempt = await tx.billingAutoSubscriptionIntent.findUnique({
      where: { sourceAttemptId: attempt.id },
    });
    if (existingByAttempt) {
      if (
        this.isRecoverableFreeSupersede(existingByAttempt) ||
        (existingByAttempt.status === BillingAutoSubscriptionStatus.pending &&
          existingByAttempt.dispatchedAt == null)
      ) {
        const revived = await this.retargetPendingAutoIntentInTx(tx, {
          billingAccountId: account.id,
          targetPlanVersionId: targetPlan.id,
          sourcePlanChangeId: `revive:${attempt.id}`,
          now,
        });
        if (revived) return { intentId: revived.intentId, enqueued: true };
        // Free retarget parks as superseded — still the durable row for this attempt.
        return { intentId: existingByAttempt.id, enqueued: false };
      }
      return { intentId: existingByAttempt.id, enqueued: false };
    }

    const fee = targetPlan.monthlyFeeMicros ?? 0n;
    const cents = Number(fee / MICROS_PER_CENT);
    if (!Number.isSafeInteger(cents) || cents <= 0 || fee <= 0n) {
      // Free / zero-fee scheduled target and no existing row: nothing to create.
      return null;
    }

    // Next UTC month — never reuse the paid invoice's (possibly past) periodStart.
    const effectivePeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    const effectivePeriodEnd = new Date(
      Date.UTC(
        effectivePeriodStart.getUTCFullYear(),
        effectivePeriodStart.getUTCMonth() + 1,
        1,
      ),
    );

    const operationIdempotencyKey = StripeAutoSubscriptionService.buildOperationIdempotencyKey({
      billingAccountId: account.id,
      sourceAttemptId: attempt.id,
      planVersionId: targetPlan.id,
      unitAmountCents: cents,
      effectivePeriodStart,
    });

    const frozenPayload = {
      kind: 'create_subscription' as const,
      keyVersion: 'v1',
      billingAccountId: account.id,
      sourceInvoiceId: invoice.id,
      sourceAttemptId: attempt.id,
      planVersionId: targetPlan.id,
      planCode: targetPlan.code,
      stripeCustomerId: account.stripeCustomerId,
      unitAmountCents: cents,
      currency: 'usd',
      interval: 'month',
      intervalCount: 1,
      quantity: 1,
      prorationBehavior: 'none',
      paymentMethodTypes: ['card'],
      effectivePeriodStart: effectivePeriodStart.toISOString(),
      effectivePeriodEnd: effectivePeriodEnd.toISOString(),
      billingCycleAnchorUnix: Math.floor(effectivePeriodStart.getTime() / 1000),
    };

    // Blocking unfinished / uncertain-dispatched slots occupy the account.
    const blocking = await tx.billingAutoSubscriptionIntent.findFirst({
      where: {
        billingAccountId: account.id,
        OR: [
          {
            status: {
              in: [
                BillingAutoSubscriptionStatus.pending,
                BillingAutoSubscriptionStatus.in_flight,
              ],
            },
          },
          {
            status: BillingAutoSubscriptionStatus.needs_review,
            dispatchedAt: { not: null },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (blocking) {
      return { intentId: blocking.id, enqueued: false };
    }

    // Create is the only writer path. On unique conflict Prisma throws P2002 —
    // do NOT catch and re-query in this TX (Postgres aborts the interactive TX).
    // Let the error propagate so the webhook rolls back and Stripe retries.
    const created = await tx.billingAutoSubscriptionIntent.create({
      data: {
        billingAccountId: account.id,
        sourceInvoiceId: invoice.id,
        sourceAttemptId: attempt.id,
        planVersionId: targetPlan.id,
        stripeCustomerId: account.stripeCustomerId,
        effectivePeriodStart,
        effectivePeriodEnd,
        unitAmountCents: cents,
        currency: 'usd',
        status: BillingAutoSubscriptionStatus.pending,
        operationIdempotencyKey,
        frozenPayloadJson: frozenPayload as Prisma.InputJsonValue,
        nextRetryAt: now,
      },
    });
    return { intentId: created.id, enqueued: true };
  }

  /**
   * Bounded recovery: paid eligible Stripe full attempts with NO intent row.
   * - NOT EXISTS excludes already-intent rows
   * - Static invoice shape filters exclude dynamic overage
   * - Durable keyset cursor advances past skipped candidates across ticks
   * Does not call Stripe.
   */
  async recoverMissingPaidIntents(
    workerId: string,
    limit = RECOVERY_BATCH,
  ): Promise<{ scanned: number; enqueued: number; skipped: number }> {
    let scanned = 0;
    let enqueued = 0;
    let skipped = 0;
    const now = new Date();

    const cursorRow = await this.prisma.billingAutoSubRecoveryCursor
      .findUnique({ where: { id: 'default' } })
      .catch(() => null);
    const cursorAt = cursorRow?.cursorSucceededAt ?? null;
    const cursorId = cursorRow?.cursorAttemptId ?? null;

    // Keyset: (succeeded_at, id) > cursor. succeeded_at IS NOT NULL for stable order.
    const missing = cursorAt && cursorId
      ? await this.prisma.$queryRaw<Array<{ id: string; succeeded_at: Date }>>`
          SELECT a.id, a.succeeded_at
          FROM billing_payment_attempts a
          INNER JOIN billing_invoices i ON i.id = a.invoice_id
          INNER JOIN billing_accounts acc ON acc.id = i.billing_account_id
          WHERE a.method = 'stripe'
            AND a.stripe_charge_kind = ${STRIPE_CHARGE_KIND_FULL}
            AND a.status = 'succeeded'
            AND a.succeeded_at IS NOT NULL
            AND i.paid_at IS NOT NULL
            AND i.settlement_attempt_id = a.id
            AND i.allocated_micros >= i.total_micros
            AND (
              i.purpose = 'plan_charge'
              OR (
                i.purpose = 'usage_period'
                AND COALESCE(i.outbound_overage_micros, 0) = 0
                AND COALESCE(i.api_overage_micros, 0) = 0
                AND COALESCE(i.wallet_overage_micros, 0) = 0
                AND i.monthly_fee_micros > 0
                AND i.total_micros = i.monthly_fee_micros
              )
            )
            AND acc.stripe_subscription_id IS NULL
            AND acc.stripe_customer_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM billing_auto_subscription_intents s
              WHERE s.source_attempt_id = a.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM billing_auto_subscription_intents b
              WHERE b.billing_account_id = acc.id
                AND (
                  b.status IN ('pending', 'in_flight')
                  OR (b.status = 'needs_review' AND b.dispatched_at IS NOT NULL)
                )
            )
            AND (
              a.succeeded_at > ${cursorAt}
              OR (a.succeeded_at = ${cursorAt} AND a.id > ${cursorId}::uuid)
            )
          ORDER BY a.succeeded_at ASC, a.id ASC
          LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<Array<{ id: string; succeeded_at: Date }>>`
          SELECT a.id, a.succeeded_at
          FROM billing_payment_attempts a
          INNER JOIN billing_invoices i ON i.id = a.invoice_id
          INNER JOIN billing_accounts acc ON acc.id = i.billing_account_id
          WHERE a.method = 'stripe'
            AND a.stripe_charge_kind = ${STRIPE_CHARGE_KIND_FULL}
            AND a.status = 'succeeded'
            AND a.succeeded_at IS NOT NULL
            AND i.paid_at IS NOT NULL
            AND i.settlement_attempt_id = a.id
            AND i.allocated_micros >= i.total_micros
            AND (
              i.purpose = 'plan_charge'
              OR (
                i.purpose = 'usage_period'
                AND COALESCE(i.outbound_overage_micros, 0) = 0
                AND COALESCE(i.api_overage_micros, 0) = 0
                AND COALESCE(i.wallet_overage_micros, 0) = 0
                AND i.monthly_fee_micros > 0
                AND i.total_micros = i.monthly_fee_micros
              )
            )
            AND acc.stripe_subscription_id IS NULL
            AND acc.stripe_customer_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM billing_auto_subscription_intents s
              WHERE s.source_attempt_id = a.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM billing_auto_subscription_intents b
              WHERE b.billing_account_id = acc.id
                AND (
                  b.status IN ('pending', 'in_flight')
                  OR (b.status = 'needs_review' AND b.dispatched_at IS NOT NULL)
                )
            )
          ORDER BY a.succeeded_at ASC, a.id ASC
          LIMIT ${limit}
        `;

    let lastSucceededAt: Date | null = cursorAt;
    let lastAttemptId: string | null = cursorId;

    for (const row of missing) {
      scanned += 1;
      lastSucceededAt = row.succeeded_at;
      lastAttemptId = row.id;
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const freshAttempt = await tx.billingPaymentAttempt.findUnique({
            where: { id: row.id },
          });
          if (!freshAttempt) return null;
          const freshInvoice = await tx.billingInvoice.findUnique({
            where: { id: freshAttempt.invoiceId },
          });
          if (!freshInvoice) return null;
          const account = await tx.billingAccount.findUnique({
            where: { id: freshInvoice.billingAccountId },
          });
          if (!account) return null;
          return this.enqueueAfterPaidCardInTx(tx, {
            account,
            invoice: freshInvoice,
            attempt: freshAttempt,
            now,
          });
        });
        if (result?.enqueued) {
          enqueued += 1;
          this.logger.log(
            `Auto-subscription recovery enqueued intent ${result.intentId} for attempt ${row.id} worker=${workerId}`,
          );
        } else {
          skipped += 1;
        }
      } catch (err) {
        skipped += 1;
        this.logger.warn(
          `Auto-subscription recovery failed for attempt ${row.id}: ${sanitizeErrorMessage(getErrorText(err))}`,
        );
      }
    }

    // Persist cursor past every scanned row (including skips) for cross-tick fairness.
    // Empty batch past end → reset cursor so newly inserted older gaps are rare;
    // new payments have newer succeeded_at and appear after the cursor naturally.
    try {
      if (missing.length === 0 && cursorAt) {
        await this.prisma.billingAutoSubRecoveryCursor.upsert({
          where: { id: 'default' },
          create: { id: 'default', cursorSucceededAt: null, cursorAttemptId: null },
          update: { cursorSucceededAt: null, cursorAttemptId: null },
        });
      } else if (lastAttemptId && lastSucceededAt) {
        await this.prisma.billingAutoSubRecoveryCursor.upsert({
          where: { id: 'default' },
          create: {
            id: 'default',
            cursorSucceededAt: lastSucceededAt,
            cursorAttemptId: lastAttemptId,
          },
          update: {
            cursorSucceededAt: lastSucceededAt,
            cursorAttemptId: lastAttemptId,
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Auto-subscription recovery cursor persist failed: ${sanitizeErrorMessage(getErrorText(err))}`,
      );
    }

    return { scanned, enqueued, skipped };
  }

  /**
   * Prove PaymentIntent payment_method + customer, require type=card, attach if
   * needed, and set Customer invoice_settings.default_payment_method.
   * Requires a lease token — unfenced callers are rejected.
   */
  async savePaymentMethodBestEffort(
    intentId: string,
    leaseOwnerId: string,
  ): Promise<boolean> {
    if (!leaseOwnerId) return false;
    const stripe = this.stripe;
    if (!stripe) return false;

    const intent = await this.prisma.billingAutoSubscriptionIntent.findUnique({
      where: { id: intentId },
    });
    if (!intent) return false;
    if (intent.leaseOwnerId !== leaseOwnerId) return false;
    if (
      intent.status !== BillingAutoSubscriptionStatus.pending &&
      intent.status !== BillingAutoSubscriptionStatus.in_flight
    ) {
      return intent.paymentMethodSavedAt != null;
    }
    if (intent.paymentMethodSavedAt && intent.stripePaymentMethodId) {
      return true;
    }

    const attempt = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: intent.sourceAttemptId },
    });
    if (!attempt?.stripePaymentIntentId) {
      await this.markRetryOrReview(
        intent.id,
        'missing_payment_intent',
        'validation',
        leaseOwnerId,
      );
      return false;
    }

    try {
      // Re-confirm lease before provider work.
      if (!(await this.stillOwnsLease(intent.id, leaseOwnerId))) return false;

      const pi = await stripe.paymentIntents.retrieve(attempt.stripePaymentIntentId);
      const pmId = providerPaymentMethodId(pi.payment_method);
      const piCustomer = providerCustomerId(pi.customer);
      if (!pmId) {
        await this.markRetryOrReview(
          intent.id,
          'missing_payment_method',
          'validation',
          leaseOwnerId,
        );
        return false;
      }
      if (!piCustomer || piCustomer !== intent.stripeCustomerId) {
        await this.markNeedsReview(
          intent.id,
          'payment_intent_customer_mismatch',
          'validation',
          leaseOwnerId,
        );
        return false;
      }
      if (pi.status !== 'succeeded') {
        await this.markRetryOrReview(
          intent.id,
          'payment_intent_not_succeeded',
          'validation',
          leaseOwnerId,
        );
        return false;
      }

      const pm = await stripe.paymentMethods.retrieve(pmId);
      if (pm.type !== 'card') {
        await this.markNeedsReview(
          intent.id,
          'payment_method_not_card',
          'validation',
          leaseOwnerId,
        );
        return false;
      }
      const pmCustomer = providerCustomerId(pm.customer);
      if (pmCustomer && pmCustomer !== intent.stripeCustomerId) {
        await this.markNeedsReview(
          intent.id,
          'payment_method_customer_mismatch',
          'validation',
          leaseOwnerId,
        );
        return false;
      }
      if (!pmCustomer) {
        await stripe.paymentMethods.attach(pmId, { customer: intent.stripeCustomerId });
      }

      await stripe.customers.update(intent.stripeCustomerId, {
        invoice_settings: { default_payment_method: pmId },
      });

      const customer = await stripe.customers.retrieve(intent.stripeCustomerId);
      if (customer.deleted) {
        await this.markNeedsReview(intent.id, 'customer_deleted', 'validation', leaseOwnerId);
        return false;
      }
      const defaultPm = providerPaymentMethodId(
        (customer as { invoice_settings?: { default_payment_method?: unknown } }).invoice_settings
          ?.default_payment_method,
      );
      if (defaultPm !== pmId) {
        await this.markRetryOrReview(
          intent.id,
          'default_payment_method_not_set',
          'provider',
          leaseOwnerId,
        );
        return false;
      }

      // Re-confirm lease after provider work before writing.
      if (!(await this.stillOwnsLease(intent.id, leaseOwnerId))) return false;

      const saved = await this.prisma.billingAutoSubscriptionIntent.updateMany({
        where: this.leaseFenceWhere(intent.id, leaseOwnerId),
        data: {
          stripePaymentMethodId: pmId,
          paymentMethodSavedAt: new Date(),
          lastErrorCode: null,
          lastErrorType: null,
        },
      });
      return saved.count === 1;
    } catch (err) {
      const msg = sanitizeErrorMessage(getErrorText(err));
      this.logger.warn(`Auto-subscription PM save ${intent.id} failed: ${msg}`);
      await this.markRetryOrReview(intent.id, 'pm_save_error', 'uncertain', leaseOwnerId);
      return false;
    }
  }

  /** Best-effort immediate process after settlement commit (never throws). */
  async processAccountBestEffort(billingAccountId: string): Promise<void> {
    try {
      const due = await this.prisma.billingAutoSubscriptionIntent.findMany({
        where: {
          billingAccountId,
          status: {
            in: [
              BillingAutoSubscriptionStatus.pending,
              BillingAutoSubscriptionStatus.in_flight,
            ],
          },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 3,
      });
      for (const intent of due) {
        // Unique lease token per invocation — never reuse a stable account prefix.
        await this.processOne(intent, `be-${randomUUID()}`);
      }
    } catch (err) {
      this.logger.warn(
        `Auto-subscription best-effort failed for account ${billingAccountId}: ${sanitizeErrorMessage(getErrorText(err))}`,
      );
    }
  }

  /** Worker entry: recovery scan + process due intents with unique leases. */
  async processDue(workerId: string, limit = BATCH): Promise<AutoSubProcessResult> {
    let recovered = 0;
    try {
      const recovery = await this.recoverMissingPaidIntents(workerId, Math.min(limit, RECOVERY_BATCH));
      recovered = recovery.enqueued;
    } catch (err) {
      this.logger.warn(
        `Auto-subscription recovery scan failed: ${sanitizeErrorMessage(getErrorText(err))}`,
      );
    }

    if (!this.stripe) {
      const outstanding = await this.prisma.billingAutoSubscriptionIntent.count({
        where: {
          status: {
            in: [
              BillingAutoSubscriptionStatus.pending,
              BillingAutoSubscriptionStatus.in_flight,
            ],
          },
        },
      });
      if (outstanding > 0) {
        await this.prisma.billingAutoSubscriptionIntent.updateMany({
          where: { status: BillingAutoSubscriptionStatus.pending },
          data: {
            lastErrorCode: 'stripe_not_configured',
            lastErrorType: 'config',
            nextRetryAt: new Date(Date.now() + BACKOFF_MS),
          },
        });
        return {
          attempted: outstanding,
          completed: 0,
          needsReview: 0,
          retryable: outstanding,
          recovered,
        };
      }
      return { attempted: 0, completed: 0, needsReview: 0, retryable: 0, recovered };
    }

    const due = await this.prisma.billingAutoSubscriptionIntent.findMany({
      where: {
        status: {
          in: [
            BillingAutoSubscriptionStatus.pending,
            BillingAutoSubscriptionStatus.in_flight,
          ],
        },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: new Date() } },
          { leaseExpiresAt: { lt: new Date() } },
        ],
      },
      orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });

    let completed = 0;
    let needsReview = 0;
    let retryable = 0;
    for (const intent of due) {
      // Unique lease token per process invocation (workerId is a prefix only).
      const leaseToken = `${workerId}:${randomUUID()}`;
      const outcome = await this.processOne(intent, leaseToken);
      if (outcome === 'completed') completed += 1;
      else if (outcome === 'needs_review') needsReview += 1;
      else if (outcome === 'retryable') retryable += 1;
    }
    return { attempted: due.length, completed, needsReview, retryable, recovered };
  }

  private async processOne(
    seed: AutoIntent,
    leaseToken: string,
  ): Promise<'completed' | 'needs_review' | 'retryable' | 'skipped'> {
    const stripe = this.stripe;
    if (!stripe) return 'skipped';

    const leased = await this.prisma.billingAutoSubscriptionIntent.updateMany({
      where: {
        id: seed.id,
        status: {
          in: [
            BillingAutoSubscriptionStatus.pending,
            BillingAutoSubscriptionStatus.in_flight,
          ],
        },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: new Date() } },
          { leaseOwnerId: leaseToken },
        ],
      },
      data: {
        status: BillingAutoSubscriptionStatus.in_flight,
        leaseOwnerId: leaseToken,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        retryCount: { increment: 1 },
      },
    });
    if (leased.count !== 1) return 'skipped';

    const intent = await this.prisma.billingAutoSubscriptionIntent.findUnique({
      where: { id: seed.id },
    });
    if (
      !intent ||
      intent.status !== BillingAutoSubscriptionStatus.in_flight ||
      intent.leaseOwnerId !== leaseToken
    ) {
      return 'skipped';
    }
    if (!intent.frozenPayloadJson || !intent.operationIdempotencyKey) {
      await this.markNeedsReview(intent.id, 'missing_frozen_payload', 'validation', leaseToken);
      return 'needs_review';
    }

    const account = await this.prisma.billingAccount.findUnique({
      where: { id: intent.billingAccountId },
    });
    if (!account) {
      await this.markNeedsReview(intent.id, 'account_missing', 'validation', leaseToken);
      return 'needs_review';
    }
    if (account.stripeCustomerId !== intent.stripeCustomerId) {
      await this.markNeedsReview(intent.id, 'customer_binding_changed', 'validation', leaseToken);
      return 'needs_review';
    }

    // Existing subscription binding: never create a second remote sub.
    // If webhook bound first, prove THIS intent owns the sub via metadata before
    // completing and enqueueing corrective sync for the current renewal target.
    if (account.stripeSubscriptionId) {
      if (this.isLiveOrUncertainStatus(account.stripeSubscriptionStatus)) {
        const proven = await this.proveIntentOwnsBoundSubscription(
          stripe,
          intent,
          account.stripeSubscriptionId,
        );
        if (proven.ok) {
          await this.bindAndComplete(intent, proven.sub, leaseToken);
          return 'completed';
        }
        if (proven.code === 'foreign_subscription') {
          // Live sub that is not ours — do not create a second; leave for review.
          await this.markNeedsReview(
            intent.id,
            'existing_foreign_subscription',
            'validation',
            leaseToken,
          );
          return 'needs_review';
        }
        await this.markNeedsReview(intent.id, proven.code, 'validation', leaseToken);
        return 'needs_review';
      }
      // Terminal/canceled/incomplete_expired/unknown: block create, keep slot.
      await this.markNeedsReview(
        intent.id,
        'terminal_subscription_binding',
        'validation',
        leaseToken,
      );
      return 'needs_review';
    }

    // Ensure default Card PM is saved before create.
    const pmOk = await this.savePaymentMethodBestEffort(intent.id, leaseToken);
    const fresh = await this.prisma.billingAutoSubscriptionIntent.findUnique({
      where: { id: intent.id },
    });
    if (
      !fresh ||
      fresh.leaseOwnerId !== leaseToken ||
      fresh.status === BillingAutoSubscriptionStatus.needs_review
    ) {
      return fresh?.status === BillingAutoSubscriptionStatus.needs_review
        ? 'needs_review'
        : 'skipped';
    }
    if (!pmOk || !fresh.stripePaymentMethodId || !fresh.paymentMethodSavedAt) {
      return 'retryable';
    }

    const frozen = this.readFrozenPayload(fresh.frozenPayloadJson);
    const cents =
      typeof frozen.unitAmountCents === 'number'
        ? frozen.unitAmountCents
        : fresh.unitAmountCents;
    const currency = this.asNonEmptyString(frozen.currency) ?? fresh.currency ?? 'usd';
    const anchorUnix =
      typeof frozen.billingCycleAnchorUnix === 'number'
        ? frozen.billingCycleAnchorUnix
        : Math.floor(fresh.effectivePeriodStart.getTime() / 1000);
    const productName =
      typeof frozen.planCode === 'string'
        ? `SOFA ONE — ${frozen.planCode} subscription`
        : 'SOFA ONE subscription';

    if (!Number.isSafeInteger(cents) || cents <= 0) {
      await this.markNeedsReview(fresh.id, 'invalid_unit_amount', 'validation', leaseToken);
      return 'needs_review';
    }
    if (anchorUnix * 1000 !== fresh.effectivePeriodStart.getTime()) {
      await this.markNeedsReview(fresh.id, 'anchor_mismatch', 'validation', leaseToken);
      return 'needs_review';
    }

    // Stripe idempotency retention: after ~24h from first dispatch, never blind-retry create.
    if (
      fresh.dispatchedAt &&
      Date.now() - fresh.dispatchedAt.getTime() > STRIPE_IDEMPOTENCY_RETENTION_MS
    ) {
      const found = await this.findExistingSubscriptionByIntent(stripe, fresh);
      if (found?.ok) {
        await this.bindAndComplete(fresh, found.sub, leaseToken);
        return 'completed';
      }
      await this.markNeedsReview(
        fresh.id,
        found?.code ?? 'idempotency_window_expired',
        'provider',
        leaseToken,
      );
      return 'needs_review';
    }

    // Mark first dispatch only when we are about to call the provider.
    if (fresh.dispatchedAt == null) {
      const marked = await this.prisma.billingAutoSubscriptionIntent.updateMany({
        where: {
          id: fresh.id,
          status: BillingAutoSubscriptionStatus.in_flight,
          leaseOwnerId: leaseToken,
          dispatchedAt: null,
        },
        data: { dispatchedAt: new Date() },
      });
      if (marked.count !== 1) return 'skipped';
    }

    try {
      const product = await stripe.products.create(
        {
          name: productName,
          metadata: {
            planVersionId: fresh.planVersionId,
            billingAccountId: fresh.billingAccountId,
          },
        },
        { idempotencyKey: `${fresh.operationIdempotencyKey}:p` },
      );
      if (!product?.id) {
        await this.markNeedsReview(fresh.id, 'product_create_incomplete', 'provider', leaseToken);
        return 'needs_review';
      }

      const sub = await stripe.subscriptions.create(
        {
          customer: fresh.stripeCustomerId,
          default_payment_method: fresh.stripePaymentMethodId,
          items: [
            {
              quantity: 1,
              price_data: {
                currency,
                product: product.id,
                unit_amount: cents,
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
          billing_cycle_anchor: anchorUnix,
          proration_behavior: 'none',
          payment_behavior: 'error_if_incomplete',
          metadata: {
            billingAccountId: fresh.billingAccountId,
            planVersionId: fresh.planVersionId,
            sourceInvoiceId: fresh.sourceInvoiceId,
            sourceAttemptId: fresh.sourceAttemptId,
            autoSubscriptionIntentId: fresh.id,
          },
        },
        { idempotencyKey: fresh.operationIdempotencyKey },
      );

      const validated = this.validateCreatedSubscription(fresh, sub);
      if (!validated.ok) {
        // Provider object may exist — keep slot via needs_review, never reset key.
        await this.markNeedsReview(fresh.id, validated.code, 'validation', leaseToken);
        return 'needs_review';
      }

      await this.bindAndComplete(fresh, sub, leaseToken);
      return 'completed';
    } catch (err) {
      const msg = sanitizeErrorMessage(getErrorText(err));
      this.logger.warn(`Auto-subscription create ${fresh.id} failed: ${msg}`);
      if (err instanceof ConflictException) {
        // Binding lost — keep needs_review with dispatchedAt set (slot held).
        await this.markNeedsReview(fresh.id, 'binding_conflict', 'validation', leaseToken);
        return 'needs_review';
      }
      const current = await this.prisma.billingAutoSubscriptionIntent.findUnique({
        where: { id: fresh.id },
      });
      if (current && current.retryCount >= MAX_RETRIES) {
        await this.markNeedsReview(fresh.id, 'retries_exhausted', 'provider', leaseToken);
        return 'needs_review';
      }
      const backoff = Math.min(
        BACKOFF_MS * 2 ** Math.min(current?.retryCount ?? fresh.retryCount, 6),
        24 * 60 * 60 * 1000,
      );
      await this.prisma.billingAutoSubscriptionIntent.updateMany({
        where: {
          id: fresh.id,
          status: BillingAutoSubscriptionStatus.in_flight,
          leaseOwnerId: leaseToken,
        },
        data: {
          status: BillingAutoSubscriptionStatus.in_flight,
          nextRetryAt: new Date(Date.now() + backoff),
          leaseExpiresAt: null,
          lastErrorCode: 'provider_error',
          lastErrorType: 'uncertain',
        },
      });
      return 'retryable';
    }
  }

  /**
   * After Stripe idempotency window expiry: search customer subscriptions for
   * frozen intent metadata and prove identity before completing.
   */
  private async findExistingSubscriptionByIntent(
    stripe: NonNullable<typeof this.stripe>,
    intent: AutoIntent,
  ): Promise<
    | { ok: true; sub: Stripe.Subscription }
    | { ok: false; code: string }
  > {
    try {
      const listed = await stripe.subscriptions.list({
        customer: intent.stripeCustomerId,
        status: 'all',
        limit: 100,
        expand: ['data.items.data.price'],
      });
      const matches = (listed.data ?? []).filter((sub) => {
        const meta = sub.metadata ?? {};
        return (
          meta.autoSubscriptionIntentId === intent.id &&
          meta.sourceAttemptId === intent.sourceAttemptId &&
          meta.billingAccountId === intent.billingAccountId
        );
      });
      if (matches.length === 0) {
        return { ok: false, code: 'idempotency_window_expired_no_match' };
      }
      if (matches.length > 1) {
        return { ok: false, code: 'idempotency_window_ambiguous_match' };
      }
      // Existing sub may have advanced past the first pre-anchor period —
      // use recovery validation, not create-response (end==anchor) checks.
      const validated = this.validateExistingSubscriptionForRecovery(intent, matches[0]);
      if (!validated.ok) {
        return { ok: false, code: validated.code };
      }
      return { ok: true, sub: matches[0] };
    } catch {
      return { ok: false, code: 'idempotency_window_lookup_failed' };
    }
  }

  /**
   * Prove a live account-bound subscription was created by THIS auto-intent
   * (webhook-first race). Requires exact customer + metadata identity.
   */
  private async proveIntentOwnsBoundSubscription(
    stripe: NonNullable<typeof this.stripe>,
    intent: AutoIntent,
    subscriptionId: string,
  ): Promise<
    | { ok: true; sub: Stripe.Subscription }
    | { ok: false; code: string }
  > {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null);
      if (!customerId || customerId !== intent.stripeCustomerId) {
        return { ok: false, code: 'bound_sub_customer_mismatch' };
      }
      const meta = sub.metadata ?? {};
      if (
        meta.autoSubscriptionIntentId === intent.id &&
        meta.sourceAttemptId === intent.sourceAttemptId &&
        meta.billingAccountId === intent.billingAccountId
      ) {
        const shape = this.validateExistingSubscriptionForRecovery(intent, sub);
        if (!shape.ok) return { ok: false, code: shape.code };
        return { ok: true, sub };
      }
      return { ok: false, code: 'foreign_subscription' };
    } catch {
      return { ok: false, code: 'bound_sub_retrieve_failed' };
    }
  }

  /**
   * Bind account subscription mirror from provider facts only.
   * - First bind (stripeSubscriptionId IS NULL): initialize id/status/period/
   *   active plan from the create response. Never touch webhook event-order
   *   fields (stripeSubscriptionUpdatedAt / EventId).
   * - Already same subscription: verify exact customer/sub only — do NOT write
   *   status/period/active plan (webhook may already own newer facts).
   * - Different subscription: conflict → needs_review.
   */
  private async bindAndComplete(
    intent: AutoIntent,
    sub: Stripe.Subscription,
    leaseToken: string,
  ): Promise<void> {
    const periodBounds = readStripeSubscriptionPeriodBounds(sub);
    const periodDates = periodBounds ? stripePeriodBoundsToDates(periodBounds) : null;

    await this.prisma.$transaction(async (tx) => {
      const account = await tx.billingAccount.findUnique({
        where: { id: intent.billingAccountId },
      });
      if (!account || account.stripeCustomerId !== intent.stripeCustomerId) {
        throw new ConflictException('Account customer binding mismatch');
      }
      if (account.stripeSubscriptionId && account.stripeSubscriptionId !== sub.id) {
        throw new ConflictException('Account subscription binding conflict');
      }

      if (account.stripeSubscriptionId == null) {
        // First bind only — initialize mirror from provider response.
        const bound = await tx.billingAccount.updateMany({
          where: {
            id: intent.billingAccountId,
            stripeCustomerId: intent.stripeCustomerId,
            stripeSubscriptionId: null,
          },
          data: {
            stripeSubscriptionId: sub.id,
            stripeSubscriptionStatus: sub.status,
            ...(periodDates
              ? {
                  stripeSubscriptionPeriodStart: periodDates.start,
                  stripeSubscriptionPeriodEnd: periodDates.end,
                }
              : {}),
            activeSubscriptionPlanVersionId: intent.planVersionId,
            // Intentionally omit stripeSubscriptionUpdatedAt / EventId so
            // customer.subscription.* webhooks remain the event-order authority.
          },
        });
        if (bound.count !== 1) {
          throw new ConflictException('Account subscription binding conflict');
        }
      }
      // else: already bound to this exact sub — verify only, no mirror write.

      const done = await tx.billingAutoSubscriptionIntent.updateMany({
        where: {
          id: intent.id,
          status: BillingAutoSubscriptionStatus.in_flight,
          leaseOwnerId: leaseToken,
          operationIdempotencyKey: intent.operationIdempotencyKey,
        },
        data: {
          status: BillingAutoSubscriptionStatus.completed,
          stripeSubscriptionId: sub.id,
          completedAt: new Date(),
          leaseExpiresAt: null,
          nextRetryAt: null,
          lastErrorCode: null,
          lastErrorType: null,
        },
      });
      if (done.count !== 1) {
        throw new ConflictException('Auto-subscription completion CAS lost');
      }

      // Corrective sync uses the CURRENT renewal target (schedule/assignment),
      // not the possibly-stale frozen create plan — so Free/Growth after delay
      // still cancel/update before the first full-month charge.
      if (this.subscriptionSync) {
        const now = new Date();
        const currentTarget = await this.resolveRenewalTargetPlanInTx(tx, {
          billingAccountId: intent.billingAccountId,
          now,
        });
        const defaultTargetId = currentTarget?.id ?? intent.planVersionId;
        await this.subscriptionSync.enqueueFromPlanChangeInTx(tx, {
          billingAccountId: intent.billingAccountId,
          sourcePlanChangeId: intent.id,
          defaultTargetPlanVersionId: defaultTargetId,
          now,
        });
      }
    });
  }

  /**
   * plan_charge upgrades always qualify when the target plan has a finite
   * positive cent-aligned monthly fee. usage_period first invoices qualify only
   * when the frozen total equals that fixed fee (no dynamic overage).
   */
  isEligiblePaidInvoice(invoice: InvoiceRow, plan: PlanRow): boolean {
    const fee = plan.monthlyFeeMicros;
    if (fee == null || fee <= 0n) return false;
    if (fee % MICROS_PER_CENT !== 0n) return false;
    if (fee > BigInt(Number.MAX_SAFE_INTEGER) * MICROS_PER_CENT) return false;

    const purpose = (invoice as { purpose?: string }).purpose ?? 'usage_period';
    if (purpose === 'plan_charge') return true;
    if (purpose === 'usage_period') {
      return (
        invoice.totalMicros === fee &&
        invoice.monthlyFeeMicros === fee &&
        (invoice.outboundOverageMicros ?? 0n) === 0n &&
        (invoice.apiOverageMicros ?? 0n) === 0n &&
        (invoice.walletOverageMicros ?? 0n) === 0n
      );
    }
    return false;
  }

  /** Live/uncertain statuses that safely skip create (sync owns updates). */
  isLiveOrUncertainStatus(status: string | null | undefined): boolean {
    if (!status) return true; // bound id without status → uncertain
    return (
      status === 'active' ||
      status === 'trialing' ||
      status === 'past_due' ||
      status === 'unpaid' ||
      status === 'incomplete' ||
      status === 'paused'
    );
  }

  /** Immediate create-response shape (pre-anchor first period end == anchor). */
  private validateCreatedSubscription(
    intent: AutoIntent,
    sub: Stripe.Subscription,
  ): { ok: true } | { ok: false; code: string } {
    const base = this.validateSubscriptionIdentityAndPrice(intent, sub);
    if (!base.ok) return base;
    const anchor = (sub as { billing_cycle_anchor?: number }).billing_cycle_anchor;
    if (typeof anchor !== 'number' || anchor * 1000 !== intent.effectivePeriodStart.getTime()) {
      return { ok: false, code: 'response_anchor_mismatch' };
    }
    // Mid-month create: item period is [create_time, anchor).
    const period = readStripeSubscriptionPeriodBounds(sub);
    if (!period) return { ok: false, code: 'response_period_missing' };
    if (period.endSec !== anchor) {
      return { ok: false, code: 'response_period_end_not_anchor' };
    }
    if (period.startSec >= period.endSec) {
      return { ok: false, code: 'response_period_invalid' };
    }
    return { ok: true };
  }

  /**
   * Existing-subscription recovery after idempotency window / webhook-first bind.
   * Allows current period to have advanced past the original pre-anchor window;
   * still requires exact metadata/customer/one monthly USD item/amount/shape.
   */
  private validateExistingSubscriptionForRecovery(
    intent: AutoIntent,
    sub: Stripe.Subscription,
  ): { ok: true } | { ok: false; code: string } {
    const base = this.validateSubscriptionIdentityAndPrice(intent, sub);
    if (!base.ok) return base;
    const anchor = (sub as { billing_cycle_anchor?: number }).billing_cycle_anchor;
    if (typeof anchor === 'number' && anchor * 1000 !== intent.effectivePeriodStart.getTime()) {
      return { ok: false, code: 'response_anchor_mismatch' };
    }
    const period = readStripeSubscriptionPeriodBounds(sub);
    if (!period || period.startSec >= period.endSec) {
      return { ok: false, code: 'response_period_missing' };
    }
    // Require intent metadata on existing recovery matches (create always sets them).
    const meta = sub.metadata ?? {};
    if (meta.autoSubscriptionIntentId !== intent.id) {
      return { ok: false, code: 'response_metadata_intent_mismatch' };
    }
    if (meta.sourceAttemptId !== intent.sourceAttemptId) {
      return { ok: false, code: 'response_metadata_attempt_mismatch' };
    }
    if (meta.billingAccountId !== intent.billingAccountId) {
      return { ok: false, code: 'response_metadata_account_mismatch' };
    }
    return { ok: true };
  }

  private validateSubscriptionIdentityAndPrice(
    intent: AutoIntent,
    sub: Stripe.Subscription,
  ): { ok: true } | { ok: false; code: string } {
    const customerId =
      typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null);
    if (!customerId || customerId !== intent.stripeCustomerId) {
      return { ok: false, code: 'response_customer_mismatch' };
    }
    if (!sub.id || typeof sub.id !== 'string') {
      return { ok: false, code: 'response_subscription_id_missing' };
    }
    const items = sub.items?.data ?? [];
    if (items.length !== 1) {
      return { ok: false, code: 'response_item_count' };
    }
    const price = items[0]?.price;
    if (!price || typeof price === 'string') {
      return { ok: false, code: 'response_price_missing' };
    }
    if (price.currency !== intent.currency) {
      return { ok: false, code: 'response_currency_mismatch' };
    }
    if (price.unit_amount !== intent.unitAmountCents) {
      return { ok: false, code: 'response_amount_mismatch' };
    }
    if (price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1) {
      return { ok: false, code: 'response_interval_mismatch' };
    }
    return { ok: true };
  }

  /**
   * Rebuild a never-dispatched auto-intent (pending OR Free-superseded) to the
   * current renewal target. Free→paid revive rebuilds next-UTC-month anchor from
   * `now` (never reuses a stale past anchor). Dispatched/uncertain never retargeted.
   * Other account blocking slots block revive without mutating the historical row.
   */
  async retargetPendingAutoIntentInTx(
    tx: Tx,
    args: {
      billingAccountId: string;
      targetPlanVersionId: string;
      sourcePlanChangeId: string;
      now?: Date;
    },
  ): Promise<{ intentId: string } | null> {
    const now = args.now ?? new Date();

    // Prefer live pending; else recoverable Free-supersede on same account.
    let pending = await tx.billingAutoSubscriptionIntent.findFirst({
      where: {
        billingAccountId: args.billingAccountId,
        status: BillingAutoSubscriptionStatus.pending,
        dispatchedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!pending) {
      pending = await tx.billingAutoSubscriptionIntent.findFirst({
        where: {
          billingAccountId: args.billingAccountId,
          status: BillingAutoSubscriptionStatus.superseded,
          dispatchedAt: null,
          lastErrorCode: FREE_SUPERSEDE_CODE,
        },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!pending || pending.dispatchedAt != null) return null;

    // Another blocking intent on this account (excluding the candidate itself)
    // must not be displaced by revive — leave history unchanged.
    const otherBlocking = await tx.billingAutoSubscriptionIntent.findFirst({
      where: {
        billingAccountId: args.billingAccountId,
        id: { not: pending.id },
        OR: [
          {
            status: {
              in: [
                BillingAutoSubscriptionStatus.pending,
                BillingAutoSubscriptionStatus.in_flight,
              ],
            },
          },
          {
            status: BillingAutoSubscriptionStatus.needs_review,
            dispatchedAt: { not: null },
          },
        ],
      },
      select: { id: true },
    });
    if (otherBlocking) {
      return null;
    }

    const targetPlan = await tx.billingPlanVersion.findUnique({
      where: { id: args.targetPlanVersionId },
    });
    if (!targetPlan) return null;

    const fee = targetPlan.monthlyFeeMicros ?? 0n;
    if (fee <= 0n || fee % MICROS_PER_CENT !== 0n) {
      // Free target: park as recoverable supersede (no remote sub).
      await tx.billingAutoSubscriptionIntent.updateMany({
        where: {
          id: pending.id,
          dispatchedAt: null,
          status: {
            in: [
              BillingAutoSubscriptionStatus.pending,
              BillingAutoSubscriptionStatus.superseded,
            ],
          },
        },
        data: {
          status: BillingAutoSubscriptionStatus.superseded,
          lastErrorCode: FREE_SUPERSEDE_CODE,
          lastErrorType: 'superseded',
          nextRetryAt: null,
          leaseExpiresAt: null,
          leaseOwnerId: null,
        },
      });
      return null;
    }

    const cents = Number(fee / MICROS_PER_CENT);
    if (!Number.isSafeInteger(cents) || cents <= 0) return null;

    // Always rebuild anchor from current UTC time (cross-month Free→paid safety).
    const effectivePeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    const effectivePeriodEnd = new Date(
      Date.UTC(
        effectivePeriodStart.getUTCFullYear(),
        effectivePeriodStart.getUTCMonth() + 1,
        1,
      ),
    );

    const operationIdempotencyKey = StripeAutoSubscriptionService.buildOperationIdempotencyKey({
      billingAccountId: args.billingAccountId,
      sourceAttemptId: pending.sourceAttemptId,
      planVersionId: targetPlan.id,
      unitAmountCents: cents,
      effectivePeriodStart,
    });

    const frozenPayload = {
      kind: 'create_subscription' as const,
      keyVersion: 'v1',
      billingAccountId: args.billingAccountId,
      sourceInvoiceId: pending.sourceInvoiceId,
      sourceAttemptId: pending.sourceAttemptId,
      planVersionId: targetPlan.id,
      planCode: targetPlan.code,
      stripeCustomerId: pending.stripeCustomerId,
      unitAmountCents: cents,
      currency: 'usd',
      interval: 'month',
      intervalCount: 1,
      quantity: 1,
      prorationBehavior: 'none',
      paymentMethodTypes: ['card'],
      effectivePeriodStart: effectivePeriodStart.toISOString(),
      effectivePeriodEnd: effectivePeriodEnd.toISOString(),
      billingCycleAnchorUnix: Math.floor(effectivePeriodStart.getTime() / 1000),
      retargetFromPlanChangeId: args.sourcePlanChangeId,
    };

    const updated = await tx.billingAutoSubscriptionIntent.updateMany({
      where: {
        id: pending.id,
        dispatchedAt: null,
        status: {
          in: [
            BillingAutoSubscriptionStatus.pending,
            BillingAutoSubscriptionStatus.superseded,
          ],
        },
      },
      data: {
        status: BillingAutoSubscriptionStatus.pending,
        planVersionId: targetPlan.id,
        unitAmountCents: cents,
        effectivePeriodStart,
        effectivePeriodEnd,
        operationIdempotencyKey,
        frozenPayloadJson: frozenPayload as Prisma.InputJsonValue,
        nextRetryAt: now,
        lastErrorCode: null,
        lastErrorType: null,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        retryCount: 0,
        dispatchedAt: null,
        stripeSubscriptionId: null,
        paymentMethodSavedAt: null,
        stripePaymentMethodId: null,
        completedAt: null,
      },
    });
    if (updated.count !== 1) return null;
    return { intentId: pending.id };
  }

  private isRecoverableFreeSupersede(intent: {
    status: string;
    dispatchedAt: Date | null;
    lastErrorCode: string | null;
  }): boolean {
    return (
      intent.status === BillingAutoSubscriptionStatus.superseded &&
      intent.dispatchedAt == null &&
      intent.lastErrorCode === FREE_SUPERSEDE_CODE
    );
  }

  private async isEligiblePaidInvoiceRow(tx: Tx, invoice: InvoiceRow): Promise<boolean> {
    const plan = await tx.billingPlanVersion.findUnique({
      where: { id: invoice.planVersionId },
    });
    if (!plan) return false;
    return this.isEligiblePaidInvoice(invoice, plan);
  }

  /**
   * Resolve the plan that should govern the *next UTC month* renewal charge:
   * 1. scheduled plan change for that month (including explicit Free)
   * 2. current/latest *paid* plan assignment active at `now` — even when its
   *    expiresAt equals next-month start (first Card upgrade month boundary).
   *    Never prefer an older default Free over a current paid assignment.
   * 3. optional fallback (paid invoice plan) only as last resort.
   */
  private async resolveRenewalTargetPlanInTx(
    tx: Tx,
    args: {
      billingAccountId: string;
      now: Date;
      fallbackPlanVersionId?: string;
    },
  ): Promise<PlanRow | null> {
    const nextMonthStart = new Date(
      Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth() + 1, 1),
    );

    const scheduled = await tx.billingPlanChange.findFirst({
      where: {
        billingAccountId: args.billingAccountId,
        status: 'scheduled',
        periodStart: nextMonthStart,
      },
      orderBy: { createdAt: 'desc' },
      include: { toPlanVersion: true },
    });
    if (scheduled?.toPlanVersion) return scheduled.toPlanVersion;

    // Current entitled assignment at `now` (periodStart ≤ now < expiresAt|∞).
    // Paid (fee > 0) wins for next-month renewal even if expiresAt == nextMonthStart
    // (upgrade assignment is valid through end of current month exclusive).
    const currentAtNow = await tx.billingPlanAssignment.findFirst({
      where: {
        billingAccountId: args.billingAccountId,
        periodStart: { lte: args.now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
      },
      orderBy: { periodStart: 'desc' },
      include: { planVersion: true },
    });
    if (currentAtNow?.planVersion) {
      const fee = currentAtNow.planVersion.monthlyFeeMicros ?? 0n;
      if (fee > 0n) return currentAtNow.planVersion;
      // Current is Free — still return it so callers can cancel/no-create unless
      // fallback is a paid invoice plan from the payment that just settled.
    }

    // Latest paid assignment that started at or before next month (historical
    // Free default must not outrank a just-paid Starter for the current month).
    const paidAssignments = await tx.billingPlanAssignment.findMany({
      where: {
        billingAccountId: args.billingAccountId,
        periodStart: { lte: nextMonthStart },
      },
      orderBy: { periodStart: 'desc' },
      take: 10,
      include: { planVersion: true },
    });
    for (const row of paidAssignments) {
      const fee = row.planVersion?.monthlyFeeMicros ?? 0n;
      if (fee > 0n && row.planVersion) return row.planVersion;
    }

    if (currentAtNow?.planVersion) return currentAtNow.planVersion;

    if (args.fallbackPlanVersionId) {
      return tx.billingPlanVersion.findUnique({
        where: { id: args.fallbackPlanVersionId },
      });
    }
    return null;
  }

  private async stillOwnsLease(intentId: string, leaseOwnerId: string): Promise<boolean> {
    const row = await this.prisma.billingAutoSubscriptionIntent.findUnique({
      where: { id: intentId },
      select: { leaseOwnerId: true, status: true, leaseExpiresAt: true },
    });
    if (!row) return false;
    if (row.leaseOwnerId !== leaseOwnerId) return false;
    if (
      row.status !== BillingAutoSubscriptionStatus.pending &&
      row.status !== BillingAutoSubscriptionStatus.in_flight
    ) {
      return false;
    }
    if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() < Date.now()) return false;
    return true;
  }

  /**
   * Lease-fenced status transition — leaseOwnerId is REQUIRED.
   * Stale executors never mutate a newer lease.
   */
  private leaseFenceWhere(id: string, leaseOwnerId: string): Record<string, unknown> {
    return {
      id,
      leaseOwnerId,
      status: {
        in: [
          BillingAutoSubscriptionStatus.pending,
          BillingAutoSubscriptionStatus.in_flight,
        ],
      },
    };
  }

  private async markNeedsReview(
    id: string,
    code: string,
    type: string,
    leaseOwnerId: string,
  ): Promise<void> {
    await this.prisma.billingAutoSubscriptionIntent.updateMany({
      where: this.leaseFenceWhere(id, leaseOwnerId),
      data: {
        status: BillingAutoSubscriptionStatus.needs_review,
        lastErrorCode: code.slice(0, 80),
        lastErrorType: type.slice(0, 80),
        leaseExpiresAt: null,
        nextRetryAt: null,
      },
    });
  }

  private async markRetryOrReview(
    id: string,
    code: string,
    type: string,
    leaseOwnerId: string,
  ): Promise<void> {
    const intent = await this.prisma.billingAutoSubscriptionIntent.findUnique({
      where: { id },
    });
    if (!intent) return;
    if (intent.leaseOwnerId !== leaseOwnerId) return;
    if (intent.retryCount >= MAX_RETRIES) {
      await this.markNeedsReview(id, code, type, leaseOwnerId);
      return;
    }
    const backoff = Math.min(
      BACKOFF_MS * 2 ** Math.min(intent.retryCount, 6),
      24 * 60 * 60 * 1000,
    );
    await this.prisma.billingAutoSubscriptionIntent.updateMany({
      where: this.leaseFenceWhere(id, leaseOwnerId),
      data: {
        lastErrorCode: code.slice(0, 80),
        lastErrorType: type.slice(0, 80),
        nextRetryAt: new Date(Date.now() + backoff),
        leaseExpiresAt: null,
      },
    });
  }

  private readFrozenPayload(json: Prisma.JsonValue): Record<string, unknown> {
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      return { ...(json as Record<string, unknown>) };
    }
    return {};
  }

  private asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

function providerPaymentMethodId(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('pm_')) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    const id = (value as { id: string }).id;
    return id.startsWith('pm_') ? id : null;
  }
  return null;
}

function providerCustomerId(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('cus_')) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    const id = (value as { id: string }).id;
    return id.startsWith('cus_') ? id : null;
  }
  return null;
}

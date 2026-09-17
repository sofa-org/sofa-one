import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  BillingSubscriptionSyncKind,
  BillingSubscriptionSyncStatus,
  Prisma,
} from '@prisma/client';
import * as Stripe from 'stripe';
import { PrismaService } from '../../../core/database/prisma.service';
import { getErrorText, sanitizeErrorMessage } from '../../../common/utils/sanitize';
import { acquireBillingPeriodAdvisoryLock } from '../billing-period-lock';
import { STRIPE_CLIENT } from './stripe.constants';

type Tx = Prisma.TransactionClient;
type SyncIntent = Prisma.BillingSubscriptionSyncIntentGetPayload<Record<string, never>>;

const MICROS_PER_CENT = 10_000n;
const MAX_RETRIES = 5;
const BACKOFF_MS = 60_000;
const LEASE_MS = 2 * 60 * 1000;
const BATCH = 25;

export type SyncProcessResult = {
  attempted: number;
  synced: number;
  needsReview: number;
  retryable: number;
};

/**
 * Durable Stripe subscription mirror sync (Gate 1 B4).
 *
 * - enqueueInTx: commit intent with local plan-change apply (no Stripe calls).
 * - processDue / processAccountBestEffort: retrieve+update OUTSIDE DB transactions.
 * - Local entitlement never depends on sync success.
 * - Exactly one licensed USD monthly item is updated by id; Free → cancel_at_period_end.
 */
@Injectable()
export class StripeSubscriptionSyncService {
  private readonly logger = new Logger(StripeSubscriptionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
    @Optional() private readonly /* keep DI stable */ _unused?: unknown,
  ) {}

  /**
   * Enqueue (or supersede) a sync intent inside the caller's plan-change TX.
   * No-op when the account has no Stripe subscription binding.
   *
   * When a future scheduled change already exists for next month, that target
   * wins for next renewal (upgrade must not clear scheduled Free/downgrade).
   */
  async enqueueFromPlanChangeInTx(
    tx: Tx,
    args: {
      billingAccountId: string;
      sourcePlanChangeId: string;
      /** Plan version that should drive the *next* renewal when no schedule wins. */
      defaultTargetPlanVersionId: string;
      now?: Date;
    },
  ): Promise<{ intentId: string; revision: number } | null> {
    const account = await tx.billingAccount.findUnique({
      where: { id: args.billingAccountId },
    });
    if (!account?.stripeSubscriptionId || !account.stripeCustomerId) {
      return null;
    }

    const now = args.now ?? new Date();
    const nextMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    // Explicit future schedule wins for next renewal.
    const scheduled = await tx.billingPlanChange.findFirst({
      where: {
        billingAccountId: args.billingAccountId,
        status: 'scheduled',
        periodStart: nextMonthStart,
      },
      orderBy: { createdAt: 'desc' },
      include: { toPlanVersion: true },
    });

    const targetPlan = scheduled?.toPlanVersion
      ? scheduled.toPlanVersion
      : await tx.billingPlanVersion.findUnique({
          where: { id: args.defaultTargetPlanVersionId },
        });
    if (!targetPlan) {
      throw new ConflictException('Subscription sync target plan version missing');
    }

    const fee = targetPlan.monthlyFeeMicros ?? 0n;
    const kind: BillingSubscriptionSyncKind =
      fee > 0n
        ? BillingSubscriptionSyncKind.update_item
        : BillingSubscriptionSyncKind.cancel_at_period_end;

    if (kind === BillingSubscriptionSyncKind.update_item) {
      if (fee % MICROS_PER_CENT !== 0n || fee > BigInt(Number.MAX_SAFE_INTEGER) * MICROS_PER_CENT) {
        throw new ConflictException('Subscription sync target fee is not Stripe-cent safe');
      }
    }

    // Only supersede never-dispatched pending work. in_flight/uncertain must
    // complete with the same frozen payload; newer revisions queue behind them.
    await tx.billingSubscriptionSyncIntent.updateMany({
      where: {
        billingAccountId: args.billingAccountId,
        status: BillingSubscriptionSyncStatus.pending,
        dispatchedAt: null,
      },
      data: { status: BillingSubscriptionSyncStatus.superseded },
    });

    const latest = await tx.billingSubscriptionSyncIntent.findFirst({
      where: { billingAccountId: args.billingAccountId },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    const revision = (latest?.revision ?? 0) + 1;
    const cents =
      kind === BillingSubscriptionSyncKind.update_item
        ? Number(fee / MICROS_PER_CENT)
        : null;

    // expected* = current provider validation window (mirror period or current
    // UTC month). effective* = next renewal interval this config applies to
    // (derived from current period end + UTC monthly boundaries) — e.g. a
    // September Starter→Growth sync validates against Aug–Sep provider bounds
    // but governs the October recurring charge identity.
    const expectedPeriodStart =
      account.stripeSubscriptionPeriodStart ??
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const expectedPeriodEnd =
      account.stripeSubscriptionPeriodEnd ??
      new Date(
        Date.UTC(
          expectedPeriodStart.getUTCFullYear(),
          expectedPeriodStart.getUTCMonth() + 1,
          1,
        ),
      );
    const effectivePeriodStart = new Date(
      Date.UTC(
        expectedPeriodEnd.getUTCFullYear(),
        expectedPeriodEnd.getUTCMonth(),
        1,
      ),
    );
    const effectivePeriodEnd = new Date(
      Date.UTC(
        effectivePeriodStart.getUTCFullYear(),
        effectivePeriodStart.getUTCMonth() + 1,
        1,
      ),
    );

    // Enqueue-time freeze of local intent facts. Item/product ids are filled
    // once after the first safe retrieve (before provider mutation) and never
    // re-derived from mutable Stripe state on retry.
    const frozenPayload = {
      kind,
      targetPlanVersionId: kind === BillingSubscriptionSyncKind.update_item ? targetPlan.id : null,
      targetUnitAmountCents: cents,
      targetCurrency: 'usd',
      expectedPeriodStart: expectedPeriodStart.toISOString(),
      expectedPeriodEnd: expectedPeriodEnd.toISOString(),
      effectivePeriodStart: effectivePeriodStart.toISOString(),
      effectivePeriodEnd: effectivePeriodEnd.toISOString(),
      stripeCustomerId: account.stripeCustomerId,
      stripeSubscriptionId: account.stripeSubscriptionId,
      stripeSubscriptionItemId: null as string | null,
      stripeProductId: null as string | null,
      interval: 'month',
      intervalCount: 1,
      quantity: 1,
      prorationBehavior: 'none',
      billingCycleAnchor: 'unchanged',
      cancelAtPeriodEnd: kind === BillingSubscriptionSyncKind.cancel_at_period_end,
    };
    const idempotencyKey = `sub-sync:${args.billingAccountId}:r${revision}:${kind}:${targetPlan.id}:${cents ?? 0}`;

    const created = await tx.billingSubscriptionSyncIntent.create({
      data: {
        billingAccountId: args.billingAccountId,
        revision,
        sourcePlanChangeId: args.sourcePlanChangeId,
        kind,
        status: BillingSubscriptionSyncStatus.pending,
        stripeCustomerId: account.stripeCustomerId,
        stripeSubscriptionId: account.stripeSubscriptionId,
        targetPlanVersionId:
          kind === BillingSubscriptionSyncKind.update_item ? targetPlan.id : null,
        targetUnitAmountCents: cents,
        targetCurrency: 'usd',
        expectedPeriodStart,
        expectedPeriodEnd,
        effectivePeriodStart,
        effectivePeriodEnd,
        frozenPayloadJson: frozenPayload as Prisma.InputJsonValue,
        operationIdempotencyKey: idempotencyKey,
        nextRetryAt: now,
      },
    });

    return { intentId: created.id, revision };
  }

  /** Best-effort immediate process after local TX commit (never throws to caller). */
  async processAccountBestEffort(billingAccountId: string): Promise<void> {
    try {
      if (!this.stripe) {
        // Config missing with outstanding work must not silently succeed.
        const outstanding = await this.prisma.billingSubscriptionSyncIntent.count({
          where: {
            billingAccountId,
            status: {
              in: [
                BillingSubscriptionSyncStatus.pending,
                BillingSubscriptionSyncStatus.in_flight,
              ],
            },
          },
        });
        if (outstanding > 0) {
          await this.prisma.billingSubscriptionSyncIntent.updateMany({
            where: {
              billingAccountId,
              status: BillingSubscriptionSyncStatus.pending,
            },
            data: {
              lastErrorCode: 'stripe_not_configured',
              lastErrorType: 'config',
              nextRetryAt: new Date(Date.now() + BACKOFF_MS),
            },
          });
        }
        return;
      }
      // Oldest unresolved revision first (same gate as processDue).
      const due = await this.prisma.billingSubscriptionSyncIntent.findMany({
        where: {
          billingAccountId,
          status: {
            in: [
              BillingSubscriptionSyncStatus.pending,
              BillingSubscriptionSyncStatus.in_flight,
            ],
          },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
        },
        orderBy: [{ revision: 'asc' }, { nextRetryAt: 'asc' }],
        take: 5,
      });
      for (const intent of due) {
        await this.processOne(intent, `best-effort-${billingAccountId.slice(0, 8)}`);
      }
    } catch (err) {
      this.logger.warn(
        `Subscription sync best-effort failed for account ${billingAccountId}: ${sanitizeErrorMessage(getErrorText(err))}`,
      );
    }
  }

  /** Worker entry: process due intents with lease/backoff. */
  async processDue(workerId: string, limit = BATCH): Promise<SyncProcessResult> {
    const outstanding = await this.prisma.billingSubscriptionSyncIntent.count({
      where: {
        status: {
          in: [
            BillingSubscriptionSyncStatus.pending,
            BillingSubscriptionSyncStatus.in_flight,
          ],
        },
      },
    });
    if (!this.stripe) {
      if (outstanding > 0) {
        await this.prisma.billingSubscriptionSyncIntent.updateMany({
          where: { status: BillingSubscriptionSyncStatus.pending },
          data: {
            lastErrorCode: 'stripe_not_configured',
            lastErrorType: 'config',
            nextRetryAt: new Date(Date.now() + BACKOFF_MS),
          },
        });
        return { attempted: outstanding, synced: 0, needsReview: 0, retryable: outstanding };
      }
      return { attempted: 0, synced: 0, needsReview: 0, retryable: 0 };
    }
    // Oldest revision first so queued newer pending never races ahead.
    const due = await this.prisma.billingSubscriptionSyncIntent.findMany({
      where: {
        status: {
          in: [
            BillingSubscriptionSyncStatus.pending,
            BillingSubscriptionSyncStatus.in_flight,
          ],
        },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: new Date() } },
          { leaseExpiresAt: { lt: new Date() } },
        ],
      },
      orderBy: [{ revision: 'asc' }, { nextRetryAt: 'asc' }],
      take: limit,
    });

    let synced = 0;
    let needsReview = 0;
    let retryable = 0;
    for (const intent of due) {
      const outcome = await this.processOne(intent, workerId);
      if (outcome === 'synced') synced += 1;
      else if (outcome === 'needs_review') needsReview += 1;
      else if (outcome === 'retryable') retryable += 1;
    }
    return { attempted: due.length, synced, needsReview, retryable };
  }

  private async processOne(
    seed: SyncIntent,
    workerId: string,
  ): Promise<'synced' | 'needs_review' | 'retryable' | 'skipped'> {
    const stripe = this.stripe;
    if (!stripe) return 'skipped';

    // Only the oldest unresolved revision may begin or continue a provider call.
    // Newer pending must wait until lower pending/in_flight reaches a terminal
    // status (synced / needs_review / superseded / failed).
    const olderUnresolved = await this.prisma.billingSubscriptionSyncIntent.findFirst({
      where: {
        billingAccountId: seed.billingAccountId,
        revision: { lt: seed.revision },
        status: {
          in: [
            BillingSubscriptionSyncStatus.pending,
            BillingSubscriptionSyncStatus.in_flight,
          ],
        },
      },
      select: { id: true, revision: true },
      orderBy: { revision: 'asc' },
    });
    if (olderUnresolved) return 'skipped';

    // Lease CAS — ownership only; never rewrite frozen payload / idempotency key.
    const leased = await this.prisma.billingSubscriptionSyncIntent.updateMany({
      where: {
        id: seed.id,
        status: {
          in: [
            BillingSubscriptionSyncStatus.pending,
            BillingSubscriptionSyncStatus.in_flight,
          ],
        },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: new Date() } },
          { leaseOwnerId: workerId },
        ],
      },
      data: {
        status: BillingSubscriptionSyncStatus.in_flight,
        leaseOwnerId: workerId,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        retryCount: { increment: 1 },
        // Mark dispatch only once; subsequent uncertain retries keep dispatchedAt.
        ...(seed.dispatchedAt == null ? { dispatchedAt: new Date() } : {}),
      },
    });
    if (leased.count !== 1) return 'skipped';

    const intent = await this.prisma.billingSubscriptionSyncIntent.findUnique({
      where: { id: seed.id },
    });
    if (!intent || intent.status !== BillingSubscriptionSyncStatus.in_flight) {
      return 'skipped';
    }
    if (!intent.frozenPayloadJson || !intent.operationIdempotencyKey) {
      await this.markNeedsReview(intent.id, workerId, 'missing_frozen_payload', 'validation');
      return 'needs_review';
    }

    // Serialize per account while processing (best-effort advisory).
    try {
      await this.prisma.$transaction(async (tx) => {
        await acquireBillingPeriodAdvisoryLock(
          tx,
          intent.billingAccountId,
          intent.expectedPeriodStart ?? new Date(0),
        );
      });
    } catch {
      // advisory lock best-effort; continue
    }

    try {
      const frozen = this.readFrozenPayload(intent.frozenPayloadJson);
      const frozenItemId =
        this.asNonEmptyString(frozen.stripeSubscriptionItemId) ??
        intent.stripeSubscriptionItemId;
      const frozenProductId = this.asNonEmptyString(frozen.stripeProductId);
      const frozenCents =
        typeof frozen.targetUnitAmountCents === 'number'
          ? frozen.targetUnitAmountCents
          : intent.targetUnitAmountCents;
      const frozenCurrency =
        this.asNonEmptyString(frozen.targetCurrency) ?? intent.targetCurrency;
      const frozenInterval =
        this.asNonEmptyString(frozen.interval) === 'month' ? 'month' : 'month';
      const frozenQty =
        typeof frozen.quantity === 'number' && frozen.quantity > 0
          ? frozen.quantity
          : 1;

      // Retrieve for shape/period validation only. Provider mutation facts come
      // from the frozen payload once item/product have been sealed.
      const sub = await stripe.subscriptions.retrieve(intent.stripeSubscriptionId, {
        expand: ['items.data.price'],
      });
      const validated = this.validateSubscriptionShape(
        { ...intent, stripeSubscriptionItemId: frozenItemId },
        sub,
      );
      if (!validated.ok) {
        await this.markNeedsReview(intent.id, workerId, validated.code, validated.type);
        return 'needs_review';
      }

      const itemId = frozenItemId ?? validated.itemId;
      let productId = frozenProductId;

      if (!productId && intent.kind === BillingSubscriptionSyncKind.update_item) {
        productId = this.extractProductId(sub, itemId);
        if (!productId) {
          await this.markNeedsReview(intent.id, workerId, 'product_missing', 'validation');
          return 'needs_review';
        }
      }

      // Seal item/product into frozen payload before first provider mutation.
      // Retries must reuse these facts (same idempotency key + payload).
      if (
        !frozenItemId ||
        (intent.kind === BillingSubscriptionSyncKind.update_item && !frozenProductId)
      ) {
        const sealed = {
          ...frozen,
          stripeSubscriptionItemId: itemId,
          stripeProductId:
            intent.kind === BillingSubscriptionSyncKind.update_item ? productId : null,
          targetUnitAmountCents: frozenCents,
          targetCurrency: frozenCurrency,
          interval: frozenInterval,
          intervalCount: 1,
          quantity: frozenQty,
        };
        const sealedOk = await this.prisma.billingSubscriptionSyncIntent.updateMany({
          where: {
            id: intent.id,
            status: BillingSubscriptionSyncStatus.in_flight,
            leaseOwnerId: workerId,
            operationIdempotencyKey: intent.operationIdempotencyKey,
          },
          data: {
            stripeSubscriptionItemId: itemId,
            frozenPayloadJson: sealed as Prisma.InputJsonValue,
          },
        });
        if (sealedOk.count !== 1) return 'skipped';
        // Use sealed facts for the provider call below.
        productId =
          intent.kind === BillingSubscriptionSyncKind.update_item ? productId : null;
      }

      let updated: Stripe.Subscription;
      if (intent.kind === BillingSubscriptionSyncKind.cancel_at_period_end) {
        updated = await stripe.subscriptions.update(
          intent.stripeSubscriptionId,
          { cancel_at_period_end: true },
          { idempotencyKey: intent.operationIdempotencyKey },
        );
      } else {
        const cents = frozenCents;
        if (cents == null || cents <= 0) {
          await this.markNeedsReview(intent.id, workerId, 'invalid_target_cents', 'validation');
          return 'needs_review';
        }
        if (!productId || !itemId) {
          await this.markNeedsReview(intent.id, workerId, 'frozen_provider_facts_missing', 'validation');
          return 'needs_review';
        }

        updated = await stripe.subscriptions.update(
          intent.stripeSubscriptionId,
          {
            proration_behavior: 'none',
            billing_cycle_anchor: 'unchanged',
            cancel_at_period_end: false,
            items: [
              {
                id: itemId,
                price_data: {
                  currency: frozenCurrency,
                  product: productId,
                  unit_amount: cents,
                  recurring: { interval: frozenInterval, interval_count: 1 },
                },
                quantity: frozenQty,
              },
            ],
          },
          { idempotencyKey: intent.operationIdempotencyKey },
        );
      }

      const post = this.validatePostMutation(
        {
          ...intent,
          stripeSubscriptionItemId: itemId,
          kind: intent.kind,
          targetUnitAmountCents: frozenCents,
          targetCurrency: frozenCurrency,
        },
        updated,
        itemId,
      );
      if (!post.ok) {
        await this.markNeedsReview(intent.id, workerId, post.code, post.type);
        return 'needs_review';
      }

      const priceId =
        updated.items.data[0]?.price && typeof updated.items.data[0].price !== 'string'
          ? updated.items.data[0].price.id
          : null;

      const completed = await this.prisma.billingSubscriptionSyncIntent.updateMany({
        where: {
          id: intent.id,
          status: BillingSubscriptionSyncStatus.in_flight,
          leaseOwnerId: workerId,
          revision: intent.revision,
          operationIdempotencyKey: intent.operationIdempotencyKey,
        },
        data: {
          status: BillingSubscriptionSyncStatus.synced,
          syncedAt: new Date(),
          syncedProviderPriceId: priceId,
          stripeSubscriptionItemId: itemId,
          leaseExpiresAt: null,
          nextRetryAt: null,
          lastErrorCode: null,
          lastErrorType: null,
        },
      });
      // Never claim synced if ownership/revision was lost.
      if (completed.count !== 1) {
        return 'skipped';
      }
      return 'synced';
    } catch (err) {
      const msg = sanitizeErrorMessage(getErrorText(err));
      this.logger.warn(`Subscription sync ${intent.id} failed: ${msg}`);
      if (intent.retryCount >= MAX_RETRIES) {
        await this.markNeedsReview(intent.id, workerId, 'retries_exhausted', 'provider');
        return 'needs_review';
      }
      // Provider timeout/uncertain: stay in_flight (dispatched) with the same
      // frozen payload + idempotency key so retries are exact and newer pending
      // cannot leapfrog.
      const backoff = Math.min(BACKOFF_MS * 2 ** Math.min(intent.retryCount, 6), 24 * 60 * 60 * 1000);
      await this.prisma.billingSubscriptionSyncIntent.updateMany({
        where: {
          id: intent.id,
          status: BillingSubscriptionSyncStatus.in_flight,
          leaseOwnerId: workerId,
        },
        data: {
          status: BillingSubscriptionSyncStatus.in_flight,
          nextRetryAt: new Date(Date.now() + backoff),
          leaseExpiresAt: null,
          lastErrorCode: 'provider_error',
          lastErrorType: 'uncertain',
        },
      });
      return 'retryable';
    }
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

  private extractProductId(sub: Stripe.Subscription, itemId: string): string | null {
    const existingItem = sub.items.data.find((i) => i.id === itemId) ?? sub.items.data[0];
    const existingPrice =
      existingItem?.price && typeof existingItem.price !== 'string'
        ? existingItem.price
        : null;
    if (!existingPrice) return null;
    if (typeof existingPrice.product === 'string') return existingPrice.product;
    if (existingPrice.product && typeof existingPrice.product !== 'string') {
      return (existingPrice.product as { id?: string }).id ?? null;
    }
    return null;
  }

  private async markNeedsReview(
    id: string,
    workerId: string,
    code: string,
    type: string,
  ): Promise<void> {
    await this.prisma.billingSubscriptionSyncIntent.updateMany({
      where: {
        id,
        OR: [
          { status: BillingSubscriptionSyncStatus.in_flight, leaseOwnerId: workerId },
          { status: BillingSubscriptionSyncStatus.pending },
        ],
      },
      data: {
        status: BillingSubscriptionSyncStatus.needs_review,
        lastErrorCode: code.slice(0, 80),
        lastErrorType: type.slice(0, 80),
        leaseExpiresAt: null,
        nextRetryAt: null,
      },
    });
  }

  /**
   * Fail-closed shape check: one USD monthly licensed item, qty 1, bound
   * customer/subscription, exact item period bounds, billing_cycle_anchor
   * aligned to expected period start, no trial/schedule/metered/pending_update.
   */
  private validateSubscriptionShape(
    intent: {
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripeSubscriptionItemId: string | null;
      expectedPeriodEnd: Date | null;
      expectedPeriodStart: Date | null;
    },
    sub: Stripe.Subscription,
  ): { ok: true; itemId: string } | { ok: false; code: string; type: string } {
    if (sub.id !== intent.stripeSubscriptionId) {
      return { ok: false, code: 'subscription_id_mismatch', type: 'validation' };
    }
    const customerId =
      typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
    if (!customerId || customerId !== intent.stripeCustomerId) {
      return { ok: false, code: 'customer_mismatch', type: 'validation' };
    }
    if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') {
      return { ok: false, code: 'subscription_incomplete', type: 'validation' };
    }
    const subExtras = sub as {
      schedule?: unknown;
      pending_update?: unknown;
      billing_cycle_anchor?: number;
    };
    if (subExtras.schedule) {
      return { ok: false, code: 'subscription_has_schedule', type: 'validation' };
    }
    if (subExtras.pending_update) {
      return { ok: false, code: 'subscription_pending_update', type: 'validation' };
    }
    if (sub.trial_end && sub.trial_end * 1000 > Date.now()) {
      return { ok: false, code: 'subscription_in_trial', type: 'validation' };
    }
    const items = sub.items?.data ?? [];
    if (items.length !== 1) {
      return { ok: false, code: 'unsupported_item_count', type: 'validation' };
    }
    const item = items[0];
    if (intent.stripeSubscriptionItemId && item.id !== intent.stripeSubscriptionItemId) {
      return { ok: false, code: 'item_id_mismatch', type: 'validation' };
    }
    if (item.quantity != null && item.quantity !== 1) {
      return { ok: false, code: 'unsupported_quantity', type: 'validation' };
    }
    const price = item.price;
    if (!price || typeof price === 'string') {
      return { ok: false, code: 'price_missing', type: 'validation' };
    }
    if (price.currency !== 'usd') {
      return { ok: false, code: 'currency_not_usd', type: 'validation' };
    }
    if (price.type === 'one_time') {
      return { ok: false, code: 'non_recurring_price', type: 'validation' };
    }
    if (price.recurring?.interval !== 'month') {
      return { ok: false, code: 'interval_not_month', type: 'validation' };
    }
    // Fail closed: missing interval_count is not treated as 1.
    const intervalCount = price.recurring?.interval_count;
    if (intervalCount !== 1) {
      return { ok: false, code: 'interval_count_not_1', type: 'validation' };
    }
    if (price.recurring?.usage_type === 'metered') {
      return { ok: false, code: 'metered_price', type: 'validation' };
    }
    // Basil API: period bounds live on subscription items — both required + exact.
    const itemBounds = item as {
      current_period_start?: number;
      current_period_end?: number;
    };
    const itemStart = itemBounds.current_period_start;
    const itemEnd = itemBounds.current_period_end;
    if (typeof itemStart !== 'number' || typeof itemEnd !== 'number') {
      return { ok: false, code: 'item_period_bounds_missing', type: 'validation' };
    }
    if (!intent.expectedPeriodStart || !intent.expectedPeriodEnd) {
      return { ok: false, code: 'expected_period_null', type: 'validation' };
    }
    if (itemStart * 1000 !== intent.expectedPeriodStart.getTime()) {
      return { ok: false, code: 'period_start_mismatch', type: 'validation' };
    }
    if (itemEnd * 1000 !== intent.expectedPeriodEnd.getTime()) {
      return { ok: false, code: 'period_end_mismatch', type: 'validation' };
    }
    // billing_cycle_anchor must equal expected period start (no mid-cycle reset).
    const anchor = subExtras.billing_cycle_anchor;
    if (typeof anchor !== 'number') {
      return { ok: false, code: 'billing_cycle_anchor_missing', type: 'validation' };
    }
    if (anchor * 1000 !== intent.expectedPeriodStart.getTime()) {
      return { ok: false, code: 'billing_cycle_anchor_mismatch', type: 'validation' };
    }
    return { ok: true, itemId: item.id };
  }

  /**
   * Post-provider-response checks against frozen mutation intent (item identity,
   * period bounds/anchor, amount/currency, cancellation flag).
   */
  private validatePostMutation(
    intent: {
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripeSubscriptionItemId: string | null;
      expectedPeriodEnd: Date | null;
      expectedPeriodStart: Date | null;
      kind: BillingSubscriptionSyncKind;
      targetUnitAmountCents: number | null;
      targetCurrency: string;
    },
    sub: Stripe.Subscription,
    expectedItemId: string,
  ): { ok: true } | { ok: false; code: string; type: string } {
    const shape = this.validateSubscriptionShape(
      { ...intent, stripeSubscriptionItemId: expectedItemId },
      sub,
    );
    if (!shape.ok) return shape;
    if (shape.itemId !== expectedItemId) {
      return { ok: false, code: 'response_item_id_mismatch', type: 'validation' };
    }

    const item = sub.items.data.find((i) => i.id === expectedItemId) ?? sub.items.data[0];
    const price = item?.price && typeof item.price !== 'string' ? item.price : null;
    if (!price) {
      return { ok: false, code: 'response_price_missing', type: 'validation' };
    }
    if (price.currency !== intent.targetCurrency) {
      return { ok: false, code: 'response_currency_mismatch', type: 'validation' };
    }
    if (price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1) {
      return { ok: false, code: 'response_interval_mismatch', type: 'validation' };
    }

    if (intent.kind === BillingSubscriptionSyncKind.update_item) {
      if (sub.cancel_at_period_end) {
        return { ok: false, code: 'response_unexpected_cancel_at_period_end', type: 'validation' };
      }
      if (price.unit_amount !== intent.targetUnitAmountCents) {
        return { ok: false, code: 'response_amount_mismatch', type: 'validation' };
      }
    } else if (!sub.cancel_at_period_end) {
      return { ok: false, code: 'cancel_at_period_end_not_set', type: 'validation' };
    }

    return { ok: true };
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalBillingJson } from './billing-json';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import {
  DEFAULT_API_OVERAGE_RATE_MICROS,
  DEFAULT_WALLET_OVERAGE_RATE_MICROS,
  PLANS,
  STANDARD_OUTBOUND_TIERS,
  calculateInvoiceTotals,
  type BillingPlanConfig,
  type PlanId,
} from './billing-calculator';
import { PLAN_CATALOG } from './billing-catalog';
import {
  formatUtcMonth,
  microsToDecimalUsd,
  parsePeriod,
  ppmToPercentString,
} from './billing.utils';
import { BillingQuotaExceededException } from './billing-quota.exception';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { acquireBillingPeriodAdvisoryLock } from './billing-period-lock';

// ── JSON-safe DTO shapes (no BigInt leaks) ────────────────────────────────────

export interface BillingPlanDto {
  id: string;
  name: string;
  description: string;
  basePrice: string;
  currency: string;
  billingPeriod: string;
  features: string[];
}

export interface GetPlansResult {
  currentPlanId: string;
  plans: BillingPlanDto[];
  /** Future scheduled plan (next assignment after the current UTC month), if any. */
  scheduledPlan?: {
    planCode: string;
    planName: string;
    effectivePeriod: string;
  };
}

export interface BillingTierBreakdownDto {
  tier: string;
  from: string;
  to: string;
  quantity: string;
  rate: string;
  cost: string;
}

export interface BillingSummaryDto {
  period: string;
  planId: string;
  planName: string;
  outboundVolume: string;
  outboundFreeAllowance: string;
  outboundOverage: string;
  apiCalls: string;
  apiCallsFreeAllowance: string;
  activeWallets: string;
  activeWalletsFreeAllowance: string;
  estimatedBaseCost: string;
  estimatedOverageCost: string;
  estimatedTotal: string;
  currency: string;
  overageRate: string;
  overageUnit: string;
  tierBreakdown: BillingTierBreakdownDto[];
}

export interface BillingInvoiceDto {
  id: string;
  period: string;
  status: string;
  amount: string;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  /** Immutable plan version that priced this invoice (null only for legacy rows). */
  planVersionId: string | null;
  pdfUrl: string | null;
}

export interface ListInvoicesResult {
  items: BillingInvoiceDto[];
  total: number;
  page: number;
  limit: number;
}

/** JSON-safe result of a self-service plan change. */
export interface AssignPlanResult {
  planCode: string;
  planName: string;
  /** YYYY-MM the new plan takes effect (always the next UTC month). */
  effectivePeriod: string;
  effectiveFrom: string;
  outcome: 'changed' | 'unchanged';
}

export interface RecordApiCallInput {
  userId: string;
  /** Server-assigned unique idempotency key. Never trust a client X-Request-Id. */
  sourceKey: string;
  requestId?: string;
  endpoint?: string;
  statusCode?: number;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface RecordOutboundInput {
  userId: string;
  /** Server-assigned unique idempotency key. */
  sourceKey: string;
  transactionId?: string;
  /** Non-negative microdollar amount. Caller guarantees receipt status = success. */
  amountUsdMicros: bigint;
  requestId?: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
  /** Reconciliation fence. Required for every receipt-backed event. */
  reconciliationRunId?: string;
  /** Immutable reconciliation run type included in the ownership fence. */
  reconciliationRunType?: string;
  /** Fencing owner for receipt-backed reconciliation writes. */
  reconciliationOwnerId?: string;
  /** Account fence supplied by the reconciliation worker. */
  reconciliationAccountId?: string;
  reconciliationPeriodStart?: Date;
  reconciliationPeriodEnd?: Date;
  reconciliationExpectedTransactionStatus?: string;
  reconciliationExpectedTxHash?: string;
  reconciliationExpectedChainId?: bigint;
  reconciliationExpectedWalletAddress?: string;
  reconciliationTransactionStatus?: 'confirmed' | 'quarantined';
  // ── Evidence-aware (receipt-confirmed) fields ─────────────────────────────
  // When `receipt` is present the row is written as `posted`/`quarantined` with
  // sourceType `openfort_receipt` and full evidence. When absent the row is the
  // legacy caller-supplied hook: explicitly `unverified` + `legacy_import` and
  // never treated as receipt-confirmed.
  status?: 'posted' | 'quarantined';
  periodStart?: Date;
  quantity?: bigint;
  chainId?: bigint;
  walletAddress?: string;
  assetId?: string | null;
  assetDecimals?: number | null;
  baseUnitAmount?: bigint | null;
  unitPriceMicros?: bigint | null;
  priceSource?: string | null;
  receipt?: ReceiptUsageEvidence;
}

/** Result of an outbound append: a fresh insert or an idempotent replay. */
export type RecordOutboundOutcome = { outcome: 'inserted' | 'replayed' };

/**
 * Evidence for a single receipt-confirmed outbound component (one Transfer log
 * or a native-withdrawal quarantine). All bigint-derived values are serialized
 * as strings so the payload is JSON-safe.
 */
export interface ReceiptUsageEvidence {
  txHash: string;
  /** Canonical receipt-component identity: tx hash + log index (or `:native`). */
  receiptRef: string;
  receiptLogIndex: number | null;
  receiptBlockNumber: bigint;
  receiptBlockHash: string;
  receiptBlockTimestamp: bigint;
  receiptStatus: string;
  /** JSON-safe receipt snapshot (no BigInt). */
  receiptData: Record<string, unknown>;
  reconciledAt: Date;
}

export type PlanVersion = Prisma.BillingPlanVersionGetPayload<Record<string, never>>;
type UsageEventRow = Prisma.BillingUsageEventGetPayload<Record<string, never>>;

/** A token contract address is exactly 20 bytes (40 hex chars) after 0x. */
const TOKEN_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly invoiceSettlement?: InvoiceSettlementService,
  ) {}

  /**
   * Shared billing-period lock seam (Phase 1E). Ensures the BillingAccount,
   * opens a Prisma interactive transaction at Serializable isolation, acquires
   * a PostgreSQL transaction-scoped advisory lock keyed deterministically by
   * billingAccountId + UTC periodStart, then invokes `work(tx, billingAccountId)`.
   *
   * The advisory lock serializes all writers for the same account+period, so
   * reconciliation evidence appends and invoice finalization cannot interleave.
   * The lock key is passed as a bound parameter (never interpolated SQL).
   * Phase 2 reconciliation-run creation will consume this same seam.
   */
  async withBillingPeriodLock<T>(
    userId: string,
    periodStart: Date,
    work: (tx: Prisma.TransactionClient, billingAccountId: string) => Promise<T>,
  ): Promise<T> {
    const account = await this.ensureAccount(userId);
    return this.prisma.$transaction(
      async (tx) => {
        await acquireBillingPeriodAdvisoryLock(tx, account.id, periodStart);
        return work(tx, account.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Retries a serialized transaction a small bounded number of times on Prisma
   * serialization/deadlock/write-conflict errors (P2034 / PostgreSQL 40001).
   * Each retry opens a fresh transaction, so no partial invoice/line state is
   * left behind. Business ConflictExceptions and unique-constraint P2002 are
   * never swallowed here.
   */
  private async withRetryOnSerialization<T>(work: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isSerializationError(err)) throw err;
      }
    }
  }

  /**
   * Ensures a due UTC period has an open local invoice. This is intentionally
   * separate from finalizeInvoice: materialization may create an invoice for a
   * period that has started, while finalization is only valid after period end
   * plus grace and risk checks. The shared period lock makes concurrent worker
   * invocations observe one account/period and one invoice.
   */
  async ensureOpenInvoiceForPeriod(userId: string, period?: string): Promise<BillingInvoiceDto> {
    await this.ensurePlanVersions();
    const { start, end } = parsePeriod(period);
    if (start > new Date()) {
      throw new ConflictException('Cannot materialize a future billing period');
    }

    return this.withRetryOnSerialization(() =>
      this.withBillingPeriodLock(userId, start, async (tx, billingAccountId) => {
        const existing = await tx.billingInvoice.findUnique({
          where: { billingAccountId_periodStart: { billingAccountId, periodStart: start } },
        });
        if (existing) return this.toInvoiceDto(existing);

        const planVersion = await this.resolvePlanVersion(billingAccountId, start, tx);
        // Custom/null or malformed plans fail closed; never emit a zero-priced
        // invoice for an Enterprise/custom plan.
        this.assertPlanFinalizable(planVersion);
        await this.upsertOpenInvoice(tx, billingAccountId, planVersion, start, end);

        const created = await tx.billingInvoice.findUnique({
          where: { billingAccountId_periodStart: { billingAccountId, periodStart: start } },
        });
        if (!created) throw new ConflictException('Open invoice creation was not persisted');
        return this.toInvoiceDto(created);
      }),
    );
  }

  // ── Plans ───────────────────────────────────────────────────────────────────

  /**
   * Returns the user's current plan id plus the full plan catalog. Ensures the
   * default Free account/assignment and initializes the plan catalog on first
   * access. Plan versions are only created when missing; used versions are
   * never updated.
   *
   * Current-plan semantics (Phase 2 Oracle gate): the current plan is only the
   * assignment effective at or before the current UTC month — a future
   * scheduled assignment never overrides it. If no current assignment exists, a
   * current-month Free assignment is created/returned rather than reusing a
   * future one. The future schedule is exposed separately as `scheduledPlan`.
   * Unknown/malformed persisted plans fail closed (never silently Free).
   */
  async getPlans(userId: string): Promise<GetPlansResult> {
    const account = await this.ensureAccount(userId);
    await this.ensurePlanVersions();
    const currentMonthStart = this.monthStart(new Date());

    const currentAssignment = await this.ensureDefaultAssignment(account.id);
    const currentPlan = currentAssignment.planVersion;
    validatePlanVersion(currentPlan);

    const futureAssignment = await this.prisma.billingPlanAssignment.findFirst({
      where: { billingAccountId: account.id, periodStart: { gt: currentMonthStart } },
      orderBy: { periodStart: 'asc' },
      include: { planVersion: true },
    });
    if (futureAssignment?.planVersion) {
      validatePlanVersion(futureAssignment.planVersion);
    }

    // The catalog listing is constrained to canonical plan codes: database
    // rows whose `code` is not an own key of the static PLANS whitelist (e.g.
    // stray claim-plan-<uuid>/test-plan-<uuid> rows left behind by interrupted
    // runs) are excluded at the query and never validated/exposed here.
    // Unknown/malformed assigned plans still fail closed via
    // validatePlanVersion on the assignment paths above.
    const versions = await this.prisma.billingPlanVersion.findMany({
      where: { code: { in: Object.keys(PLANS) } },
      // Newest version first per code so the listing below can keep exactly
      // one row per canonical plan code — matching assignPlan()'s
      // version-desc semantics instead of exposing stale v1 duplicates.
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
    });

    // One DTO per canonical plan code, always the latest version. The
    // code-asc/version-desc ordering guarantees the first row seen per code
    // is its newest version; a v1/v2 pair never produces duplicate ids.
    const seenCodes = new Set<string>();
    const plans: BillingPlanDto[] = [];
    for (const v of versions) {
      if (seenCodes.has(v.code)) continue;
      seenCodes.add(v.code);
      // Rows reaching here are canonical PLANS codes; a malformed known row
      // still fails closed before exposure (never silently filtered/safe).
      validatePlanVersion(v);
      plans.push(this.toPlanDto(v));
    }

    return {
      currentPlanId: currentPlan.code,
      plans,
      ...(futureAssignment?.planVersion
        ? {
            scheduledPlan: {
              planCode: futureAssignment.planVersion.code,
              planName: futureAssignment.planVersion.name,
              effectivePeriod: formatUtcMonth(futureAssignment.periodStart),
            },
          }
        : {}),
    };
  }

  /**
   * Self-service plan change (Phase 2A). The authenticated dashboard user picks
   * a plan code; it takes effect at the next UTC month (never prorated, never
   * client-supplied). The assignment uses the existing
   * `BillingPlanAssignment` unique `(billingAccountId, periodStart)`: the same
   * target plan is an idempotent no-op, and a different plan for the same
   * future period safely replaces the not-yet-effective assignment row. The
   * future period's `BillingInvoice` is created/updated as `open` (zero-usage
   * estimate matching the new assignment); finalized/needs_review/void invoices
   * are immutable and rejected. Enterprise/custom null terms cannot be
   * activated by self-service. No payment provider is involved — selecting a
   * paid plan does not imply payment.
   */
  async assignPlan(userId: string, planCode: string): Promise<AssignPlanResult> {
    // Static own-property whitelist validation BEFORE any DB read/write: an
    // unknown/empty/inherited-key request is a 4xx with zero DB calls.
    if (!isOwnPlanCode(planCode)) {
      throw new BadRequestException(`Unknown plan code: ${planCode}`);
    }

    await this.ensurePlanVersions();

    const planVersion = await this.prisma.billingPlanVersion.findFirst({
      where: { code: planCode },
      orderBy: { version: 'desc' },
    });
    if (!planVersion) {
      throw new BadRequestException(`Unknown plan code: ${planCode}`);
    }
    // Fail closed on malformed persisted terms (e.g. Enterprise with finite
    // fields); Enterprise custom/null terms cannot be activated by self-service.
    validatePlanVersion(planVersion);
    this.assertPlanFinalizable(planVersion);

    const now = new Date();
    const effectivePeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const effectivePeriodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));

    return this.withRetryOnSerialization(() =>
      this.withBillingPeriodLock(userId, effectivePeriodStart, async (tx, billingAccountId) => {
        // Immutable future invoice rejects the plan change before any write.
        const existingInvoice = await tx.billingInvoice.findUnique({
          where: {
            billingAccountId_periodStart: {
              billingAccountId,
              periodStart: effectivePeriodStart,
            },
          },
        });
        if (existingInvoice && existingInvoice.status !== 'open') {
          throw new ConflictException(
            'Cannot change plan: the future invoice is immutable (finalized/needs_review/void)',
          );
        }

        const existingAssignment = await tx.billingPlanAssignment.findUnique({
          where: {
            billingAccountId_periodStart: {
              billingAccountId,
              periodStart: effectivePeriodStart,
            },
          },
        });

        if (existingAssignment && existingAssignment.planVersionId === planVersion.id) {
          // Same target plan: idempotent no-op; keep the open invoice consistent.
          await this.upsertOpenInvoice(
            tx,
            billingAccountId,
            planVersion,
            effectivePeriodStart,
            effectivePeriodEnd,
          );
          return this.toAssignPlanResult(planVersion, effectivePeriodStart, 'unchanged');
        }

        if (existingAssignment) {
          // Replace the not-yet-effective assignment for the same future period.
          await tx.billingPlanAssignment.update({
            where: {
              billingAccountId_periodStart: {
                billingAccountId,
                periodStart: effectivePeriodStart,
              },
            },
            data: { planVersionId: planVersion.id },
          });
        } else {
          await tx.billingPlanAssignment.create({
            data: {
              billingAccountId,
              planVersionId: planVersion.id,
              periodStart: effectivePeriodStart,
            },
          });
        }

        await this.upsertOpenInvoice(
          tx,
          billingAccountId,
          planVersion,
          effectivePeriodStart,
          effectivePeriodEnd,
        );

        return this.toAssignPlanResult(planVersion, effectivePeriodStart, 'changed');
      }),
    );
  }

  /**
   * Creates or updates the future period's `open` invoice to match the new
   * assignment (zero-usage estimate, plan snapshot, and line items). Only
   * `open` invoices can be updated; finalized/needs_review/void are immutable
   * and rejected. Never creates a duplicate invoice.
   */
  private async upsertOpenInvoice(
    tx: Prisma.TransactionClient,
    billingAccountId: string,
    planVersion: PlanVersion,
    start: Date,
    end: Date,
  ): Promise<void> {
    const plan = planVersionToConfig(planVersion);
    const existing = await tx.billingInvoice.findUnique({
      where: { billingAccountId_periodStart: { billingAccountId, periodStart: start } },
    });
    if (existing) {
      if (existing.status !== 'open') {
        throw new ConflictException(
          'Cannot update invoice: only open invoices can be changed by a plan change',
        );
      }
      const data = this.buildOpenInvoiceData(planVersion, plan, start, end);
      await tx.billingInvoice.update({
        where: { id: existing.id },
        data: { ...data, status: 'open' },
      });
      await tx.billingInvoiceLine.deleteMany({ where: { invoiceId: existing.id } });
      const lines = this.buildInvoiceLines({
        invoiceId: existing.id,
        planVersion,
        plan,
        apiCalls: 0,
        activeWallets: 0,
        totals: this.zeroUsageTotals(planVersion, plan),
      });
      if (lines.length > 0) {
        await tx.billingInvoiceLine.createMany({ data: lines });
      }
      return;
    }

    const data = this.buildOpenInvoiceData(planVersion, plan, start, end);
    const created = await tx.billingInvoice.create({
      data: { ...data, billingAccountId, status: 'open' },
    });
    const lines = this.buildInvoiceLines({
      invoiceId: created.id,
      planVersion,
      plan,
      apiCalls: 0,
      activeWallets: 0,
      totals: this.zeroUsageTotals(planVersion, plan),
    });
    if (lines.length > 0) {
      await tx.billingInvoiceLine.createMany({ data: lines });
    }
  }

  /** Zero-usage invoice totals for an open invoice estimate. */
  private zeroUsageTotals(planVersion: PlanVersion, plan: BillingPlanConfig) {
    return calculateInvoiceTotals({
      plan,
      grossOutboundMicros: 0n,
      activeWallets: 0,
      apiCallsTotal: 0,
      apiOverageRateMicros: planVersion.apiOverageRateMicros,
      walletOverageRateMicros: planVersion.walletOverageRateMicros,
    });
  }

  /** JSON-safe open-invoice data (zero-usage estimate + plan snapshot). */
  private buildOpenInvoiceData(
    planVersion: PlanVersion,
    plan: BillingPlanConfig,
    start: Date,
    end: Date,
  ): Omit<Prisma.BillingInvoiceUncheckedCreateInput, 'billingAccountId'> {
    const totals = this.zeroUsageTotals(planVersion, plan);
    const snapshot = this.buildSnapshot({
      period: formatUtcMonth(start),
      planVersion,
      plan,
      outboundVolume: 0n,
      apiCalls: 0,
      activeWallets: 0,
      totals,
    });
    const snapshotHash = createHash('sha256').update(canonicalBillingJson(snapshot)).digest('hex');
    return {
      planVersionId: planVersion.id,
      periodStart: start,
      periodEnd: end,
      currency: 'USD',
      grossOutboundMicros: 0n,
      includedOutboundMicros: plan.includedOutboundMicros,
      billableOutboundMicros: 0n,
      apiCalls: 0n,
      includedApiCalls:
        plan.includedApiCallsPerMonth !== null ? BigInt(plan.includedApiCallsPerMonth) : null,
      activeWallets: 0,
      includedWallets: plan.includedWallets,
      monthlyFeeMicros: totals.monthlyFeeMicros,
      outboundOverageMicros: 0n,
      apiOverageMicros: 0n,
      walletOverageMicros: 0n,
      totalMicros: totals.totalMicros,
      snapshotJson: snapshot as Prisma.InputJsonValue,
      snapshotHash,
    };
  }

  private toAssignPlanResult(
    planVersion: PlanVersion,
    effectivePeriodStart: Date,
    outcome: 'changed' | 'unchanged',
  ): AssignPlanResult {
    return {
      planCode: planVersion.code,
      planName: planVersion.name,
      effectivePeriod: formatUtcMonth(effectivePeriodStart),
      effectiveFrom: effectivePeriodStart.toISOString(),
      outcome,
    };
  }

  // ── Usage recording ─────────────────────────────────────────────────────────

  /**
   * Legacy API-call meter seam (no quota check). Records a single API call
   * (metric = api_call, quantity = 1) as an explicitly `unverified` usage event
   * so it can never affect quota or invoice accounting. The authoritative,
   * quota-checked path is `assertAndRecordApiCall`, which writes
   * `status = posted`; only posted api_call rows are ever counted. Idempotent
   * on sourceKey: a duplicate sourceKey is silently ignored. The sourceKey must
   * be supplied by the server-side caller and is never derived from a client
   * X-Request-Id.
   */
  async recordApiCall(input: RecordApiCallInput): Promise<void> {
    const account = await this.ensureAccount(input.userId);
    const occurredAt = input.occurredAt ?? new Date();
    const periodStart = this.monthStart(occurredAt);
    try {
      await this.prisma.billingUsageEvent.create({
        data: {
          billingAccountId: account.id,
          metric: 'api_call',
          entryType: 'usage',
          sourceType: 'api_request',
          status: 'unverified',
          sourceKey: input.sourceKey,
          periodStart,
          occurredAt,
          quantity: 1n,
          volumeUsdMicros: 0n,
          requestId: input.requestId,
          endpoint: input.endpoint,
          statusCode: input.statusCode,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) return; // idempotent
      throw err;
    }
  }

  /**
   * Atomic API-call quota check-and-record (Phase 2B). Runs inside the shared
   * billing-period lock (Serializable + advisory lock) so N concurrent requests
   * can never exceed the included API-call limit. The period is the UTC
   * calendar month of the request. Only `metric=api_call AND entryType=usage
   * AND status=posted` events count; reversal/adjustment/non-usage rows and
   * unverified/quarantined api_call rows never consume quota.
   *
   * The plan in effect for the period is resolved first; Enterprise/custom null
   * terms fail closed (never treated as 0 or infinite). When the existing count
   * is >= the included limit, a `BillingQuotaExceededException` (HTTP 429) is
   * thrown and NO event is written. Otherwise a
   * `status=posted, entryType=usage, sourceType=api_request` event is written.
   * A serialization conflict retries with a fresh transaction (no double count).
   */
  async assertAndRecordApiCall(input: RecordApiCallInput): Promise<void> {
    await this.ensurePlanVersions();
    const occurredAt = input.occurredAt ?? new Date();
    const periodStart = this.monthStart(occurredAt);

    return this.withRetryOnSerialization(() =>
      this.withBillingPeriodLock(input.userId, periodStart, async (tx, billingAccountId) => {
        const planVersion = await this.resolvePlanVersion(billingAccountId, periodStart, tx);
        // Fail closed on unknown/malformed persisted plans (never 0/infinite).
        validatePlanVersion(planVersion);
        const includedApiCalls = planVersion.includedApiCalls;
        if (includedApiCalls === null) {
          // Enterprise/custom null terms fail closed — never 0 or infinite.
          throw new ServiceUnavailableException('Billing service unavailable');
        }
        // Keep the quota limit and the used count in bigint — never Number —
        // so counts above Number.MAX_SAFE_INTEGER are compared exactly.
        const limit = includedApiCalls;

        // Fetch and validate each included usage row before reduction: only
        // metric=api_call AND entryType=usage AND status=posted counts. The
        // explicit posted-status requirement keeps rows written by the legacy
        // recordApiCall seam (explicitly unverified) from consuming quota, and
        // a negative or non-bigint quantity fails closed instead of silently
        // reducing usage.
        const usageRows = await tx.billingUsageEvent.findMany({
          where: {
            billingAccountId,
            periodStart,
            metric: 'api_call',
            entryType: 'usage',
            status: 'posted',
          },
          select: { quantity: true },
        });
        let used = 0n;
        for (const row of usageRows) {
          if (typeof row.quantity !== 'bigint' || row.quantity < 0n) {
            throw new ConflictException('Usage quantity is invalid');
          }
          used += row.quantity;
        }

        if (used >= limit) {
          const periodEnd = new Date(
            Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
          );
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((periodEnd.getTime() - Date.now()) / 1000),
          );
          throw new BillingQuotaExceededException(
            'api_call',
            limit,
            formatUtcMonth(periodStart),
            retryAfterSeconds,
          );
        }

        await tx.billingUsageEvent.create({
          data: {
            billingAccountId,
            metric: 'api_call',
            entryType: 'usage',
            sourceType: 'api_request',
            status: 'posted',
            sourceKey: input.sourceKey,
            periodStart,
            occurredAt,
            quantity: 1n,
            volumeUsdMicros: 0n,
            requestId: input.requestId,
            endpoint: input.endpoint,
            statusCode: input.statusCode,
            metadata: input.metadata as Prisma.InputJsonValue | undefined,
          },
        });
      }),
    );
  }

  /**
   * Records an outbound transfer (metric = outbound_volume). Only accepts a
   * non-negative bigint amount; the caller must guarantee the receipt status is
   * success. Idempotent on sourceKey. Unsupported assets are never silently
   * converted to 0.
   *
   * Evidence-aware: when `input.receipt` is present the row is written as
   * `posted`/`quarantined` with sourceType `openfort_receipt` and full receipt
   * evidence in the dedicated columns (JSON-safe; BigInt is only used
   * internally / in Prisma). Both posted and quarantined rows reference the
   * Transaction to satisfy the outbound DB CHECK, and the Transaction is
   * verified to belong to `input.userId` with matching txHash/chainId/
   * walletAddress. `posted` requires a successful receipt; `quarantined`
   * requires zero volume.
   *
   * Non-receipt imports must use recordUnverifiedOutbound explicitly. This
   * method is intentionally receipt-only so an evidence-bearing call can never
   * fall through a partial/legacy fence branch.
   *
   * A unique-constraint conflict is only treated as an idempotent replay when
   * the existing row's canonical payload matches exactly; any divergence throws
   * ConflictException and never modifies the existing posted row.
   */
  async recordSuccessfulOutbound(input: RecordOutboundInput): Promise<RecordOutboundOutcome> {
    if (typeof input.amountUsdMicros !== 'bigint' || input.amountUsdMicros < 0n) {
      throw new BadRequestException('amountUsdMicros must be a non-negative bigint');
    }
    const occurredAt = input.occurredAt ?? new Date();
    // Receipt-backed reconciliation is accounted to its original worker target
    // period, never to a later receipt timestamp.
    const isReceiptConfirmed = input.receipt !== undefined;
    if (!isReceiptConfirmed) {
      throw new BadRequestException(
        'recordSuccessfulOutbound requires receipt evidence; use recordUnverifiedOutbound for imports',
      );
    }
    const periodStart = input.reconciliationPeriodStart ?? input.periodStart;
    if (!periodStart) throw new ConflictException('Complete reconciliation fence is required');

    // Receipt-backed appends serialize on the resolved accounting period so
    // reconciliation evidence cannot race invoice finalization. Validation,
    // ownership/evidence checks, and the append all run inside the locked
    // transaction; a serialization conflict retries with a fresh transaction.
    return this.withRetryOnSerialization(() =>
      this.withBillingPeriodLock(input.userId, periodStart, async (tx, billingAccountId) => {
        if (
          !input.reconciliationRunId ||
          !input.reconciliationRunType ||
          !input.reconciliationOwnerId ||
          !input.reconciliationAccountId ||
          !input.reconciliationPeriodStart ||
          !input.reconciliationPeriodEnd ||
          !input.reconciliationExpectedTransactionStatus ||
          !input.transactionId ||
          input.reconciliationExpectedTxHash === undefined ||
          input.reconciliationExpectedTxHash === null ||
          input.reconciliationExpectedChainId === undefined ||
          !input.reconciliationExpectedWalletAddress ||
          !isValidFenceDate(input.reconciliationPeriodStart) ||
          !isValidFenceDate(input.reconciliationPeriodEnd) ||
          input.reconciliationPeriodEnd.getTime() <= input.reconciliationPeriodStart.getTime() ||
          !['submitting', 'pending', 'unknown', 'confirmed'].includes(
            input.reconciliationExpectedTransactionStatus,
          ) ||
          input.reconciliationAccountId !== billingAccountId ||
          input.reconciliationPeriodStart.getTime() !== periodStart.getTime() ||
          !input.periodStart ||
          input.periodStart.getTime() !== periodStart.getTime()
        ) {
          throw new ConflictException('Incomplete reconciliation fence');
        }
        const ownerNow = new Date();
        const owned = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "billing_reconciliation_runs"
            WHERE "id" = ${input.reconciliationRunId}
              AND "worker_id" = ${input.reconciliationOwnerId}
              AND "billing_account_id" = ${billingAccountId}
              AND "account_user_id" = ${input.userId}
              AND "run_type" = ${input.reconciliationRunType}
              AND "period_start" = ${input.reconciliationPeriodStart}
              AND "period_end" = ${input.reconciliationPeriodEnd}
              AND "status" = 'running'
              AND "lease_expires_at" > ${ownerNow}
            FOR UPDATE`;
        if (owned.length === 0) throw new ConflictException('Reconciliation ownership lost');
        this.assertReceiptBackedInput(input);
        await this.assertTransactionOwnershipAndEvidence(input, tx);
        if (input.status === 'posted') {
          this.assertPostedPricingEvidence(input);
          this.assertPostedPeriod(input);
        }
        if (input.receipt?.receiptData !== undefined) {
          assertJsonSafe(input.receipt.receiptData, 'receiptData');
        }
        if (input.metadata !== undefined) {
          assertJsonSafe(input.metadata, 'metadata');
        }

        // Canonical lookup before the finalized barrier: an exact replay of
        // existing evidence is a no-op even for a finalized period (the row is
        // returned unchanged, never rewritten). A divergent existing row is a
        // conflict. Only genuinely new evidence is then subject to the
        // period-close barrier.
        const existing = await this.findExistingCanonical(input, billingAccountId, tx);
        if (existing) {
          return this.compareCanonicalPayload(input, existing);
        }

        // Period-close barrier (P0): a finalized invoice for this account+period
        // means late receipt evidence must be reviewed/adjusted, never appended.
        // Runs for both posted and quarantined appends, inside the same period
        // lock as finalizeInvoice, so the two concurrent directions are safe.
        await this.assertPeriodNotFinalized(tx, billingAccountId, periodStart);

        const status = input.status!;
        try {
          await tx.billingUsageEvent.create({
            data: {
              billingAccountId,
              metric: 'outbound_volume',
              entryType: 'usage',
              sourceType: 'openfort_receipt',
              status,
              sourceKey: input.sourceKey,
              periodStart,
              occurredAt,
              quantity: input.quantity ?? 1n,
              volumeUsdMicros: input.amountUsdMicros,
              baseUnitAmount: input.baseUnitAmount ?? null,
              assetId: input.assetId ?? null,
              assetDecimals: input.assetDecimals ?? null,
              unitPriceMicros: input.unitPriceMicros ?? null,
              priceSource: input.priceSource ?? null,
              chainId: input.chainId ?? null,
              walletAddress: input.walletAddress ?? null,
              txHash: input.receipt?.txHash ?? null,
              receiptRef: input.receipt?.receiptRef ?? null,
              receiptLogIndex: input.receipt?.receiptLogIndex ?? null,
              receiptBlockNumber: input.receipt?.receiptBlockNumber ?? null,
              receiptBlockHash: input.receipt?.receiptBlockHash ?? null,
              receiptBlockTimestamp: input.receipt?.receiptBlockTimestamp ?? null,
              receiptStatus: input.receipt?.receiptStatus ?? null,
              receiptData: input.receipt?.receiptData as Prisma.InputJsonValue | undefined,
              reconciledAt: input.receipt?.reconciledAt ?? null,
              reconciliationRunId: input.reconciliationRunId ?? null,
              transactionId: input.transactionId,
              requestId: input.requestId,
              metadata: input.metadata as Prisma.InputJsonValue | undefined,
            },
          });
          if (
            (input.reconciliationTransactionStatus === 'confirmed' ||
              input.reconciliationTransactionStatus === 'quarantined') &&
            input.transactionId &&
            input.reconciliationExpectedTransactionStatus
          ) {
            const changed = await tx.transaction.updateMany({
              where: {
                id: input.transactionId,
                userId: input.userId,
                status: input.reconciliationExpectedTransactionStatus,
                ...(input.reconciliationExpectedTxHash !== undefined
                  ? { txHash: input.reconciliationExpectedTxHash }
                  : {}),
                ...(input.reconciliationExpectedChainId !== undefined
                  ? { chainId: input.reconciliationExpectedChainId }
                  : {}),
                ...(input.reconciliationExpectedWalletAddress !== undefined
                  ? { walletAddress: input.reconciliationExpectedWalletAddress }
                  : {}),
              },
              data: {
                status:
                  input.reconciliationTransactionStatus === 'confirmed'
                    ? 'confirmed'
                    : 'needs_review',
                ...(input.reconciliationTransactionStatus === 'quarantined'
                  ? { failureReason: 'billing_reconciliation_quarantine' }
                  : {}),
                billingReconciledAt: new Date(),
              },
            });
            if (changed.count === 0) {
              throw new ConflictException(
                'Transaction state changed while posting billing evidence',
              );
            }
          }
          return { outcome: 'inserted' };
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            return this.resolveOutboundConflict(input, billingAccountId, tx);
          }
          throw err;
        }
      }),
    );
  }

  async recordUnverifiedOutbound(input: RecordOutboundInput): Promise<RecordOutboundOutcome> {
    if (input.receipt !== undefined) {
      throw new BadRequestException('Unverified outbound recording cannot accept receipt evidence');
    }
    if (typeof input.amountUsdMicros !== 'bigint' || input.amountUsdMicros < 0n) {
      throw new BadRequestException('amountUsdMicros must be a non-negative bigint');
    }
    const occurredAt = input.occurredAt ?? new Date();
    const periodStart = input.periodStart ?? this.monthStart(occurredAt);
    const account = await this.ensureAccount(input.userId);
    return this.recordLegacyOutbound(input, account.id, occurredAt, periodStart);
  }

  private async recordLegacyOutbound(
    input: RecordOutboundInput,
    billingAccountId: string,
    occurredAt: Date,
    periodStart: Date,
  ): Promise<RecordOutboundOutcome> {
    try {
      await this.prisma.billingUsageEvent.create({
        data: {
          billingAccountId,
          metric: 'outbound_volume',
          entryType: 'usage',
          sourceType: 'legacy_import',
          status: 'unverified',
          sourceKey: input.sourceKey,
          periodStart,
          occurredAt,
          quantity: 1n,
          volumeUsdMicros: input.amountUsdMicros,
          transactionId: input.transactionId,
          requestId: input.requestId,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });
      return { outcome: 'inserted' };
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Exact replay is idempotent; a divergent legacy payload is a conflict.
        return this.resolveOutboundConflict(input, billingAccountId);
      }
      throw err;
    }
  }

  private assertReceiptBackedInput(input: RecordOutboundInput): void {
    if (!input.transactionId) {
      throw new BadRequestException(
        'transactionId is required for receipt-confirmed outbound usage',
      );
    }
    if (!input.sourceKey) {
      throw new BadRequestException('sourceKey is required for receipt-confirmed outbound usage');
    }
    if (input.status !== 'posted' && input.status !== 'quarantined') {
      throw new BadRequestException(
        'status is required and must be posted or quarantined for receipt-confirmed outbound usage',
      );
    }
    const receipt = input.receipt!;
    if (!receipt.txHash || !receipt.receiptRef) {
      throw new BadRequestException(
        'receipt txHash and receiptRef are required for receipt-confirmed outbound usage',
      );
    }
    // Block evidence must be present (synthetic quarantines may carry empty
    // placeholders for chains that cannot be queried, but never undefined).
    if (
      receipt.receiptBlockNumber === undefined ||
      receipt.receiptBlockNumber === null ||
      receipt.receiptBlockHash === undefined ||
      receipt.receiptBlockHash === null ||
      receipt.receiptBlockTimestamp === undefined ||
      receipt.receiptBlockTimestamp === null ||
      receipt.receiptStatus === undefined ||
      receipt.receiptStatus === null ||
      receipt.receiptData === undefined ||
      receipt.receiptData === null ||
      receipt.reconciledAt === undefined ||
      receipt.reconciledAt === null
    ) {
      throw new BadRequestException(
        'receipt block evidence is incomplete for receipt-confirmed outbound usage',
      );
    }
    if (input.chainId === undefined || input.chainId === null) {
      throw new BadRequestException('chainId is required for receipt-confirmed outbound usage');
    }
    if (!input.walletAddress) {
      throw new BadRequestException(
        'walletAddress is required for receipt-confirmed outbound usage',
      );
    }
    if (input.status === 'posted' && receipt.receiptStatus !== 'success') {
      throw new ConflictException('posted outbound usage requires a successful receipt');
    }
    if (input.status === 'quarantined' && input.amountUsdMicros !== 0n) {
      throw new ConflictException('quarantined outbound usage must have zero volume');
    }
  }

  /**
   * Posted rows carry complete deterministic pricing evidence and the amount
   * must equal the billing-pricing half-up formula
   * `baseUnitAmount * unitPriceMicros / 10^assetDecimals` computed in BigInt
   * (never Number/float). Large amounts and zero/negative inputs are handled
   * exactly.
   */
  private assertPostedPricingEvidence(input: RecordOutboundInput): void {
    const { assetId, assetDecimals, baseUnitAmount, unitPriceMicros, priceSource } = input;
    if (typeof assetId !== 'string' || !TOKEN_ADDRESS_REGEX.test(assetId)) {
      throw new BadRequestException(
        'assetId must be a valid token address for posted outbound usage',
      );
    }
    if (
      typeof assetDecimals !== 'number' ||
      !Number.isSafeInteger(assetDecimals) ||
      assetDecimals < 0
    ) {
      throw new BadRequestException(
        'assetDecimals must be a non-negative safe integer for posted outbound usage',
      );
    }
    if (typeof baseUnitAmount !== 'bigint' || baseUnitAmount < 0n) {
      throw new BadRequestException(
        'baseUnitAmount must be a non-negative bigint for posted outbound usage',
      );
    }
    if (typeof unitPriceMicros !== 'bigint' || unitPriceMicros < 0n) {
      throw new BadRequestException(
        'unitPriceMicros must be a non-negative bigint for posted outbound usage',
      );
    }
    if (typeof priceSource !== 'string' || priceSource.length === 0) {
      throw new BadRequestException('priceSource is required for posted outbound usage');
    }
    const scale = 10n ** BigInt(assetDecimals);
    const expected = roundHalfUp(baseUnitAmount * unitPriceMicros, scale);
    if (input.amountUsdMicros !== expected) {
      throw new ConflictException(
        'amountUsdMicros does not match the deterministic pricing formula',
      );
    }
  }

  /**
   * Receipt timestamps describe when usage occurred. Reconciliation may
   * explicitly book that evidence to its worker target period, so the target
   * fence—not the receipt month—is authoritative for periodStart.
   */
  private assertPostedPeriod(input: RecordOutboundInput): void {
    const blockTimestamp = input.receipt!.receiptBlockTimestamp;
    if (typeof blockTimestamp !== 'bigint' || blockTimestamp < 0n) {
      throw new BadRequestException(
        'receiptBlockTimestamp must be a non-negative bigint for posted outbound usage',
      );
    }
    const blockDate = new Date(Number(blockTimestamp) * 1000);
    if (!Number.isFinite(blockDate.getTime())) {
      throw new BadRequestException(
        'receiptBlockTimestamp is not a valid date for posted outbound usage',
      );
    }
    const expectedMonthStart = new Date(
      Date.UTC(blockDate.getUTCFullYear(), blockDate.getUTCMonth(), 1),
    );
    const targetPeriod = input.reconciliationPeriodStart ?? expectedMonthStart;
    if (!input.periodStart || input.periodStart.getTime() !== targetPeriod.getTime()) {
      throw new ConflictException('periodStart must match the explicit accounting period');
    }
    if (input.reconciliationPeriodStart && input.reconciliationPeriodEnd) {
      const expectedEnd = new Date(
        Date.UTC(targetPeriod.getUTCFullYear(), targetPeriod.getUTCMonth() + 1, 1),
      );
      if (input.reconciliationPeriodEnd.getTime() !== expectedEnd.getTime()) {
        throw new ConflictException('reconciliation period must be a complete UTC month');
      }
    }
  }

  /**
   * Period-close barrier: a finalized invoice for this account+period rejects
   * any late receipt-backed append (posted or quarantined). The finalized
   * invoice is never modified; the caller (reconciliation) surfaces the
   * ConflictException as a conflict/review outcome.
   */
  private async assertPeriodNotFinalized(
    tx: Prisma.TransactionClient,
    billingAccountId: string,
    periodStart: Date,
  ): Promise<void> {
    const invoice = await tx.billingInvoice.findUnique({
      where: {
        billingAccountId_periodStart: { billingAccountId, periodStart },
      },
      select: { id: true, status: true },
    });
    if (invoice && invoice.status === 'finalized') {
      throw new ConflictException(
        'Cannot append receipt evidence: the billing period is already finalized',
      );
    }
  }

  private async assertTransactionOwnershipAndEvidence(
    input: RecordOutboundInput,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const transaction = await tx.transaction.findUnique({
      where: { id: input.transactionId! },
    });
    if (!transaction) {
      throw new BadRequestException('transaction not found for receipt-confirmed outbound usage');
    }
    // The transaction id is not an ownership proof on its own. Reject a row
    // resolved under another account user before comparing receipt evidence or
    // allowing the enclosing transaction to append accounting data.
    if (transaction.userId !== input.userId) {
      throw new ConflictException('transaction does not belong to the user');
    }
    if (
      !transaction.txHash ||
      transaction.txHash.toLowerCase() !== input.receipt!.txHash.toLowerCase()
    ) {
      throw new ConflictException('transaction txHash does not match the receipt');
    }
    if (transaction.chainId !== input.chainId!) {
      throw new ConflictException('transaction chainId does not match the receipt');
    }
    if (transaction.walletAddress.toLowerCase() !== input.walletAddress!.toLowerCase()) {
      throw new ConflictException('transaction walletAddress does not match the receipt');
    }
  }

  /**
   * Finds an existing canonical usage event for the same receipt component.
   * Lookup is by sourceKey first (globally unique); a sourceKey row belonging to
   * another billing account is a collision and is never treated as a replay.
   * Falls back to billingAccountId + receiptRef + receiptLogIndex for
   * receipt-backed input. Returns null when no existing row matches.
   */
  private async findExistingCanonical(
    input: RecordOutboundInput,
    billingAccountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<UsageEventRow | null> {
    const bySourceKey = await tx.billingUsageEvent.findUnique({
      where: { sourceKey: input.sourceKey },
    });
    if (bySourceKey) {
      if (bySourceKey.billingAccountId !== billingAccountId) {
        throw new ConflictException('Billing usage event sourceKey belongs to another account');
      }
      return bySourceKey;
    }
    if (input.receipt) {
      const byReceipt = await tx.billingUsageEvent.findFirst({
        where: {
          billingAccountId,
          receiptRef: input.receipt.receiptRef,
          receiptLogIndex: input.receipt.receiptLogIndex,
        },
      });
      if (byReceipt) return byReceipt;
    }
    return null;
  }

  private async resolveOutboundConflict(
    input: RecordOutboundInput,
    billingAccountId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<RecordOutboundOutcome> {
    const existing = await this.findExistingCanonical(input, billingAccountId, tx);
    if (!existing) {
      throw new ConflictException('Billing usage event conflicts with an existing row');
    }
    return this.compareCanonicalPayload(input, existing);
  }

  private compareCanonicalPayload(
    input: RecordOutboundInput,
    existing: UsageEventRow,
  ): RecordOutboundOutcome {
    const isReceiptConfirmed = input.receipt !== undefined;
    const expectedStatus = isReceiptConfirmed ? input.status! : 'unverified';
    // reconciliationRunId is provenance only and never part of the canonical
    // replay identity; the volatile per-processing reconciledAt is also not
    // compared. Same receipt/account/source/evidence replayed by a later run
    // must return { outcome: 'replayed' } without touching the original row.
    const matches =
      existing.metric === 'outbound_volume' &&
      existing.transactionId === (input.transactionId ?? null) &&
      existing.sourceKey === input.sourceKey &&
      existing.receiptRef === (input.receipt?.receiptRef ?? null) &&
      existing.receiptLogIndex === (input.receipt?.receiptLogIndex ?? null) &&
      existing.txHash === (input.receipt?.txHash ?? null) &&
      existing.chainId === (input.chainId ?? null) &&
      existing.walletAddress === (input.walletAddress ?? null) &&
      existing.receiptBlockNumber === (input.receipt?.receiptBlockNumber ?? null) &&
      existing.receiptBlockHash === (input.receipt?.receiptBlockHash ?? null) &&
      existing.receiptBlockTimestamp === (input.receipt?.receiptBlockTimestamp ?? null) &&
      existing.receiptStatus === (input.receipt?.receiptStatus ?? null) &&
      existing.status === expectedStatus &&
      existing.volumeUsdMicros === input.amountUsdMicros &&
      existing.assetId === (input.assetId ?? null) &&
      existing.assetDecimals === (input.assetDecimals ?? null) &&
      existing.baseUnitAmount === (input.baseUnitAmount ?? null) &&
      existing.unitPriceMicros === (input.unitPriceMicros ?? null) &&
      existing.priceSource === (input.priceSource ?? null);

    if (matches) return { outcome: 'replayed' };
    throw new ConflictException('Billing usage event conflicts with an existing row');
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  /**
   * Aggregates usage for a UTC month and computes the estimated bill using the
   * pure calculator. Period defaults to the current UTC month. Ensures the
   * default account, plan catalog, and default Free assignment on first access.
   * All amounts are returned as decimal USD strings; counts as integer strings.
   */
  async getSummary(userId: string, period?: string): Promise<BillingSummaryDto> {
    const account = await this.ensureAccount(userId);
    await this.ensurePlanVersions();
    await this.ensureDefaultAssignment(account.id);
    const { period: periodStr, start } = parsePeriod(period);

    const planVersion = await this.resolvePlanVersion(account.id, start);
    const plan = planVersionToConfig(planVersion);
    // Enterprise/custom null terms cannot be summarized as an executable plan.
    this.assertPlanFinalizable(planVersion);

    const [usageEvents, activeWallets] = await Promise.all([
      this.prisma.billingUsageEvent.findMany({
        where: {
          billingAccountId: account.id,
          periodStart: start,
        },
      }),
      this.prisma.userWallet.count({
        where: { userId, status: 'active', walletAddress: { not: null }, frozenAt: null },
      }),
    ]);

    let outboundVolume = 0n;
    let apiCalls = 0n;
    for (const ev of usageEvents) {
      if (ev.metric === 'outbound_volume') {
        // Only posted, usage-type outbound events count toward gross outbound.
        // unverified/legacy_import, quarantined, and reversed rows are excluded.
        if (ev.status === 'posted' && ev.entryType === 'usage') {
          outboundVolume += ev.volumeUsdMicros;
        }
      } else if (ev.metric === 'api_call') {
        // One API usage policy: only posted usage-type api_call events count
        // toward reported usage. Rows written by the legacy recordApiCall seam
        // (explicitly unverified) and quarantined/reversed rows are excluded;
        // reversal/adjustment/non-usage rows are excluded. A negative or
        // non-bigint quantity fails closed instead of reducing usage.
        if (ev.status === 'posted' && ev.entryType === 'usage') {
          if (typeof ev.quantity !== 'bigint' || ev.quantity < 0n) {
            throw new ConflictException('Usage quantity is invalid');
          }
          apiCalls += ev.quantity;
        }
      }
    }

    const totals = calculateInvoiceTotals({
      plan,
      grossOutboundMicros: outboundVolume,
      activeWallets,
      apiCallsTotal: toSafeCount(apiCalls),
      apiOverageRateMicros: planVersion.apiOverageRateMicros,
      walletOverageRateMicros: planVersion.walletOverageRateMicros,
    });

    return {
      period: periodStr,
      planId: planVersion.code,
      planName: planVersion.name,
      outboundVolume: microsToDecimalUsd(outboundVolume),
      outboundFreeAllowance: microsToDecimalUsd(plan.includedOutboundMicros ?? 0n),
      outboundOverage: microsToDecimalUsd(totals.outboundOverageMicros),
      apiCalls: String(apiCalls),
      apiCallsFreeAllowance: String(plan.includedApiCallsPerMonth ?? 0),
      activeWallets: String(activeWallets),
      activeWalletsFreeAllowance: String(plan.includedWallets ?? 0),
      estimatedBaseCost: microsToDecimalUsd(totals.monthlyFeeMicros),
      estimatedOverageCost: microsToDecimalUsd(
        totals.outboundOverageMicros + totals.apiOverageMicros + totals.walletOverageMicros,
      ),
      estimatedTotal: microsToDecimalUsd(totals.totalMicros),
      currency: 'USD',
      overageRate: ppmToPercentString(STANDARD_OUTBOUND_TIERS[0].ratePpm),
      overageUnit: 'outbound_volume',
      tierBreakdown: this.toTierBreakdown(totals.outboundTiers),
    };
  }

  // ── Invoices ────────────────────────────────────────────────────────────────

  /** Lists the user's account invoices, newest first, paginated (max 100/page). */
  async listInvoices(
    userId: string,
    opts: { page?: number; limit?: number },
  ): Promise<ListInvoicesResult> {
    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account) return { items: [], total: 0, page: 1, limit: 20 };

    const page = Math.max(opts.page ?? 1, 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

    const [invoices, total] = await Promise.all([
      this.prisma.billingInvoice.findMany({
        where: { billingAccountId: account.id },
        orderBy: { periodStart: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.billingInvoice.count({ where: { billingAccountId: account.id } }),
    ]);

    return { items: invoices.map((inv) => this.toInvoiceDto(inv)), total, page, limit };
  }

  /** Returns a single invoice owned by the user, or NotFound. */
  async getInvoice(userId: string, id: string): Promise<BillingInvoiceDto> {
    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Invoice not found');

    const invoice = await this.prisma.billingInvoice.findFirst({
      where: { id, billingAccountId: account.id },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    return this.toInvoiceDto(invoice);
  }

  /**
   * Service-internal: finalizes an immutable invoice for a UTC month. Aggregates
   * usage, computes totals via the calculator, and persists a BillingInvoice
   * with lines and a SHA-256 snapshot hash. If an invoice already exists for the
   * period (including a concurrent unique-conflict race), the existing invoice
   * is returned unchanged. Finalized history is never modified. Ensures the plan
   * catalog exists so the in-effect plan can be resolved on first access.
   *
   * Fail-closed guards (Phase 1E): a period can only be finalized after it has
   * ended plus a 24h UTC grace window; Enterprise custom/null plan terms are
   * rejected; quarantined outbound usage or unresolved reconciliation runs block
   * auto-finalize. These business exceptions are never swallowed by the
   * concurrent unique-conflict handler.
   */
  async finalizeInvoice(userId: string, period?: string): Promise<BillingInvoiceDto> {
    const account = await this.ensureAccount(userId);
    await this.ensurePlanVersions();
    const { period: periodStr, start, end } = parsePeriod(period);

    // Cheap pre-check (never relied on alone): finalized/needs_review/void
    // invoices are immutable and returned unchanged. An `open` invoice (created
    // by a self-service plan change) proceeds to finalization.
    const existing = await this.prisma.billingInvoice.findUnique({
      where: {
        billingAccountId_periodStart: { billingAccountId: account.id, periodStart: start },
      },
    });
    if (existing && existing.status !== 'open') return this.toInvoiceDto(existing);

    // Close/grace boundary: future/current unended periods and the 24h grace
    // window after UTC period end cannot be finalized.
    this.assertFinalizablePeriod(end);

    // The entire serialized finalization — re-check inside the lock, plan
    // resolution, Enterprise null-term check, risk checks, [start,end) usage
    // aggregation, active-wallet count, calculator snapshot, invoice create,
    // and invoice-line create — runs inside one Serializable advisory-locked
    // transaction. A serialization conflict retries with a fresh transaction
    // (no partial invoice/line state). Business ConflictExceptions and unique
    // P2002 are never swallowed by the retry loop.
    const finalized = await this.withRetryOnSerialization(() =>
      this.withBillingPeriodLock(userId, start, async (tx, billingAccountId) => {
        // Re-check inside the lock so a waiter returns the existing immutable
        // invoice. An `open` invoice proceeds to finalization.
        const lockedExisting = await tx.billingInvoice.findUnique({
          where: {
            billingAccountId_periodStart: { billingAccountId, periodStart: start },
          },
        });
        if (lockedExisting && lockedExisting.status !== 'open') {
          return this.toInvoiceDto(lockedExisting);
        }

        const planVersion = await this.resolvePlanVersion(billingAccountId, start, tx);
        const plan = planVersionToConfig(planVersion);

        // Enterprise custom/null terms fail closed — never convert null to 0.
        this.assertPlanFinalizable(planVersion);

        // Unresolved accounting risk (quarantined usage + reconciliation runs)
        // blocks auto-finalize, evaluated inside the locked transaction.
        await this.assertNoUnresolvedBillingRisk(tx, billingAccountId, start, end, userId);

        const [usageEvents, activeWallets] = await Promise.all([
          tx.billingUsageEvent.findMany({
            where: {
              billingAccountId,
              periodStart: start,
            },
          }),
          tx.userWallet.count({
            where: { userId, status: 'active', walletAddress: { not: null }, frozenAt: null },
          }),
        ]);

        let outboundVolume = 0n;
        let apiCalls = 0n;
        for (const ev of usageEvents) {
          if (ev.metric === 'outbound_volume') {
            // Only posted, usage-type outbound events count toward gross
            // outbound. unverified/legacy_import, quarantined, and reversed
            // rows are excluded.
            if (ev.status === 'posted' && ev.entryType === 'usage') {
              outboundVolume += ev.volumeUsdMicros;
            }
          } else if (ev.metric === 'api_call') {
            // One API usage policy: only posted usage-type api_call events are
            // billable/reported. Legacy recordApiCall rows (explicitly
            // unverified) and quarantined/reversed rows are excluded; a
            // negative or non-bigint quantity fails closed instead of reducing
            // usage.
            if (ev.status === 'posted' && ev.entryType === 'usage') {
              if (typeof ev.quantity !== 'bigint' || ev.quantity < 0n) {
                throw new ConflictException('Usage quantity is invalid');
              }
              apiCalls += ev.quantity;
            }
          }
        }
        const apiCallsSafe = toSafeCount(apiCalls);

        const totals = calculateInvoiceTotals({
          plan,
          grossOutboundMicros: outboundVolume,
          activeWallets,
          apiCallsTotal: apiCallsSafe,
          apiOverageRateMicros: planVersion.apiOverageRateMicros,
          walletOverageRateMicros: planVersion.walletOverageRateMicros,
        });

        const snapshot = this.buildSnapshot({
          period: periodStr,
          planVersion,
          plan,
          outboundVolume,
          apiCalls: apiCallsSafe,
          activeWallets,
          totals,
        });
        const snapshotHash = createHash('sha256')
          .update(canonicalBillingJson(snapshot))
          .digest('hex');

        try {
          if (lockedExisting) {
            // Update the pre-existing open invoice and replace its lines.
            const updated = await tx.billingInvoice.update({
              where: { id: lockedExisting.id },
              data: {
                planVersionId: planVersion.id,
                status: 'finalized',
                grossOutboundMicros: outboundVolume,
                includedOutboundMicros: plan.includedOutboundMicros,
                billableOutboundMicros: totals.billableOutboundMicros,
                apiCalls: BigInt(apiCalls),
                includedApiCalls:
                  plan.includedApiCallsPerMonth !== null
                    ? BigInt(plan.includedApiCallsPerMonth)
                    : null,
                activeWallets,
                includedWallets: plan.includedWallets,
                monthlyFeeMicros: totals.monthlyFeeMicros,
                outboundOverageMicros: totals.outboundOverageMicros,
                apiOverageMicros: totals.apiOverageMicros,
                walletOverageMicros: totals.walletOverageMicros,
                totalMicros: totals.totalMicros,
                snapshotJson: snapshot as Prisma.InputJsonValue,
                snapshotHash,
                finalizedAt: new Date(),
              },
            });
            await tx.billingInvoiceLine.deleteMany({ where: { invoiceId: lockedExisting.id } });
            const lines = this.buildInvoiceLines({
              invoiceId: lockedExisting.id,
              planVersion,
              plan,
              apiCalls: apiCallsSafe,
              activeWallets,
              totals,
            });
            if (lines.length > 0) {
              await tx.billingInvoiceLine.createMany({ data: lines });
            }
            return this.toInvoiceDto(updated);
          }

          const created = await tx.billingInvoice.create({
            data: {
              billingAccountId,
              planVersionId: planVersion.id,
              periodStart: start,
              periodEnd: end,
              status: 'finalized',
              currency: 'USD',
              grossOutboundMicros: outboundVolume,
              includedOutboundMicros: plan.includedOutboundMicros,
              billableOutboundMicros: totals.billableOutboundMicros,
              apiCalls: BigInt(apiCalls),
              includedApiCalls:
                plan.includedApiCallsPerMonth !== null
                  ? BigInt(plan.includedApiCallsPerMonth)
                  : null,
              activeWallets,
              includedWallets: plan.includedWallets,
              monthlyFeeMicros: totals.monthlyFeeMicros,
              outboundOverageMicros: totals.outboundOverageMicros,
              apiOverageMicros: totals.apiOverageMicros,
              walletOverageMicros: totals.walletOverageMicros,
              totalMicros: totals.totalMicros,
              snapshotJson: snapshot as Prisma.InputJsonValue,
              snapshotHash,
              finalizedAt: new Date(),
            },
          });
          const lines = this.buildInvoiceLines({
            invoiceId: created.id,
            planVersion,
            plan,
            apiCalls: apiCallsSafe,
            activeWallets,
            totals,
          });
          if (lines.length > 0) {
            await tx.billingInvoiceLine.createMany({ data: lines });
          }
          return this.toInvoiceDto(created);
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            const again = await tx.billingInvoice.findUnique({
              where: {
                billingAccountId_periodStart: { billingAccountId, periodStart: start },
              },
            });
            if (again) return this.toInvoiceDto(again);
          }
          throw err;
        }
      }),
    );
    // Settlement locks attempt -> invoice. Run this after the invoice
    // finalization transaction commits so it cannot invert that lock order.
    if (this.invoiceSettlement) {
      await this.settleFinalizedRenewalPostCommit(finalized.id);
    }
    return finalized;
  }

  /**
   * A Stripe renewal can be confirmed before its local open invoice reaches
   * finalization. Once finalization has frozen the exact amount, give the
   * shared allocation boundary one catch-up opportunity: the fixed-fee attempt
   * allocates its coverage toward the frozen total (partial when the invoice
   * carries dynamic overage, full when it does not). A legitimate partial
   * allocation is a success, not a `fixed_fee_partial_balance` review: the
   * separately-payable overage remainder is collected by the overage worker.
   */
  private async settleFinalizedRenewalPostCommit(invoiceId: string): Promise<void> {
    if (!this.invoiceSettlement) return;
    await this.prisma.$transaction(async (tx) => {
      const attempts = await tx.billingPaymentAttempt.findMany({
        where: { invoiceId, method: 'stripe', status: 'succeeded', stripeChargeKind: 'fixed_fee' },
        orderBy: { createdAt: 'asc' },
      });
      for (const attempt of attempts) {
        const result = await this.invoiceSettlement!.settleInvoice(tx, {
          id: attempt.id,
          invoiceId,
          method: 'stripe',
        });
        if (result.allocated || result.replayed) continue;
        // No new coverage: either the invoice was already paid by another
        // rail (record the unallocated success for review) or the attempt
        // failed its preconditions. Never fabricate a settlement.
        const invoice = await tx.billingInvoice.findUnique({
          where: { id: invoiceId },
          select: {
            status: true,
            paidAt: true,
            totalMicros: true,
            currency: true,
            settlementAttemptId: true,
          },
        });
        if (invoice?.settlementAttemptId === attempt.id) continue;
        const differentWinner = Boolean(
          invoice?.settlementAttemptId && invoice.settlementAttemptId !== attempt.id,
        );
        if (!differentWinner) continue;
        await tx.billingPaymentAttempt.updateMany({
          where: { id: attempt.id, status: 'succeeded' },
          data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
        });
      }
    });
  }

  /**
   * Bounded catch-up for a finalized invoice whose post-commit fixed-fee
   * allocation never ran or failed (e.g. a transient DB error after the
   * finalize transaction committed). The worker calls this for every finalized
   * unpaid invoice that still has a succeeded fixed-fee attempt with
   * `allocatedAt IS NULL`, so the fixed-fee coverage is eventually recorded and
   * the overage worker can then collect the remainder. Idempotent and safe to
   * re-run every tick: already-allocated attempts are replays.
   */
  async recoverRenewalAllocation(invoiceId: string): Promise<void> {
    if (!this.invoiceSettlement) return;
    await this.settleFinalizedRenewalPostCommit(invoiceId);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Close/grace boundary: a UTC period can only be finalized after it has ended
   * AND at least 24 hours of grace have passed since the UTC period end
   * (`end` is the exclusive first instant of the following month). Future and
   * current unended periods are rejected. Deterministic; no external
   * payment/cron/config is involved.
   */
  private assertFinalizablePeriod(end: Date): void {
    const graceEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    if (new Date().getTime() < graceEnd.getTime()) {
      throw new ConflictException(
        'Cannot finalize invoice: period has not ended or is within the 24h grace window',
      );
    }
  }

  /**
   * Enterprise custom/null plan terms fail closed: any null monthly fee,
   * included outbound, included wallets, or included API calls cannot be
   * silently treated as zero and turned into a finalized invoice. Existing
   * finalized history remains immutable.
   */
  private assertPlanFinalizable(planVersion: PlanVersion): void {
    if (
      planVersion.monthlyFeeMicros === null ||
      planVersion.includedOutboundMicros === null ||
      planVersion.includedWallets === null ||
      planVersion.includedApiCalls === null
    ) {
      throw new ConflictException(
        'Cannot finalize invoice: plan has Enterprise custom/null terms requiring review',
      );
    }
  }

  /**
   * Unresolved accounting risk blocks auto-finalize, evaluated inside the
   * locked transaction:
   * 1. Any quarantined outbound usage in the accounting period requires review.
   * 2. Reconciliation runs that wrote usage for this account in the period,
   *    plus operational runs in the target month, must be clean. A run is
   *    unresolved when it is running/failed, or its summary has errors,
   *    conflicts, notFound, or transientError > 0, or it lacks the exhaustive
   *    `complete: true` completion marker. replayed/casNoops are not errors.
   *
   * Completion-marker semantics: the next reconciliation lane writes
   * `summary.userId`, `summary.complete` (candidate scan exhausted), and an
   * optional `summary.highWaterMark`. The newest relevant run for this user
   * decides: a later clean exhaustive run supersedes earlier retryable
   * failures. Legacy summaries without `userId` are conservatively treated as
   * global. BillingReconciliationRun has no billingAccountId, so the
   * operational-run check is intentionally conservative (global for the target
   * month) rather than pretending a user scope the schema cannot express.
   */
  private async assertNoUnresolvedBillingRisk(
    tx: Prisma.TransactionClient,
    accountId: string,
    start: Date,
    end: Date,
    userId: string,
  ): Promise<void> {
    const quarantined = await tx.billingUsageEvent.findFirst({
      where: {
        billingAccountId: accountId,
        periodStart: start,
        metric: 'outbound_volume',
        entryType: 'usage',
        status: 'quarantined',
      },
      select: { id: true },
    });
    if (quarantined) {
      throw new ConflictException(
        'Cannot finalize invoice: quarantined outbound usage requires review',
      );
    }

    const associated = await tx.billingUsageEvent.findMany({
      where: {
        billingAccountId: accountId,
        periodStart: start,
        reconciliationRunId: { not: null },
      },
      select: { reconciliationRunId: true },
      distinct: ['reconciliationRunId'],
    });
    const runIds = associated
      .map((e) => e.reconciliationRunId)
      .filter((id): id is string => id !== null);

    const candidateRuns = await tx.billingReconciliationRun.findMany({
      where: {
        OR: [
          // Runs linked to this account's usage events in the target period are
          // always relevant.
          { id: { in: runIds } },
          // Broad discovery of operational runs for the matching account that
          // could affect the target cutoff: a run with operational scan month
          // >= target month could have written usage for the target (receipts
          // mined at or before the scan). accountUserId is deliberately NOT
          // filtered here — a contradictory user scope must still reach the
          // TypeScript relevance/risk fence, which conservatively retains it.
          // Missing/legacy/malformed coverage is never SQL-filtered into
          // fail-open.
          { billingAccountId: accountId, periodStart: { lte: end }, periodEnd: { gte: start } },
          // An account-scoped row with incomplete period/identity is still
          // relevant and must be evaluated conservatively; SQL must not hide
          // nullable periodEnd rows before the TypeScript risk fence sees them.
          { billingAccountId: accountId, periodEnd: null },
          { billingAccountId: accountId, accountUserId: null },
          { billingAccountId: null, accountUserId: userId },
          // Legacy/unprovable rows remain globally conservative.
          { billingAccountId: null, accountUserId: null },
        ],
      },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        status: true,
        completedAt: true,
        summary: true,
        billingAccountId: true,
        accountUserId: true,
        runType: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    // Newest-first: pick the first run relevant to this user AND this target
    // accounting period. Usage-linked runs are always relevant; unlinked runs
    // are scoped by userId and validated accountingPeriods coverage, with
    // missing/legacy/malformed coverage or unresolved risk kept conservatively
    // relevant (never SQL-filtered into fail-open).
    const relevantRuns = candidateRuns.filter((run) =>
      this.isRunRelevantToPeriod(run, start, end, userId, accountId, runIds),
    );

    const newestRelevantRun = [...relevantRuns].sort((a, b) => {
      const aTime = a.startedAt?.getTime() ?? 0;
      const bTime = b.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    })[0];
    if (
      newestRelevantRun &&
      isRiskyReconciliationRun(newestRelevantRun, end, {
        accountId,
        userId,
        runType: 'receipt_outbound',
        periodStart: start,
        periodEnd: end,
      })
    ) {
      throw new ConflictException(
        'Cannot finalize invoice: reconciliation has unresolved errors or conflicts',
      );
    }

    // No-run / fresh-work barrier: a period with outbound transaction work that
    // no reconciliation run has proven exhausted (submitting/pending/unknown
    // rows, or confirmed rows that are unresolved) must not be closed. A
    // confirmed row is unresolved when it lacks the durable
    // `billingReconciledAt` marker OR has a NULL `txHash` — the NULL-hash
    // branch applies REGARDLESS of the marker, because a confirmed transaction
    // without a hash can never be reconciled and must never be silently
    // finalized even if a marker was (incorrectly) set. A clean run covers only
    // what it scanned, and rows created after the last run would otherwise
    // close without their usage ever reaching the ledger. The worker always
    // reconciles a period before finalizing it, so this is the closure proof,
    // not the scheduling driver.
    const [unresolvedPending, unresolvedConfirmed] = await Promise.all([
      tx.transaction.count({
        where: {
          userId,
          operationType: { in: ['send', 'withdraw'] },
          status: { in: ['submitting', 'pending', 'unknown'] },
          // Typed membership is authoritative. A NULL membership is retained
          // as unresolved for this account so it blocks closure conservatively,
          // but a transaction assigned to another period cannot block this one.
          OR: [{ billingPeriodStart: start }, { billingPeriodStart: null }],
        },
      }),
      tx.transaction.count({
        where: {
          userId,
          operationType: { in: ['send', 'withdraw'] },
          status: 'confirmed',
          OR: [{ txHash: null }, { billingReconciledAt: null }],
          AND: [{ OR: [{ billingPeriodStart: start }, { billingPeriodStart: null }] }],
        },
      }),
    ]);
    if (unresolvedPending + unresolvedConfirmed > 0) {
      throw new ConflictException(
        'Cannot finalize invoice: unresolved outbound transactions require reconciliation',
      );
    }
  }

  /**
   * Period-relevance selection for a candidate run. Usage-linked target runs
   * (run id from the target period's BillingUsageEvent.reconciliationRunId) are
   * always relevant — the association is stronger than summary user metadata.
   *
   * For unlinked operational runs: an explicit different summary.userId is
   * skipped; missing userId is treated as global. A run that is not a clean
   * exhaustive completion marker (running/failed/incomplete or any unresolved
   * notFound/transient/errors/conflicts) has receipt uncertainty and cannot be
   * scoped by createdAt-derived coverage — it is conservatively relevant. A
   * clean run is relevant only when its accountingPeriods is a valid canonical
   * UTC month-start array that includes the target month; missing/legacy/
   * malformed coverage is conservatively relevant (and isRiskyReconciliationRun
   * then blocks). createdAt is never treated as proof of the receipt accounting
   * period.
   */
  private isRunRelevantToPeriod(
    run: {
      id: string;
      status: string;
      summary: unknown;
      billingAccountId?: string | null;
      accountUserId?: string | null;
      runType?: string;
      periodStart?: Date;
      periodEnd?: Date | null;
    },
    start: Date,
    end: Date,
    userId: string,
    accountId: string,
    runIds: string[],
  ): boolean {
    // A usage event is explicit provenance. A linked run remains relevant even
    // when stored account/user metadata conflicts; otherwise stale metadata
    // could hide a run that already touched this invoice. The full identity
    // fence in isRiskyReconciliationRun below still blocks such a run.
    if (runIds.includes(run.id)) return true;
    // The remaining identity checks apply only to unlinked operational runs.
    // Nullable identity is legacy/unprovable, never a global clean run.
    if (run.billingAccountId !== undefined && run.billingAccountId !== null) {
      if (run.billingAccountId !== accountId) return false;
    } else if (
      run.accountUserId !== undefined &&
      run.accountUserId !== null &&
      run.accountUserId !== userId
    ) {
      return false;
    }
    const summary = (run.summary ?? {}) as Record<string, unknown>;
    // Missing run identity is legacy/unprovable and must remain risky. Linked
    // runs returned above are also rejected by the full risk fence when their
    // account/user/type/period identity cannot be proven.
    if (run.billingAccountId === undefined || run.accountUserId === undefined) return true;
    if (run.runType === undefined || run.runType !== 'receipt_outbound') return true;
    if (run.periodStart !== undefined && run.periodStart.getTime() !== start.getTime()) return true;
    if (
      run.periodEnd !== undefined &&
      run.periodEnd !== null &&
      run.periodEnd.getTime() !== end.getTime()
    )
      return true;
    if (run.periodStart === undefined || run.periodEnd === undefined || run.periodEnd === null)
      return true;
    const runUserId = summary.userId;
    if (typeof runUserId === 'string' && runUserId !== userId) return true;
    if (summary.complete !== true) return true;
    if (hasUnresolvedRunRisk(run)) return true;
    const accountingPeriods = summary.accountingPeriods;
    if (!isValidAccountingPeriods(accountingPeriods)) return true;
    return (accountingPeriods as string[]).includes(start.toISOString());
  }

  private async ensureAccount(
    userId: string,
  ): Promise<Prisma.BillingAccountGetPayload<Record<string, never>>> {
    const existing = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (existing) return existing;
    try {
      return await this.prisma.billingAccount.create({ data: { userId } });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const again = await this.prisma.billingAccount.findUnique({ where: { userId } });
        if (again) return again;
      }
      throw err;
    }
  }

  /**
   * Initializes plan versions + tiers from the calculator only when missing.
   * Tolerates a concurrent initialization race: if another request creates the
   * same version between our findFirst and create (unique P2002), the existing
   * version is re-fetched and reused. Used versions are never updated.
   */
  private async ensurePlanVersions(): Promise<void> {
    for (const plan of Object.values(PLANS)) {
      const existing = await this.prisma.billingPlanVersion.findFirst({
        where: { code: plan.id },
        orderBy: { version: 'desc' },
      });
      if (existing) continue; // only create missing; never update used versions

      let lower = 0n;
      const tierData = STANDARD_OUTBOUND_TIERS.map((t) => {
        const data = {
          lowerBoundMicros: lower,
          upperBoundMicros: t.upperBoundMicros,
          ratePpm: t.ratePpm,
        };
        if (t.upperBoundMicros !== null) lower = t.upperBoundMicros;
        return data;
      });

      try {
        await this.prisma.billingPlanVersion.create({
          data: {
            code: plan.id,
            version: 1,
            name: plan.name,
            description: PLAN_CATALOG[plan.id].description,
            monthlyFeeMicros: plan.monthlyFeeMicros,
            includedOutboundMicros: plan.includedOutboundMicros,
            includedApiCalls:
              plan.includedApiCallsPerMonth !== null ? BigInt(plan.includedApiCallsPerMonth) : null,
            includedWallets: plan.includedWallets,
            includedTeamMembers: null,
            // API calls are a hard quota (HTTP 429 at the limit, never billed
            // as overage), so new plan versions seed the retained
            // apiOverageRateMicros column at the 0n default; existing used
            // versions are never rewritten. Wallet overage keeps its default.
            apiOverageRateMicros: DEFAULT_API_OVERAGE_RATE_MICROS,
            walletOverageRateMicros: DEFAULT_WALLET_OVERAGE_RATE_MICROS,
            effectiveFrom: new Date(),
            tiers: { create: tierData },
          },
        });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        // Concurrent catalog initialization: another request created this version.
        const again = await this.prisma.billingPlanVersion.findFirst({
          where: { code: plan.id },
          orderBy: { version: 'desc' },
        });
        if (again) continue;
        throw err;
      }
    }
  }

  /**
   * Ensures the account has a default Free assignment for the current UTC
   * month. Only assignments effective at or before the current month are
   * considered — a future scheduled assignment never satisfies this. Returns
   * the assignment with its plan version included.
   */
  private async ensureDefaultAssignment(
    accountId: string,
  ): Promise<Prisma.BillingPlanAssignmentGetPayload<{ include: { planVersion: true } }>> {
    const currentMonthStart = this.monthStart(new Date());
    const existing = await this.prisma.billingPlanAssignment.findFirst({
      where: { billingAccountId: accountId, periodStart: { lte: currentMonthStart } },
      orderBy: { periodStart: 'desc' },
      include: { planVersion: true },
    });
    if (existing) return existing;

    const freePlan = await this.prisma.billingPlanVersion.findFirst({
      where: { code: 'free' },
      orderBy: { version: 'desc' },
    });
    if (!freePlan) throw new Error('Free plan not initialized');

    try {
      return await this.prisma.billingPlanAssignment.create({
        data: {
          billingAccountId: accountId,
          planVersionId: freePlan.id,
          periodStart: currentMonthStart,
        },
        include: { planVersion: true },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const again = await this.prisma.billingPlanAssignment.findFirst({
          where: { billingAccountId: accountId, periodStart: { lte: currentMonthStart } },
          orderBy: { periodStart: 'desc' },
          include: { planVersion: true },
        });
        if (again) return again;
      }
      throw err;
    }
  }

  /** Resolves the plan version in effect at `start`, falling back to Free. */
  private async resolvePlanVersion(
    accountId: string,
    start: Date,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PlanVersion> {
    const assignment = await tx.billingPlanAssignment.findFirst({
      where: { billingAccountId: accountId, periodStart: { lte: start } },
      orderBy: { periodStart: 'desc' },
      include: { planVersion: true },
    });
    if (assignment) return assignment.planVersion;
    const freePlan = await tx.billingPlanVersion.findFirst({
      where: { code: 'free' },
      orderBy: { version: 'desc' },
    });
    if (!freePlan) throw new Error('Free plan not initialized');
    return freePlan;
  }

  private toPlanDto(v: PlanVersion): BillingPlanDto {
    const catalog = PLAN_CATALOG[v.code as PlanId] ?? { description: '', features: [] };
    return {
      id: v.code,
      name: v.name,
      description: catalog.description,
      basePrice: v.monthlyFeeMicros === null ? 'Custom' : microsToDecimalUsd(v.monthlyFeeMicros),
      currency: 'USD',
      billingPeriod: 'Monthly',
      features: [...catalog.features],
    };
  }

  private toTierBreakdown(
    tiers: readonly {
      upperBoundMicros: bigint | null;
      ratePpm: number;
      volumeMicros: bigint;
      feeMicros: bigint;
    }[],
  ): BillingTierBreakdownDto[] {
    let prevUpper = 0n;
    return tiers.map((t, i) => {
      const from = prevUpper;
      const to = t.upperBoundMicros;
      prevUpper = t.upperBoundMicros ?? prevUpper;
      return {
        tier: `Tier ${i + 1}`,
        from: microsToDecimalUsd(from),
        to: to === null ? '∞' : microsToDecimalUsd(to),
        quantity: microsToDecimalUsd(t.volumeMicros),
        rate: ppmToPercentString(t.ratePpm),
        cost: microsToDecimalUsd(t.feeMicros),
      };
    });
  }

  private toInvoiceDto(
    inv: Prisma.BillingInvoiceGetPayload<Record<string, never>>,
  ): BillingInvoiceDto {
    return {
      id: inv.id,
      period: formatUtcMonth(inv.periodStart),
      status: inv.status,
      amount: microsToDecimalUsd(inv.totalMicros),
      currency: inv.currency,
      createdAt: inv.createdAt.toISOString(),
      // Real payment timestamp confirmed by the signed Stripe webhook.
      paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
      // Immutable plan version identity; null only for pre-migration rows.
      planVersionId: inv.planVersionId ?? null,
      // No Stripe hosted invoice PDF is used; keep null.
      pdfUrl: null,
    };
  }

  private buildSnapshot(args: {
    period: string;
    planVersion: PlanVersion;
    plan: BillingPlanConfig;
    outboundVolume: bigint;
    apiCalls: number;
    activeWallets: number;
    totals: ReturnType<typeof calculateInvoiceTotals>;
  }): Record<string, unknown> {
    const { period, planVersion, plan, outboundVolume, apiCalls, activeWallets, totals } = args;
    return {
      version: 1,
      period,
      // Keep the immutable plan identity at the snapshot root as well as in
      // the human-readable plan object. Stripe bootstrap and the canonical
      // serializer both validate this exact deterministic payload.
      planVersionId: planVersion.id,
      plan: {
        code: planVersion.code,
        name: planVersion.name,
        monthlyFeeMicros:
          plan.monthlyFeeMicros === null ? null : microsToDecimalUsd(plan.monthlyFeeMicros),
        includedOutboundMicros:
          plan.includedOutboundMicros === null
            ? null
            : microsToDecimalUsd(plan.includedOutboundMicros),
        includedApiCalls:
          plan.includedApiCallsPerMonth === null ? null : String(plan.includedApiCallsPerMonth),
        includedWallets: plan.includedWallets,
        apiOverageRateMicros: microsToDecimalUsd(planVersion.apiOverageRateMicros),
        walletOverageRateMicros: microsToDecimalUsd(planVersion.walletOverageRateMicros),
      },
      usage: {
        outboundVolumeMicros: microsToDecimalUsd(outboundVolume),
        apiCalls: String(apiCalls),
        activeWallets,
      },
      amounts: {
        monthlyFeeMicros: microsToDecimalUsd(totals.monthlyFeeMicros),
        billableOutboundMicros: microsToDecimalUsd(totals.billableOutboundMicros),
        outboundOverageMicros: microsToDecimalUsd(totals.outboundOverageMicros),
        apiOverageMicros: microsToDecimalUsd(totals.apiOverageMicros),
        walletOverageMicros: microsToDecimalUsd(totals.walletOverageMicros),
        totalMicros: microsToDecimalUsd(totals.totalMicros),
      },
      tiers: totals.outboundTiers.map((t) => ({
        upperBoundMicros:
          t.upperBoundMicros === null ? null : microsToDecimalUsd(t.upperBoundMicros),
        ratePpm: t.ratePpm,
        volumeMicros: microsToDecimalUsd(t.volumeMicros),
        feeMicros: microsToDecimalUsd(t.feeMicros),
      })),
    };
  }

  private buildInvoiceLines(args: {
    invoiceId: string;
    planVersion: PlanVersion;
    plan: BillingPlanConfig;
    apiCalls: number;
    activeWallets: number;
    totals: ReturnType<typeof calculateInvoiceTotals>;
  }): Prisma.BillingInvoiceLineCreateManyInput[] {
    const { invoiceId, planVersion, plan, apiCalls, activeWallets, totals } = args;
    const lines: Prisma.BillingInvoiceLineCreateManyInput[] = [];

    lines.push({
      invoiceId,
      lineType: 'monthly_fee',
      description: `Monthly fee — ${planVersion.name}`,
      quantity: 1n,
      amountMicros: totals.monthlyFeeMicros,
    });

    totals.outboundTiers.forEach((t, i) => {
      lines.push({
        invoiceId,
        lineType: 'outbound_tier',
        description: `Outbound volume tier ${i + 1}`,
        quantity: t.volumeMicros,
        unitRatePpm: t.ratePpm,
        amountMicros: t.feeMicros,
      });
    });

    // API-call usage is a hard quota: over-limit traffic is rejected with HTTP
    // 429 and never recorded, so totals.apiOverageMicros is always 0n and this
    // branch is unreachable. The guard is retained so a legacy/persisted
    // nonzero apiOverageRateMicros can never surface as an api_overage line.
    if (totals.apiOverageMicros > 0n) {
      const billableApiCalls = Math.max(apiCalls - (plan.includedApiCallsPerMonth ?? 0), 0);
      lines.push({
        invoiceId,
        lineType: 'api_overage',
        description: 'API call overage',
        quantity: BigInt(billableApiCalls),
        unitAmountMicros: planVersion.apiOverageRateMicros,
        amountMicros: totals.apiOverageMicros,
      });
    }

    if (totals.walletOverageMicros > 0n) {
      const billableWallets = Math.max(activeWallets - (plan.includedWallets ?? 0), 0);
      lines.push({
        invoiceId,
        lineType: 'wallet_overage',
        description: 'Wallet overage',
        quantity: BigInt(billableWallets),
        unitAmountMicros: planVersion.walletOverageRateMicros,
        amountMicros: totals.walletOverageMicros,
      });
    }

    return lines;
  }

  private monthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * True for Prisma serialization/deadlock/write-conflict errors (P2034) and
 * PostgreSQL 40001 serialization failures. These are retryable; business
 * ConflictExceptions and unique-constraint P2002 are not.
 */
function isSerializationError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true;
  }
  const text = String((err as { message?: unknown })?.message ?? '');
  return text.includes('40001') || text.includes('could not serialize access');
}

function isValidFenceDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * A reconciliation run is unresolved when it is running/failed, its summary has
 * errors/conflicts/notFound/transientError > 0, or it lacks the exhaustive
 * `complete: true` completion marker. replayed/casNoops are not errors.
 *
 * High-water close predicate: a `complete: true` run only clears risk when its
 * `completedAt` exists and is not earlier than the target accounting period's
 * `periodEnd` (finalization cutoff), its `highWaterMark` is either null (empty
 * candidate set) or a valid `{ createdAt: valid UTC date string, id }`, and its
 * `accountingPeriods` is a valid JSON array of UTC month-start strings
 * (missing/malformed period metadata is conservatively risky). A non-empty run
 * (scanned > 0) must carry a valid highWaterMark. The highWaterMark is the
 * maximum (createdAt, id) of the exhaustive candidate scan — never the last row
 * in priority order.
 */
function isRiskyReconciliationRun(
  run: {
    id: string;
    status: string;
    completedAt: Date | null;
    summary: unknown;
    billingAccountId?: string | null;
    accountUserId?: string | null;
    runType?: string;
    periodStart?: Date;
    periodEnd?: Date | null;
  },
  periodEnd: Date,
  target: {
    accountId: string;
    userId: string;
    runType: string;
    periodStart: Date;
    periodEnd: Date;
  },
): boolean {
  if (run.status !== 'completed') return true;
  if (
    run.billingAccountId !== target.accountId ||
    run.accountUserId !== target.userId ||
    run.runType !== target.runType ||
    !(run.periodStart instanceof Date) ||
    run.periodStart.getTime() !== target.periodStart.getTime() ||
    !(run.periodEnd instanceof Date) ||
    run.periodEnd.getTime() !== target.periodEnd.getTime()
  )
    return true;
  const summary = (run.summary ?? {}) as Record<string, unknown>;
  if (
    summary.userId !== target.userId ||
    summary.billingAccountId !== target.accountId ||
    summary.runId !== run.id ||
    summary.runType !== target.runType ||
    summary.periodStart !== target.periodStart.toISOString() ||
    summary.periodEnd !== target.periodEnd.toISOString()
  )
    return true;
  const requiredCounters = [
    'scanned',
    'notFound',
    'transientError',
    'reverted',
    'posted',
    'quarantined',
    'updated',
    'errors',
    'conflicts',
    'replayed',
    'casNoops',
    'noHash',
    'retryable',
    'remainingUnresolved',
  ];
  if (
    !requiredCounters.every(
      (key) => Number.isSafeInteger(summary[key]) && (summary[key] as number) >= 0,
    )
  )
    return true;
  const errors = summary.errors as number;
  const conflicts = summary.conflicts as number;
  const notFound = summary.notFound as number;
  const transientError = summary.transientError as number;
  const noHash = summary.noHash as number;
  const quarantined = summary.quarantined as number;
  const retryable = summary.retryable as number;
  // The final DB exhaustion check: a run whose exact account/period scan was
  // not exhausted cannot be a clean closure proof.
  const remainingUnresolved = summary.remainingUnresolved as number;
  if (
    errors > 0 ||
    conflicts > 0 ||
    notFound > 0 ||
    transientError > 0 ||
    noHash > 0 ||
    quarantined > 0 ||
    retryable > 0 ||
    remainingUnresolved > 0
  ) {
    return true;
  }
  // A run is only clean when it is an exhaustive completion marker.
  if (summary.complete !== true) return true;
  // completedAt must exist and not be earlier than the period-end cutoff.
  if (!(run.completedAt instanceof Date) || Number.isNaN(run.completedAt.getTime())) return true;
  if (run.completedAt.getTime() < periodEnd.getTime()) return true;
  // highWaterMark must be valid when present; a non-empty run must carry one.
  const scanned = summary.scanned as number;
  const hwm = summary.highWaterMark;
  if (hwm !== undefined && hwm !== null && !isValidHighWaterMark(hwm)) return true;
  if (scanned > 0 && (hwm === undefined || hwm === null)) return true;
  // accountingPeriods must be a valid array of UTC month-start strings;
  // missing/malformed period metadata is conservatively risky.
  if (!isValidAccountingPeriods(summary.accountingPeriods)) return true;
  if (scanned > 0 && (summary.accountingPeriods as unknown[]).length === 0) return true;
  return false;
}

/** True when `value` is a JSON-safe `{ createdAt: valid UTC date, id: string }`. */
function isValidHighWaterMark(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const hwm = value as Record<string, unknown>;
  if (typeof hwm.createdAt !== 'string' || typeof hwm.id !== 'string' || hwm.id.length === 0)
    return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(hwm.createdAt)) return false;
  const parsed = new Date(hwm.createdAt);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === hwm.createdAt;
}

/**
 * True when a run carries unresolved risk (running/failed status or any
 * notFound/transientError/errors/conflicts counter > 0). Such runs have receipt
 * uncertainty and must never be scoped out by createdAt-derived coverage.
 */
function hasUnresolvedRunRisk(run: { status: string; summary: unknown }): boolean {
  if (run.status !== 'completed') return true;
  const summary = (run.summary ?? {}) as Record<string, unknown>;
  const requiredCounters = [
    'scanned',
    'notFound',
    'transientError',
    'reverted',
    'posted',
    'quarantined',
    'updated',
    'errors',
    'conflicts',
    'replayed',
    'casNoops',
    'noHash',
    'retryable',
    'remainingUnresolved',
  ];
  if (
    !requiredCounters.every(
      (key) => Number.isSafeInteger(summary[key]) && (summary[key] as number) >= 0,
    )
  )
    return true;
  const errors = typeof summary.errors === 'number' ? summary.errors : 0;
  const conflicts = typeof summary.conflicts === 'number' ? summary.conflicts : 0;
  const notFound = typeof summary.notFound === 'number' ? summary.notFound : 0;
  const transientError = typeof summary.transientError === 'number' ? summary.transientError : 0;
  const noHash = typeof summary.noHash === 'number' ? summary.noHash : 0;
  const quarantined = typeof summary.quarantined === 'number' ? summary.quarantined : 0;
  const retryable = typeof summary.retryable === 'number' ? summary.retryable : 0;
  const remainingUnresolved =
    typeof summary.remainingUnresolved === 'number' ? summary.remainingUnresolved : 0;
  return (
    errors > 0 ||
    conflicts > 0 ||
    notFound > 0 ||
    transientError > 0 ||
    noHash > 0 ||
    quarantined > 0 ||
    retryable > 0 ||
    remainingUnresolved > 0
  );
}

/**
 * True when `value` is a JSON array of canonical UTC month-start ISO strings
 * (e.g. `2026-07-01T00:00:00.000Z`): each value must round-trip exactly through
 * `Date.toISOString()` and be UTC day 1 with zero hours/minutes/seconds/ms.
 * Missing/malformed period metadata is conservatively risky.
 */
function isValidAccountingPeriods(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  let previous = '';
  for (const period of value) {
    if (typeof period !== 'string') return false;
    const date = new Date(period);
    if (Number.isNaN(date.getTime())) return false;
    if (date.toISOString() !== period) return false;
    if (seen.has(period) || (previous !== '' && period <= previous)) return false;
    seen.add(period);
    previous = period;
    if (date.getUTCDate() !== 1) return false;
    if (
      date.getUTCHours() !== 0 ||
      date.getUTCMinutes() !== 0 ||
      date.getUTCSeconds() !== 0 ||
      date.getUTCMilliseconds() !== 0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * BigInt half-up rounding matching billing-pricing's deterministic formula:
 * `(numerator * 2 + denominator) / (2 * denominator)`. Never uses Number/float.
 */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      'roundHalfUp requires a non-negative numerator and a positive denominator',
    );
  }
  return (numerator * 2n + denominator) / (2n * denominator);
}

/**
 * Rejects any BigInt (or other non-JSON value) nested inside a payload that is
 * about to be persisted as JSON. BigInt must never leak into receiptData or
 * metadata columns.
 */
function assertJsonSafe(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'bigint') {
    throw new BadRequestException(`${path} must be JSON-safe (BigInt is not allowed)`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      assertJsonSafe(val, `${path}.${key}`);
    }
  }
}

/**
 * Own-property safe lookup into the static `PLANS` whitelist. Rejects
 * non-strings, empty strings, and inherited keys (`toString`, `constructor`,
 * `__proto__`, ...) so a crafted code can never resolve to a prototype member.
 */
function isOwnPlanCode(code: unknown): code is PlanId {
  if (typeof code !== 'string' || code.length === 0) return false;
  return Object.prototype.hasOwnProperty.call(PLANS, code);
}

/**
 * Shared plan-boundary validation (Phase 2 Oracle gate). A persisted plan
 * version is only executable when its code is an own property of the static
 * `PLANS` whitelist AND its term shape is computable with strict runtime types:
 * BigInt monetary/quota fields must be bigint and non-negative; Int/rate/counter
 * fields must be safe integers and non-negative; undefined/number/negative/
 * unsafe values are never implicitly coerced. Enterprise must keep the full
 * custom/null contract (all four terms null) and is listable but never
 * executable. Unknown codes, empty/unsupported codes, and malformed rows fail
 * closed with a business ConflictException — never treated as Free, 0, or
 * infinite. Returns the canonical static config for the code (DB values remain
 * the price snapshot used by the calculator).
 */
export function validatePlanVersion(planVersion: PlanVersion): BillingPlanConfig {
  const code = planVersion.code;
  if (!isOwnPlanCode(code)) {
    throw new ConflictException(`Plan code is not supported: ${String(code)}`);
  }
  const config = PLANS[code];

  // Runtime type + computability checks (never implicitly coerce).
  assertNonNegativeBigint(planVersion.apiOverageRateMicros, 'apiOverageRateMicros', code);
  assertNonNegativeBigint(planVersion.walletOverageRateMicros, 'walletOverageRateMicros', code);
  if (
    typeof planVersion.version !== 'number' ||
    !Number.isSafeInteger(planVersion.version) ||
    planVersion.version < 0
  ) {
    throw new ConflictException(`Plan terms are invalid: ${code}.version`);
  }

  const isEnterprise = config.id === 'enterprise';
  if (isEnterprise) {
    if (
      planVersion.monthlyFeeMicros !== null ||
      planVersion.includedOutboundMicros !== null ||
      planVersion.includedWallets !== null ||
      planVersion.includedApiCalls !== null
    ) {
      throw new ConflictException('Enterprise plan terms are malformed');
    }
  } else {
    assertNonNegativeBigint(planVersion.monthlyFeeMicros, 'monthlyFeeMicros', code);
    assertNonNegativeBigint(planVersion.includedOutboundMicros, 'includedOutboundMicros', code);
    assertNonNegativeSafeInt(planVersion.includedWallets, 'includedWallets', code);
    assertNonNegativeBigint(planVersion.includedApiCalls, 'includedApiCalls', code);
    // includedApiCalls is converted to Number at the calculator/DTO boundary;
    // reject values above Number.MAX_SAFE_INTEGER before any imprecise
    // conversion (never weaken valid historical finite snapshots).
    if (planVersion.includedApiCalls > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConflictException(`Plan terms are invalid: ${code}.includedApiCalls`);
    }
  }
  return config;
}

function assertNonNegativeBigint(
  value: unknown,
  field: string,
  code: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new ConflictException(`Plan terms are invalid: ${code}.${field}`);
  }
}

function assertNonNegativeSafeInt(
  value: unknown,
  field: string,
  code: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConflictException(`Plan terms are invalid: ${code}.${field}`);
  }
}

/**
 * Converts a bigint usage count to a Number only at a safe boundary (the pure
 * calculator / snapshot / line builder). Fails closed when the count is
 * negative or exceeds Number.MAX_SAFE_INTEGER so accounting never truncates,
 * misreports, or reduces usage. All ledger aggregation and quota comparison
 * stay in bigint.
 */
function toSafeCount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConflictException('Usage count is invalid or exceeds the safe integer range');
  }
  return Number(value);
}

function planVersionToConfig(v: PlanVersion): BillingPlanConfig {
  validatePlanVersion(v);
  return {
    id: v.code as PlanId,
    name: v.name,
    monthlyFeeMicros: v.monthlyFeeMicros,
    includedOutboundMicros: v.includedOutboundMicros,
    includedWallets: v.includedWallets,
    includedApiCallsPerMonth: v.includedApiCalls !== null ? Number(v.includedApiCalls) : null,
  };
}

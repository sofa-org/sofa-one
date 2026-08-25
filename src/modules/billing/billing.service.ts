import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  pdfUrl: string | null;
}

export interface ListInvoicesResult {
  items: BillingInvoiceDto[];
  total: number;
  page: number;
  limit: number;
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
}

type PlanVersion = Prisma.BillingPlanVersionGetPayload<Record<string, never>>;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Plans ───────────────────────────────────────────────────────────────────

  /**
   * Returns the user's current plan id plus the full plan catalog. Ensures the
   * default Free account/assignment and initializes the plan catalog on first
   * access. Plan versions are only created when missing; used versions are
   * never updated.
   */
  async getPlans(userId: string): Promise<GetPlansResult> {
    const account = await this.ensureAccount(userId);
    await this.ensurePlanVersions();
    const assignment = await this.ensureDefaultAssignment(account.id);

    const currentPlan = await this.prisma.billingPlanVersion.findUnique({
      where: { id: assignment.planVersionId },
    });
    const versions = await this.prisma.billingPlanVersion.findMany({
      orderBy: [{ code: 'asc' }, { version: 'asc' }],
    });

    return {
      currentPlanId: currentPlan?.code ?? 'free',
      plans: versions.map((v) => this.toPlanDto(v)),
    };
  }

  // ── Usage recording ─────────────────────────────────────────────────────────

  /**
   * Records a single API call (metric = api_call, quantity = 1). Idempotent on
   * sourceKey: a duplicate sourceKey is silently ignored. The sourceKey must be
   * supplied by the server-side caller and is never derived from a client
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
   * Records a successful outbound transfer (metric = outbound_volume). Only
   * accepts a non-negative bigint amount; the caller must guarantee the receipt
   * status is success. Idempotent on sourceKey. Unsupported assets are never
   * silently converted to 0.
   */
  async recordSuccessfulOutbound(input: RecordOutboundInput): Promise<void> {
    if (typeof input.amountUsdMicros !== 'bigint' || input.amountUsdMicros < 0n) {
      throw new BadRequestException('amountUsdMicros must be a non-negative bigint');
    }
    const account = await this.ensureAccount(input.userId);
    const occurredAt = input.occurredAt ?? new Date();
    const periodStart = this.monthStart(occurredAt);
    try {
      await this.prisma.billingUsageEvent.create({
        data: {
          billingAccountId: account.id,
          metric: 'outbound_volume',
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
    } catch (err) {
      if (isUniqueConstraintError(err)) return; // idempotent
      throw err;
    }
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
    const { period: periodStr, start, end } = parsePeriod(period);

    const planVersion = await this.resolvePlanVersion(account.id, start);
    const plan = planVersionToConfig(planVersion);

    const [usageEvents, activeWallets] = await Promise.all([
      this.prisma.billingUsageEvent.findMany({
        where: {
          billingAccountId: account.id,
          periodStart: start,
          occurredAt: { gte: start, lt: end },
        },
      }),
      this.prisma.userWallet.count({
        where: { userId, status: 'active', walletAddress: { not: null }, frozenAt: null },
      }),
    ]);

    let outboundVolume = 0n;
    let apiCalls = 0;
    for (const ev of usageEvents) {
      if (ev.metric === 'outbound_volume') outboundVolume += ev.volumeUsdMicros;
      else if (ev.metric === 'api_call') apiCalls += Number(ev.quantity);
    }

    const totals = calculateInvoiceTotals({
      plan,
      grossOutboundMicros: outboundVolume,
      activeWallets,
      apiCallsTotal: apiCalls,
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
   */
  async finalizeInvoice(userId: string, period?: string): Promise<BillingInvoiceDto> {
    const account = await this.ensureAccount(userId);
    await this.ensurePlanVersions();
    const { period: periodStr, start, end } = parsePeriod(period);

    const existing = await this.prisma.billingInvoice.findUnique({
      where: {
        billingAccountId_periodStart: { billingAccountId: account.id, periodStart: start },
      },
    });
    if (existing) return this.toInvoiceDto(existing);

    const planVersion = await this.resolvePlanVersion(account.id, start);
    const plan = planVersionToConfig(planVersion);

    const [usageEvents, activeWallets] = await Promise.all([
      this.prisma.billingUsageEvent.findMany({
        where: {
          billingAccountId: account.id,
          periodStart: start,
          occurredAt: { gte: start, lt: end },
        },
      }),
      this.prisma.userWallet.count({
        where: { userId, status: 'active', walletAddress: { not: null }, frozenAt: null },
      }),
    ]);

    let outboundVolume = 0n;
    let apiCalls = 0;
    for (const ev of usageEvents) {
      if (ev.metric === 'outbound_volume') outboundVolume += ev.volumeUsdMicros;
      else if (ev.metric === 'api_call') apiCalls += Number(ev.quantity);
    }

    const totals = calculateInvoiceTotals({
      plan,
      grossOutboundMicros: outboundVolume,
      activeWallets,
      apiCallsTotal: apiCalls,
      apiOverageRateMicros: planVersion.apiOverageRateMicros,
      walletOverageRateMicros: planVersion.walletOverageRateMicros,
    });

    const snapshot = this.buildSnapshot({
      period: periodStr,
      planVersion,
      plan,
      outboundVolume,
      apiCalls,
      activeWallets,
      totals,
    });
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

    try {
      const invoice = await this.prisma.$transaction(async (tx) => {
        const created = await tx.billingInvoice.create({
          data: {
            billingAccountId: account.id,
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
              plan.includedApiCallsPerMonth !== null ? BigInt(plan.includedApiCallsPerMonth) : null,
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
          apiCalls,
          activeWallets,
          totals,
        });
        if (lines.length > 0) {
          await tx.billingInvoiceLine.createMany({ data: lines });
        }
        return created;
      });
      return this.toInvoiceDto(invoice);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const again = await this.prisma.billingInvoice.findUnique({
          where: {
            billingAccountId_periodStart: { billingAccountId: account.id, periodStart: start },
          },
        });
        if (again) return this.toInvoiceDto(again);
      }
      throw err;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

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

  /** Ensures the account has a default Free assignment for the current month. */
  private async ensureDefaultAssignment(
    accountId: string,
  ): Promise<Prisma.BillingPlanAssignmentGetPayload<Record<string, never>>> {
    const existing = await this.prisma.billingPlanAssignment.findFirst({
      where: { billingAccountId: accountId },
      orderBy: { periodStart: 'desc' },
    });
    if (existing) return existing;

    const freePlan = await this.prisma.billingPlanVersion.findFirst({
      where: { code: 'free' },
      orderBy: { version: 'desc' },
    });
    if (!freePlan) throw new Error('Free plan not initialized');

    const periodStart = this.monthStart(new Date());
    try {
      return await this.prisma.billingPlanAssignment.create({
        data: { billingAccountId: accountId, planVersionId: freePlan.id, periodStart },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const again = await this.prisma.billingPlanAssignment.findFirst({
          where: { billingAccountId: accountId },
          orderBy: { periodStart: 'desc' },
        });
        if (again) return again;
      }
      throw err;
    }
  }

  /** Resolves the plan version in effect at `start`, falling back to Free. */
  private async resolvePlanVersion(accountId: string, start: Date): Promise<PlanVersion> {
    const assignment = await this.prisma.billingPlanAssignment.findFirst({
      where: { billingAccountId: accountId, periodStart: { lte: start } },
      orderBy: { periodStart: 'desc' },
      include: { planVersion: true },
    });
    if (assignment) return assignment.planVersion;
    const freePlan = await this.prisma.billingPlanVersion.findFirst({
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
      paidAt: null,
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

function planVersionToConfig(v: PlanVersion): BillingPlanConfig {
  return {
    id: v.code as PlanId,
    name: v.name,
    monthlyFeeMicros: v.monthlyFeeMicros,
    includedOutboundMicros: v.includedOutboundMicros,
    includedWallets: v.includedWallets,
    includedApiCallsPerMonth: v.includedApiCalls !== null ? Number(v.includedApiCalls) : null,
  };
}

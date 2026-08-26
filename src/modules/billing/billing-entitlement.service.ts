import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingQuotaExceededException } from './billing-quota.exception';
import { formatUtcMonth, parsePeriod } from './billing.utils';
import { validatePlanVersion } from './billing.service';

/** JSON-safe entitlements for a user for a UTC month. */
export interface EntitlementsResult {
  planCode: string;
  planName: string;
  /** YYYY-MM the entitlements apply to. */
  effectivePeriod: string;
  /** null means custom/non-executable (Enterprise). */
  includedApiCalls: number | null;
  /** null means custom/non-executable (Enterprise). */
  includedWallets: number | null;
}

/** JSON-safe plan-in-effect result. */
export interface PlanForPeriodResult {
  planCode: string;
  planName: string;
  effectivePeriod: string;
}

const FREE_FALLBACK = {
  planCode: 'free',
  planName: 'Free',
  includedApiCalls: 10_000,
  includedWallets: 10,
};

/**
 * Minimal plan/quota façade (Phase 2A). Reads the plan in effect for a UTC
 * month without re-implementing plan-catalog initialization or default
 * assignment creation. JSON-safe: no BigInt leaks. Quota enforcement is wired
 * by later lanes; this lane only exposes read-only entitlements.
 */
@Injectable()
export class BillingEntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async getEntitlements(userId: string, period?: string): Promise<EntitlementsResult> {
    const { start } = parsePeriod(period);
    return this.resolveEntitlements(userId, start, this.prisma);
  }

  /**
   * Resolves the plan in effect at `start` for the user's BillingAccount using
   * the existing assignment/plan resolver. `db` may be the PrismaService or an
   * interactive-transaction client so quota decisions share the caller's
   * transaction snapshot. Falls back to Free when no account/assignment exists.
   */
  private async resolveEntitlements(
    userId: string,
    start: Date,
    db: Prisma.TransactionClient,
  ): Promise<EntitlementsResult> {
    const account = await db.billingAccount.findUnique({ where: { userId } });
    if (!account) {
      return {
        ...FREE_FALLBACK,
        effectivePeriod: formatUtcMonth(start),
      };
    }
    const assignment = await db.billingPlanAssignment.findFirst({
      where: { billingAccountId: account.id, periodStart: { lte: start } },
      orderBy: { periodStart: 'desc' },
      include: { planVersion: true },
    });
    const planVersion = assignment?.planVersion;
    if (!planVersion) {
      return {
        ...FREE_FALLBACK,
        effectivePeriod: formatUtcMonth(start),
      };
    }
    // Fail closed on unknown/malformed persisted plans — never silently Free,
    // never treated as 0 or infinite.
    validatePlanVersion(planVersion);
    return {
      planCode: planVersion.code,
      planName: planVersion.name,
      effectivePeriod: formatUtcMonth(start),
      includedApiCalls:
        planVersion.includedApiCalls !== null ? Number(planVersion.includedApiCalls) : null,
      includedWallets: planVersion.includedWallets,
    };
  }

  /**
   * Transaction-aware active-wallet hard-quota seam (Phase 2C). Must be called
   * inside the same interactive transaction that will create/activate the
   * wallet so the count and the activation share one snapshot (no
   * check-then-act race). Re-authorizing an already-active wallet
   * (`status='active'`, `walletAddress IS NOT NULL`, `frozenAt IS NULL`) is
   * idempotent and always allowed. Only an activation that would add a new
   * active wallet is gated: when the current active count is already at or
   * above the plan's `includedWallets`, a `BillingQuotaExceededException`
   * (429, metric `active_wallets`) is raised. Enterprise/custom null wallet
   * terms fail closed with an explicit business error — never treated as
   * unlimited or zero.
   */
  async assertWalletActivationAllowed(
    userId: string,
    tx: Prisma.TransactionClient,
    period?: string,
  ): Promise<void> {
    const { start } = parsePeriod(period);
    const entitlements = await this.resolveEntitlements(userId, start, tx);
    const includedWallets = entitlements.includedWallets;

    if (includedWallets === null) {
      throw new ConflictException(
        'Cannot activate wallet: plan has Enterprise custom/null wallet terms requiring review',
      );
    }

    const existing = await tx.userWallet.findUnique({ where: { userId } });
    const alreadyActive = Boolean(
      existing &&
      existing.status === 'active' &&
      existing.walletAddress !== null &&
      existing.frozenAt === null,
    );
    if (alreadyActive) return;

    const activeCount = await tx.userWallet.count({
      where: { userId, status: 'active', walletAddress: { not: null }, frozenAt: null },
    });
    if (activeCount >= includedWallets) {
      throw new BillingQuotaExceededException(
        'active_wallets',
        includedWallets,
        entitlements.effectivePeriod,
        this.secondsUntilNextUtcMonth(),
      );
    }
  }

  /** Seconds until the next UTC month start (when the wallet quota resets). */
  private secondsUntilNextUtcMonth(): number {
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return Math.max(Math.ceil((nextMonth.getTime() - now.getTime()) / 1000), 1);
  }

  async getPlanForPeriod(userId: string, period?: string): Promise<PlanForPeriodResult> {
    const entitlements = await this.getEntitlements(userId, period);
    return {
      planCode: entitlements.planCode,
      planName: entitlements.planName,
      effectivePeriod: entitlements.effectivePeriod,
    };
  }
}

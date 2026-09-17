import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';

/**
 * JSON-safe debt snapshot for gate/audit callers (Wallet, Transactions).
 * No monetary amounts — only existence and invoice ids — so BigInt never
 * enters the response surface.
 */
export interface BillingDebtSnapshot {
  /** True when at least one finalized unpaid invoice exists for the user. */
  hasDebt: boolean;
  /** Finalized unpaid invoice ids (stable audit trail); empty when no debt. */
  invoiceIds: string[];
}

/**
 * Read-only billing-debt fact for blocking gated operations while a user has
 * outstanding invoices. Debt is strictly:
 *   BillingInvoice.status === 'finalized' AND paidAt === null
 * under the user's BillingAccount. `open` / `needs_review` / `void` never
 * count. Missing account = no debt. Never creates accounts or invoices.
 *
 * Accepts PrismaService or an interactive `Prisma.TransactionClient` so
 * callers can share a transaction snapshot. DB/query errors propagate
 * (fail closed) — never fail-open to "no debt".
 */
@Injectable()
export class BillingDebtService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns whether `userId` currently owes on any finalized unpaid invoice,
   * plus the matching invoice ids for audit. Scoped strictly by
   * `BillingAccount.userId` — never cross-user.
   */
  async getDebt(
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<BillingDebtSnapshot> {
    const account = await db.billingAccount.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!account) {
      return { hasDebt: false, invoiceIds: [] };
    }

    // Only usage_period invoices gate wallet/transaction operations. Abandoned
    // plan_charge upgrade invoices must not block while current entitlement is
    // unchanged (user can ignore an unpaid upgrade request).
    const invoices = await db.billingInvoice.findMany({
      where: {
        billingAccountId: account.id,
        status: 'finalized',
        paidAt: null,
        purpose: 'usage_period',
      },
      select: { id: true },
      orderBy: { periodStart: 'asc' },
    });

    const invoiceIds = invoices.map((row) => row.id);
    return {
      hasDebt: invoiceIds.length > 0,
      invoiceIds,
    };
  }

  /**
   * Convenience boolean for simple gates. Equivalent to
   * `(await this.getDebt(userId, db)).hasDebt`. Errors still propagate.
   */
  async hasDebt(
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const snapshot = await this.getDebt(userId, db);
    return snapshot.hasDebt;
  }
}

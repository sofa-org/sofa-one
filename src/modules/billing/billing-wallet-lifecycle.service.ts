import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingEntitlementService } from './billing-entitlement.service';

/** Serializes every quota/eligibility transition for one billing account. */
@Injectable()
export class BillingWalletLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: BillingEntitlementService,
  ) {}

  /**
   * Ensure account outside transaction, then acquire its row lock as the first
   * transaction statement. This is ReadCommitted (never Serializable snapshot).
   * Do not combine this account-row lock with the billing-period advisory lock:
   * separate preparation from period-locked reads to avoid the Stripe inverse order.
   * Keep provider work outside `work`.
   */
  async withWalletAccountLock<T>(
    userId: string,
    work: (tx: Prisma.TransactionClient, accountId: string, now: Date) => Promise<T>,
  ): Promise<T> {
    const account = await this.prisma.billingAccount.upsert({ where: { userId }, create: { userId }, update: {}, select: { id: true } });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM billing_accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
      return work(tx, account.id, new Date());
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  /**
   * Materialize current-month wallet evidence before summary/finalization reads.
   * This deliberately uses a short ReadCommitted account-row transaction and
   * never nests the billing-period advisory lock. The observation clock starts
   * only after the account lock is acquired.
   */
  async prepareWalletUsageThroughCurrentMonth(userId: string, _now?: Date): Promise<void> {
    void _now;
    const account = await this.prisma.billingAccount.upsert({ where: { userId }, create: { userId }, update: {}, select: { id: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM billing_accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
      const now = new Date();
      await this.initializeWalletCount(tx, account.id, userId, now);
      const current = await tx.billingAccount.findUniqueOrThrow({ where: { id: account.id }, select: { eligibleWalletCount: true, walletCountObservedAt: true } });
      await this.carryIdleMonths(tx, account.id, current.walletCountObservedAt, current.eligibleWalletCount, now);
      await tx.billingAccount.update({ where: { id: account.id }, data: { walletCountObservedAt: now } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  /** Call inside withWalletAccountLock, before inserting this wallet/intent; intent count is distinct by wallet. */
  async assertWalletReservationAllowed(
    tx: Prisma.TransactionClient, userId: string, walletId: string, now: Date,
  ): Promise<void> {
    await this.assertCapacity(tx, userId, walletId, now, false);
  }

  /**
   * Call only for an ineligible -> eligible transition, after updating the wallet,
   * in the same transaction. Existing eligible-wallet reauthorization must skip
   * this method. Rechecks cap and updates count/peak atomically.
   */
  async recordWalletActivation(
    tx: Prisma.TransactionClient, accountId: string, userId: string, now: Date,
  ): Promise<void> {
    await this.initializeWalletCount(tx, accountId, userId, now);
    await this.assertCapacity(tx, userId, undefined, now, true);
    const account = await tx.billingAccount.findUniqueOrThrow({ where: { id: accountId }, select: { eligibleWalletCount: true, walletCountObservedAt: true } });
    await this.carryIdleMonths(tx, accountId, account.walletCountObservedAt, account.eligibleWalletCount, now);
    const count = await tx.userWallet.count({ where: this.eligibleWalletWhere(userId) });
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prior = await tx.billingWalletUsagePeriod.findUnique({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: month } }, select: { peakWalletCount: true } });
    await tx.billingWalletUsagePeriod.upsert({
      where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: month } },
      create: { billingAccountId: accountId, periodStart: month, peakWalletCount: count, observedAt: now },
      update: { peakWalletCount: Math.max(prior?.peakWalletCount ?? 0, count), observedAt: now },
    });
    await tx.billingAccount.update({ where: { id: accountId }, data: { eligibleWalletCount: count, walletCountObservedAt: now } });
  }

  /** Initialize rollout-era accounts from present evidence, without treating an already-active wallet as an activation. */
  async initializeWalletCount(
    tx: Prisma.TransactionClient, accountId: string, userId: string, now: Date,
  ): Promise<void> {
    const account = await tx.billingAccount.findUniqueOrThrow({ where: { id: accountId }, select: { eligibleWalletCount: true, walletCountObservedAt: true } });
    if (account.walletCountObservedAt) return;
    const count = await tx.userWallet.count({ where: this.eligibleWalletWhere(userId) });
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prior = await tx.billingWalletUsagePeriod.findUnique({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: month } }, select: { peakWalletCount: true } });
    await tx.billingWalletUsagePeriod.upsert({
      where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: month } },
      create: { billingAccountId: accountId, periodStart: month, peakWalletCount: count, observedAt: now },
      update: { peakWalletCount: Math.max(prior?.peakWalletCount ?? 0, count), observedAt: now },
    });
    await tx.billingAccount.update({ where: { id: accountId }, data: { eligibleWalletCount: count, walletCountObservedAt: now } });
  }

  private async assertCapacity(tx: Prisma.TransactionClient, userId: string, walletId: string | undefined, now: Date, activation: boolean) {
    const ent = await this.entitlements.getEntitlementsInTransaction(userId, tx, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
    if (ent.includedWallets === null) throw new ConflictException('Cannot reserve wallet: Enterprise custom/null wallet terms require review');
    const unresolved = await tx.walletProvisioningIntent.findMany({
      where: { status: { in: ['pending', 'dispatched', 'uncertain', 'provisioned'] }, wallet: { userId } },
      select: { walletId: true },
    });
    const intents = new Set(unresolved.map((row) => row.walletId));
    if (walletId) intents.delete(walletId);
    const activeRows = await tx.userWallet.findMany({ where: this.eligibleWalletWhere(userId), select: { id: true } });
    const occupiedWallets = new Set(activeRows.map((row) => row.id));
    for (const id of intents) occupiedWallets.add(id);
    const occupied = occupiedWallets.size;
    if (activation ? occupied > ent.includedWallets : occupied >= ent.includedWallets) {
      throw new ConflictException(`Active wallet quota exceeded (${ent.includedWallets})`);
    }
  }

  private eligibleWalletWhere(userId: string) { return { userId, status: 'active' as const, walletAddress: { not: null }, frozenAt: null }; }

  private async carryIdleMonths(tx: Prisma.TransactionClient, accountId: string, observedAt: Date | null, openingCount: number, now: Date) {
    if (!observedAt) return;
    const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let cursor = new Date(Date.UTC(observedAt.getUTCFullYear(), observedAt.getUTCMonth(), 1));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    while (cursor <= currentMonth) {
      const existing = await tx.billingWalletUsagePeriod.findUnique({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: cursor } }, select: { peakWalletCount: true } });
      await tx.billingWalletUsagePeriod.upsert({
        where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: cursor } },
        create: { billingAccountId: accountId, periodStart: cursor, peakWalletCount: openingCount, observedAt: now },
        update: { peakWalletCount: Math.max(existing?.peakWalletCount ?? 0, openingCount) },
      });
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
  }
}

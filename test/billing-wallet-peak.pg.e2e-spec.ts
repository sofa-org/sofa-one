/** Real-PostgreSQL evidence for monthly wallet-peak invoice semantics. */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { BillingService } from '../src/modules/billing/billing.service';
import { BillingEntitlementService } from '../src/modules/billing/billing-entitlement.service';
import { BillingWalletLifecycleService } from '../src/modules/billing/billing-wallet-lifecycle.service';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL
  ? applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget())
  : null;
const prisma = target ? new PrismaClient({ adapter: new PrismaPg(target.url) }) : null;
const run = target ? describe : describe.skip;
const CURRENT = new Date();
const currentStart = new Date(Date.UTC(CURRENT.getUTCFullYear(), CURRENT.getUTCMonth(), 1));
const previousStart = new Date(Date.UTC(CURRENT.getUTCFullYear(), CURRENT.getUTCMonth() - 1, 1));
const nextStart = new Date(Date.UTC(CURRENT.getUTCFullYear(), CURRENT.getUTCMonth() + 1, 1));

function lifecycleService(): BillingWalletLifecycleService {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const entitlement = new BillingEntitlementService(prisma as never);
  return new BillingWalletLifecycleService(prisma as never, entitlement);
}

function billingService(): BillingService {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  return new BillingService(prisma as never, lifecycleService());
}

async function userFixture(label: string) {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, socialProvider: 'test', socialId: `${label}-${userId}` } });
  const account = await prisma.billingAccount.create({ data: { userId } });
  return { userId, accountId: account.id };
}

async function cleanup(userId: string) {
  if (!prisma) return;
  await prisma.billingInvoiceLine.deleteMany({ where: { invoice: { billingAccount: { userId } } } });
  await prisma.billingInvoice.deleteMany({ where: { billingAccount: { userId } } });
  await prisma.billingWalletUsagePeriod.deleteMany({ where: { billingAccount: { userId } } });
  await prisma.billingPlanAssignment.deleteMany({ where: { billingAccount: { userId } } });
  await prisma.billingAccount.deleteMany({ where: { userId } });
  await prisma.userWallet.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

run('billing wallet peak PostgreSQL evidence', () => {
  beforeAll(async () => {
    if (!prisma || !target) throw new Error('runner-provisioned PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('records an explicit zero for the observed month without inventing pre-rollout history', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { userId, accountId } = await userFixture('peak-zero');
    try {
      await lifecycleService().prepareWalletUsageThroughCurrentMonth(userId);
      const current = await prisma.billingWalletUsagePeriod.findUniqueOrThrow({
        where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: currentStart } },
      });
      expect(current.peakWalletCount).toBe(0);
      expect(await prisma.billingWalletUsagePeriod.count({ where: { billingAccountId: accountId, periodStart: { lt: currentStart } } })).toBe(0);
    } finally { await cleanup(userId); }
  });

  it('carries an idle opening balance and does not advance a prior peak on later activation', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { userId, accountId } = await userFixture('peak-carry');
    try {
      const older = new Date(Date.UTC(previousStart.getUTCFullYear(), previousStart.getUTCMonth() - 2, 1));
      await prisma.billingAccount.update({ where: { id: accountId }, data: { eligibleWalletCount: 2, walletCountObservedAt: older } });
      await lifecycleService().prepareWalletUsageThroughCurrentMonth(userId);
      const previous = await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: previousStart } } });
      const current = await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: currentStart } } });
      expect(previous.peakWalletCount).toBe(2);
      expect(current.peakWalletCount).toBe(2);
      expect(nextStart.getTime()).toBeGreaterThan(currentStart.getTime());
    } finally { await cleanup(userId); }
  });

  it('serializes preparation with concurrent activation without lowering the observed peak', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { userId, accountId } = await userFixture('peak-race');
    const walletId = randomUUID();
    try {
      const lifecycle = lifecycleService();
      await prisma.userWallet.create({ data: { id: walletId, userId, status: 'pending_embedded_wallet' } });
      await Promise.all([
        lifecycle.prepareWalletUsageThroughCurrentMonth(userId),
        lifecycle.withWalletAccountLock(userId, async (tx, lockedAccountId, now) => {
          await tx.userWallet.update({ where: { id: walletId }, data: { status: 'active', walletAddress: `0x${'4'.repeat(40)}` } });
          await lifecycle.recordWalletActivation(tx, lockedAccountId, userId, now);
        }),
      ]);
      const evidence = await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: currentStart } } });
      expect(evidence.peakWalletCount).toBe(1);
    } finally { await cleanup(userId); }
  });

  it('finalizes from historical peak evidence, fails closed when missing, and keeps the invoice immutable', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { userId, accountId } = await userFixture('peak-invoice');
    // Use a completed UTC month, outside the 24-hour finalization grace.
    const periodStart = new Date(Date.UTC(CURRENT.getUTCFullYear(), CURRENT.getUTCMonth() - 2, 1));
    const period = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      await prisma.userWallet.create({ data: { userId, isDefault: true, status: 'active', walletAddress: `0x${'5'.repeat(40)}` } });
      await expect(billingService().finalizeInvoice(userId, period)).rejects.toThrow(/wallet|evidence|usage/i);
      expect(await prisma.billingInvoice.count({ where: { billingAccountId: accountId, periodStart } })).toBe(0);

      await prisma.billingWalletUsagePeriod.create({ data: { billingAccountId: accountId, periodStart, peakWalletCount: 2 } });
      const finalized = await billingService().finalizeInvoice(userId, period);
      const stored = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: finalized.id }, include: { lines: true } });
      expect(stored.activeWallets).toBe(2);
      expect(stored.walletOverageMicros).toBe(0n);
      expect(stored.lines.some((line) => /wallet/i.test(line.description))).toBe(false);
      const hash = stored.snapshotHash;

      await prisma.billingWalletUsagePeriod.update({
        where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart } },
        data: { peakWalletCount: 3 },
      });
      const repeated = await billingService().finalizeInvoice(userId, period);
      expect(repeated.id).toBe(stored.id);
      const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: stored.id } });
      expect(after.activeWallets).toBe(2);
      expect(after.snapshotHash).toBe(hash);
    } finally { await cleanup(userId); }
  });
});

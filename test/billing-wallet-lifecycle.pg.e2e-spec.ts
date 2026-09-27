/**
 * Isolated PostgreSQL evidence for wallet quota serialization and peak carry.
 * Runs only with the runner-owned BILLING_E2E_* target; never uses DATABASE_URL.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { BillingEntitlementService } from '../src/modules/billing/billing-entitlement.service';
import { BillingWalletLifecycleService } from '../src/modules/billing/billing-wallet-lifecycle.service';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL ? resolveBillingE2eDatabaseTarget() : null;
const prisma = target ? new PrismaClient({ adapter: new PrismaPg(applyBillingE2eDatabaseUrl(target).url) }) : null;
const run = target ? describe : describe.skip;

function makeServices() {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const entitlements = new BillingEntitlementService(prisma as never);
  const lifecycle = new BillingWalletLifecycleService(prisma as never, entitlements);
  return { entitlements, lifecycle };
}

async function createUserAccount(prefix: string) {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, socialProvider: 'test', socialId: `${prefix}-${userId}` } });
  const account = await prisma.billingAccount.create({ data: { userId } });
  return { userId, accountId: account.id };
}

async function cleanup(userId: string) {
  if (!prisma) return;
  await prisma.walletProvisioningIntent.deleteMany({ where: { wallet: { userId } } });
  await prisma.userWallet.deleteMany({ where: { userId } });
  await prisma.billingAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

run('billing wallet lifecycle PostgreSQL concurrency', () => {
  beforeAll(async () => {
    if (!prisma || !target) throw new Error('runner-provisioned PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('serializes two reservations competing for one remaining quota slot', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { lifecycle } = makeServices();
    const { userId } = await createUserAccount('wallet-quota');
    try {
      // Free allows 10. Nine durable unresolved intents leave exactly one slot.
      for (let i = 0; i < 9; i += 1) {
        const wallet = await prisma.userWallet.create({ data: { userId, status: 'pending_embedded_wallet' } });
        await prisma.walletProvisioningIntent.create({ data: { walletId: wallet.id } });
      }
      const contenders = await Promise.all([0, 1].map(async () => {
        const walletId = randomUUID();
        try {
          await lifecycle.withWalletAccountLock(userId, async (tx, _accountId, now) => {
            await lifecycle.assertWalletReservationAllowed(tx, userId, walletId, now);
            await tx.userWallet.create({ data: { id: walletId, userId, status: 'pending_embedded_wallet' } });
            await tx.walletProvisioningIntent.create({ data: { walletId } });
          });
          return 'reserved';
        } catch (error) {
          if (error instanceof Error && error.message.includes('quota exceeded')) return 'rejected';
          throw error;
        }
      }));
      expect(contenders.filter((result) => result === 'reserved')).toHaveLength(1);
      expect(contenders.filter((result) => result === 'rejected')).toHaveLength(1);
      expect(await prisma.walletProvisioningIntent.count({ where: { wallet: { userId } } })).toBe(10);
    } finally {
      await cleanup(userId);
    }
  });

  it('records activation count/peak and carries opening count through an idle UTC month', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { lifecycle } = makeServices();
    const { userId, accountId } = await createUserAccount('wallet-peak');
    try {
      const now = new Date();
      const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const observedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 12));
      const middleMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      await prisma.billingAccount.update({ where: { id: accountId }, data: { eligibleWalletCount: 1, walletCountObservedAt: observedAt } });
      await prisma.userWallet.create({
        data: { userId, isDefault: true, status: 'active', walletAddress: `0x${'1'.repeat(40)}` },
      });
      const pending = await prisma.userWallet.create({ data: { userId, status: 'pending_embedded_wallet' } });
      await prisma.walletProvisioningIntent.create({ data: { walletId: pending.id, status: 'provisioned' } });

      await lifecycle.withWalletAccountLock(userId, async (tx, lockedAccountId, nowInTx) => {
        await tx.userWallet.update({ where: { id: pending.id }, data: { status: 'active', walletAddress: `0x${'2'.repeat(40)}` } });
        await tx.walletProvisioningIntent.update({ where: { walletId: pending.id }, data: { status: 'completed' } });
        await lifecycle.recordWalletActivation(tx, lockedAccountId, userId, nowInTx);
      });

      const account = await prisma.billingAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.eligibleWalletCount).toBe(2);
      expect(account.walletCountObservedAt).not.toBeNull();
      expect(await prisma.billingWalletUsagePeriod.count({ where: { billingAccountId: accountId, periodStart: currentMonth } })).toBe(1);
      expect((await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: currentMonth } } })).peakWalletCount).toBe(2);
      expect((await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: accountId, periodStart: middleMonth } } })).peakWalletCount).toBe(1);
    } finally {
      await cleanup(userId);
    }
  });

  it('initializes a legacy active wallet when reauthorization lazily creates its missing account', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const { lifecycle } = makeServices();
    const userId = randomUUID();
    await prisma.user.create({ data: { id: userId, socialProvider: 'test', socialId: `wallet-legacy-no-account-${userId}` } });
    try {
      await prisma.userWallet.create({
        data: { userId, isDefault: true, status: 'active', walletAddress: `0x${'3'.repeat(40)}` },
      });
      expect(await prisma.billingAccount.findUnique({ where: { userId } })).toBeNull();

      // Models Auth's already-active reauthorization path: ensure/lock account,
      // then baseline existing eligible wallets without recording activation.
      await lifecycle.withWalletAccountLock(userId, async (tx, accountId, now) => {
        await lifecycle.initializeWalletCount(tx, accountId, userId, now);
      });

      const account = await prisma.billingAccount.findUniqueOrThrow({ where: { userId } });
      const currentMonth = new Date(Date.UTC(account.walletCountObservedAt!.getUTCFullYear(), account.walletCountObservedAt!.getUTCMonth(), 1));
      expect(account.eligibleWalletCount).toBe(1);
      expect(account.walletCountObservedAt).not.toBeNull();
      expect(await prisma.billingWalletUsagePeriod.count({ where: { billingAccountId: account.id } })).toBe(1);
      const peak = await prisma.billingWalletUsagePeriod.findUniqueOrThrow({ where: { billingAccountId_periodStart: { billingAccountId: account.id, periodStart: currentMonth } } });
      expect(peak.peakWalletCount).toBe(1);
      // Rollout observation is current-only; it must not create purported
      // pre-rollout monthly usage rows.
      expect(await prisma.billingWalletUsagePeriod.count({ where: { billingAccountId: account.id, periodStart: { lt: currentMonth } } })).toBe(0);
    } finally {
      await cleanup(userId);
    }
  });
});

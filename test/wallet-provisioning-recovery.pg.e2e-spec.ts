/** Real PostgreSQL race evidence for operator wallet-provisioning recovery. */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { bindProvisionedAccount } from '../src/modules/wallet-provisioning-recovery/bind-recovery';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL ? resolveBillingE2eDatabaseTarget() : null;
const prisma = target ? new PrismaClient({ adapter: new PrismaPg(applyBillingE2eDatabaseUrl(target).url) }) : null;
const run = target ? describe : describe.skip;
const sharedAddress = '0x00000000000000000000000000000000000000ab';
const account = { id: 'verified-provider-account', chainType: 'EVM', custody: 'Developer', address: sharedAddress };

async function setup(label: string) {
  if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
  const userId = randomUUID();
  const user = await prisma.user.create({ data: { id: userId, socialProvider: 'test', socialId: `${label}-${userId}` } });
  const wallet = await prisma.userWallet.create({ data: { userId: user.id, status: 'pending_embedded_wallet' } });
  const intent = await prisma.walletProvisioningIntent.create({ data: {
    walletId: wallet.id, status: 'uncertain', dispatchToken: `dispatch-${randomUUID()}`,
  } });
  return { userId, walletId: wallet.id, dispatchToken: intent.dispatchToken! };
}

async function cleanup(userIds: string[]) {
  if (!prisma) return;
  await prisma.securityEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.walletProvisioningIntent.deleteMany({ where: { wallet: { userId: { in: userIds } } } });
  await prisma.userWallet.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.billingAccount.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

run('wallet provisioning recovery PostgreSQL concurrency', () => {
  beforeAll(async () => {
    if (!prisma || !target) throw new Error('runner-provisioned PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('allows only one of two owners/intents to claim the same verified provider identity and audit', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const contenders = [await setup('recovery-a'), await setup('recovery-b')];
    try {
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const provider = { getAccount: async () => { arrived += 1; if (arrived === 2) release(); await barrier; return account; } };
      const results = await Promise.all(contenders.map(async (item) => {
        try {
          await bindProvisionedAccount(prisma, provider, () => `0x${'c'.repeat(64)}`, {
            ...item, accountId: account.id, operator: 'gate2-test', evidence: 'mocked-provider-response',
          });
          return 'bound';
        } catch (error) {
          if (error instanceof Error && /already assigned|unique constraint/i.test(error.message)) return 'rejected';
          throw error;
        }
      }));
      expect(results.sort()).toEqual(['bound', 'rejected']);
      const intents = await prisma.walletProvisioningIntent.findMany({ where: { walletId: { in: contenders.map((x) => x.walletId) } } });
      expect(intents.filter((x) => x.status === 'provisioned')).toHaveLength(1);
      expect(intents.filter((x) => x.status === 'uncertain')).toHaveLength(1);
      expect(intents.find((x) => x.status === 'uncertain')?.dispatchToken).toBe(contenders.find((x) => x.walletId === intents.find((i) => i.status === 'uncertain')?.walletId)?.dispatchToken);
      expect(await prisma.securityEvent.count({ where: { userId: { in: contenders.map((x) => x.userId) }, eventType: 'wallet.provisioning.recovered' } })).toBe(1);
    } finally { await cleanup(contenders.map((x) => x.userId)); }
  });

  it('rolls back identity binding when the audit insert fails', async () => {
    if (!prisma) throw new Error('runner-provisioned PostgreSQL target required');
    const item = await setup('recovery-audit-failure');
    const suffix = randomUUID().replace(/-/g, '');
    const functionName = `reject_recovery_audit_${suffix}`;
    const triggerName = `reject_recovery_audit_${suffix}`;
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'wallet.provisioning.recovered' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(bindProvisionedAccount(prisma, { getAccount: async () => account }, () => `0x${'d'.repeat(64)}`, {
        ...item, accountId: account.id, operator: 'gate2-test', evidence: 'mocked-provider-response',
      })).rejects.toThrow('injected audit failure');
      const intent = await prisma.walletProvisioningIntent.findUniqueOrThrow({ where: { walletId: item.walletId } });
      const wallet = await prisma.userWallet.findUniqueOrThrow({ where: { id: item.walletId } });
      expect(intent.status).toBe('uncertain');
      expect(intent.agentOpenfortAccountId).toBeNull();
      expect(wallet.agentOpenfortAccountId).toBeNull();
      expect(await prisma.securityEvent.count({ where: { userId: item.userId, eventType: 'wallet.provisioning.recovered' } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON security_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await cleanup([item.userId]);
    }
  });
});

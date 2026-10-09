/** Real PostgreSQL evidence for the signing-budget acceptance transaction only. */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client as Pg } from 'pg';
import { PolymarketSigningBudgetService } from '../src/modules/wallet/polymarket-signing-budget.service';
import { SecurityEventService } from '../src/modules/security-events/security-event.service';
import { applyBillingE2eDatabaseUrl, assertBillingE2eDatabaseIdentity, queryBillingE2eIdentityWithPrisma, resolveBillingE2eDatabaseTarget } from './billing-e2e-database';

const target = applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget());
const prisma = new PrismaClient({ adapter: new PrismaPg(target.url) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const events = new SecurityEventService(prisma as never, { getRequestId: () => null } as never);
const budget = new PolymarketSigningBudgetService(events);

async function fixture(label: string) {
  const suffix = randomUUID().replace(/-/g, '');
  const user = await prisma.user.create({ data: { socialProvider: 'poly-budget-test', socialId: `${label}-${suffix}` } });
  const address = suffix.padEnd(40, 'a').slice(0, 40);
  const wallet = await prisma.userWallet.create({ data: {
    userId: user.id, status: 'active', walletAddress: `0x${address}`,
    openfortAccountId: `embedded-${suffix}`, agentWalletAddress: `0x${address}`,
  } });
  const keys = await Promise.all([0, 1].map((n) => prisma.apiKey.create({ data: {
    userId: user.id, apiKeyHash: `unused-${suffix}-${n}`, keyPrefix: `sk_${suffix.slice(0, 20)}${n}`,
    canSign: true, canUseEoaExecution: true, allowedIps: [], expiresAt: new Date(Date.now() + 60_000),
  } })));
  return { user, wallet, keys };
}

async function clean(userId: string) {
  await prisma.signingRequest.deleteMany({ where: { userId } });
  await prisma.securityEvent.deleteMany({ where: { userId } });
  await prisma.apiKey.deleteMany({ where: { userId } });
  await prisma.userWallet.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

async function accept(walletId: string, userId: string, apiKeyId: string, tag: string) {
  return prisma.$transaction(async (tx) => {
    await budget.acquireWalletLock(tx, walletId);
    const event = await budget.recordAcceptedInTransaction(tx, { walletId, userId, apiKeyId });
    const signingRequest = await tx.signingRequest.create({ data: {
      userId, apiKeyId, apiKeyPrefix: tag, type: 'typed_data', chainId: 137n,
      walletAddress: `0x${'1'.repeat(40)}`, requestHash: randomUUID().replace(/-/g, '').slice(0, 64),
      digest: `0x${'2'.repeat(64)}`,
    } });
    return { event, signingRequest };
  }, { isolationLevel: 'ReadCommitted' });
}

describe('Polymarket signing budget PostgreSQL acceptance scope', () => {
  jest.setTimeout(90_000);
  beforeAll(async () => {
    await prisma.$connect();
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('serializes concurrent API keys at 59 accepted, observes the actual waiter, and persists exactly 60', async () => {
    const f = await fixture('race');
    const holder = new Pg({ connectionString: target.url });
    const observer = new Pg({ connectionString: target.url });
    await holder.connect(); await observer.connect();
    try {
      await prisma.securityEvent.createMany({ data: Array.from({ length: 59 }, (_, i) => ({
        actorType: 'api_key', userId: f.user.id, apiKeyId: f.keys[i % 2].id, walletId: f.wallet.id,
        eventType: 'polymarket_order_signing_accepted', result: 'allowed', reason: 'seeded_budget_evidence',
        createdAt: new Date(Date.now() - 1_000),
      })) });

      await holder.query('BEGIN');
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`polymarket_order_signing_wallet:${f.wallet.id}`]);
      const attempts = [0, 1].map((i) => accept(f.wallet.id, f.user.id, f.keys[i].id, f.keys[i].keyPrefix));

      const deadline = Date.now() + 20_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const activity = await observer.query('SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
        if (activity.rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(holderPid))) { blocked = true; break; }
        await wait(20);
      }
      expect(blocked).toBe(true);
      await holder.query('COMMIT');
      const results = await Promise.allSettled(attempts);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(rejected.reason).toMatchObject({ response: { code: 'POLYMARKET_SIGN_RATE_LIMITED' } });
      expect(await prisma.securityEvent.count({ where: { walletId: f.wallet.id, eventType: 'polymarket_order_signing_accepted' } })).toBe(60);
      expect(await prisma.signingRequest.count({ where: { userId: f.user.id } })).toBe(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end(); await observer.end(); await clean(f.user.id);
    }
  });

  it('does not serialize a different wallet behind the held wallet lock', async () => {
    const f = await fixture('wallet-isolation');
    const secondAddress = randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40);
    const second = await prisma.userWallet.create({ data: { userId: f.user.id, status: 'active', walletAddress: `0x${secondAddress}`, openfortAccountId: `embedded-${randomUUID()}`, agentWalletAddress: `0x${secondAddress}` } });
    const holder = new Pg({ connectionString: target.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`polymarket_order_signing_wallet:${f.wallet.id}`]);
      await expect(accept(second.id, f.user.id, f.keys[0].id, f.keys[0].keyPrefix)).resolves.toBeDefined();
      await holder.query('ROLLBACK');
    } finally { await holder.query('ROLLBACK').catch(() => undefined); await holder.end(); await clean(f.user.id); }
  });

  it('timestamps and evaluates the rolling cutoff at post-lock acceptance, not transaction start', async () => {
    const f = await fixture('acceptance-clock');
    const holder = new Pg({ connectionString: target.url });
    const observer = new Pg({ connectionString: target.url });
    await holder.connect(); await observer.connect();
    try {
      // Establish the event boundary from PostgreSQL's clock, not the test host clock.
      const [{ seedAt }] = (await observer.query("SELECT clock_timestamp() - interval '59 seconds' AS \"seedAt\"")).rows as Array<{ seedAt: Date }>;
      await prisma.securityEvent.createMany({ data: Array.from({ length: 60 }, (_, i) => ({
        actorType: 'api_key', userId: f.user.id, apiKeyId: f.keys[i % 2].id, walletId: f.wallet.id,
        eventType: 'polymarket_order_signing_accepted', result: 'allowed', reason: 'acceptance_clock_seed',
        createdAt: seedAt,
      })) });

      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`polymarket_order_signing_wallet:${f.wallet.id}`]);
      let transactionStarted!: (date: Date) => void;
      const started = new Promise<Date>((resolve) => { transactionStarted = resolve; });
      const acceptance = prisma.$transaction(async (tx) => {
        const [{ startedAt }] = await tx.$queryRaw<Array<{ startedAt: Date }>>`SELECT transaction_timestamp() AS "startedAt"`;
        transactionStarted(startedAt);
        await budget.acquireWalletLock(tx, f.wallet.id);
        const event = await budget.recordAcceptedInTransaction(tx, { walletId: f.wallet.id, userId: f.user.id, apiKeyId: f.keys[0].id });
        const signingRequest = await tx.signingRequest.create({ data: {
          userId: f.user.id, apiKeyId: f.keys[0].id, apiKeyPrefix: f.keys[0].keyPrefix,
          type: 'typed_data', chainId: 137n, walletAddress: `0x${'5'.repeat(40)}`,
          requestHash: randomUUID().replace(/-/g, ''), digest: `0x${'6'.repeat(64)}`,
        } });
        return { event, signingRequest };
      }, { isolationLevel: 'ReadCommitted' });
      const transactionStart = await started;
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const deadline = Date.now() + 20_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const activity = await observer.query('SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
        if (activity.rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(holderPid))) { blocked = true; break; }
        await wait(20);
      }
      expect(blocked).toBe(true);
      // The seed is now older than the 60s acceptance window, but was still inside
      // the window when the blocked READ COMMITTED transaction began.
      await wait(1_700);
      const [{ releaseBefore }] = (await holder.query('SELECT clock_timestamp() AS "releaseBefore"')).rows as Array<{ releaseBefore: Date }>;
      await holder.query('COMMIT');
      const accepted = await acceptance;
      expect(transactionStart.getTime()).toBeLessThan(seedAt.getTime() + 60_000);
      const persistedEvent = accepted.event as { createdAt: Date };
      expect(persistedEvent.createdAt.getTime()).toBeGreaterThan(releaseBefore.getTime());
      expect(persistedEvent.createdAt.getTime()).toBeGreaterThan(transactionStart.getTime());
      expect(await prisma.securityEvent.count({ where: { walletId: f.wallet.id, eventType: 'polymarket_order_signing_accepted', createdAt: { gt: releaseBefore } } })).toBe(1);
      expect(await prisma.signingRequest.count({ where: { userId: f.user.id } })).toBe(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end(); await observer.end(); await clean(f.user.id);
    }
  });

  it('rolls back event and SigningRequest together, while committed acceptance survives provider failure marking', async () => {
    const f = await fixture('rollback-provider-failure');
    try {
      await expect(prisma.$transaction(async (tx) => {
        await budget.acquireWalletLock(tx, f.wallet.id);
        await budget.recordAcceptedInTransaction(tx, { walletId: f.wallet.id, userId: f.user.id, apiKeyId: f.keys[0].id });
        await tx.signingRequest.create({ data: { userId: f.user.id, apiKeyId: f.keys[0].id, type: 'typed_data', chainId: 137n, walletAddress: `0x${'3'.repeat(40)}`, requestHash: 'rollback-request', digest: `0x${'4'.repeat(64)}` } });
        throw new Error('forced transaction rollback');
      }, { isolationLevel: 'ReadCommitted' })).rejects.toThrow('forced transaction rollback');
      expect(await prisma.securityEvent.count({ where: { walletId: f.wallet.id, eventType: 'polymarket_order_signing_accepted' } })).toBe(0);
      expect(await prisma.signingRequest.count({ where: { userId: f.user.id } })).toBe(0);

      const accepted = await accept(f.wallet.id, f.user.id, f.keys[0].id, f.keys[0].keyPrefix);
      await prisma.signingRequest.update({ where: { id: accepted.signingRequest.id }, data: { status: 'failed', completedAt: new Date() } });
      expect(await prisma.securityEvent.count({ where: { walletId: f.wallet.id, eventType: 'polymarket_order_signing_accepted' } })).toBe(1);
      expect(await prisma.signingRequest.findUnique({ where: { id: accepted.signingRequest.id } })).toMatchObject({ status: 'failed' });
    } finally { await clean(f.user.id); }
  });
});

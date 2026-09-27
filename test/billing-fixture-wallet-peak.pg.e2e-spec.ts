/** End-to-end lifecycle evidence for signed billing fixtures on runner-owned PG. */
import { randomBytes, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
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

function monthOffset(months: number): { period: string; start: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return {
    period: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    start,
  };
}

function sanitizeDiagnostic(value: string, env: NodeJS.ProcessEnv): string {
  let safe = value.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-url>');
  for (const secret of [env.BILLING_FIXTURE_MANIFEST_KEY, env.BILLING_FIXTURE_DATABASE_URL, env.BILLING_E2E_DATABASE_URL]) {
    if (secret) safe = safe.split(secret).join('<redacted>');
  }
  return safe.slice(0, 4096);
}

function runFixture(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve('node_modules/ts-node/dist/bin.js'),
      '--transpile-only',
      'scripts/billing-fixture.ts',
      ...args,
    ], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 4096) stdout += chunk.slice(0, 4096 - stdout.length);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 1,
      stdout: sanitizeDiagnostic(stdout, env),
      stderr: sanitizeDiagnostic(stderr, env),
    }));
  });
}

run('billing fixture wallet peak PostgreSQL lifecycle', () => {
  beforeAll(async () => {
    if (!prisma || !target) throw new Error('runner-provisioned PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('seeds, verifies, cleans only owned peak evidence, then reseeds', async () => {
    const fixtureId = `fx-${randomUUID()}`;
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const { period, start } = monthOffset(3);
    const manifestPath = path.join(os.tmpdir(), `${fixtureId}.json`);
    const fixtureKey = randomBytes(32).toString('hex');
    let planVersionId: string | undefined;
    try {
      await prisma!.user.create({ data: { id: userId, socialProvider: 'test', socialId: fixtureId } });
      const account = await prisma!.billingAccount.create({ data: { userId, currency: 'USD' } });
      await prisma!.user.create({ data: { id: otherUserId, socialProvider: 'test', socialId: `${fixtureId}-other` } });
      const otherAccount = await prisma!.billingAccount.create({ data: { userId: otherUserId, currency: 'USD' } });
      const nonOwned = await prisma!.billingWalletUsagePeriod.create({
        data: { billingAccountId: otherAccount.id, periodStart: start, peakWalletCount: 7 },
      });
      const plan = await prisma!.billingPlanVersion.create({
        data: {
          code: 'starter', version: 1, name: `Fixture ${fixtureId}`,
          monthlyFeeMicros: 1_000_000n, includedOutboundMicros: 0n, includedApiCalls: 0n,
          includedWallets: 0, apiOverageRateMicros: 0n, walletOverageRateMicros: 10000n,
          effectiveFrom: new Date(0),
          tiers: { create: [{ lowerBoundMicros: 0n, upperBoundMicros: null, ratePpm: 0 }] },
        },
      });
      planVersionId = plan.id;

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        BILLING_FIXTURE_ENABLED: 'true',
        BILLING_FIXTURE_DISPOSABLE_DB: 'true',
        BILLING_FIXTURE_DATABASE_URL: target!.url,
        BILLING_FIXTURE_MANIFEST_KEY: fixtureKey,
      };
      const cli = (command: 'seed' | 'verify' | 'cleanup') => [
        command, '--user-id', userId, '--periods', period, '--fixture-id', fixtureId,
        '--plan-code', 'starter', '--manifest', manifestPath, '--apply',
      ];
      const assertOk = async (command: 'seed' | 'verify' | 'cleanup') => {
        const result = await runFixture(cli(command), env);
        if (result.code !== 0) throw new Error(
          `billing fixture ${command} exited ${result.code}: ${result.stderr || '(no stderr)'}\n${result.stdout}`,
        );
      };

      await assertOk('seed');
      let owned = await prisma!.billingWalletUsagePeriod.findUniqueOrThrow({
        where: { billingAccountId_periodStart: { billingAccountId: account.id, periodStart: start } },
      });
      const invoice = await prisma!.billingInvoice.findFirstOrThrow({
        where: { billingAccountId: account.id, periodStart: start, purpose: 'usage_period' },
        include: { lines: true },
      });
      const snapshot = invoice.snapshotJson as { plan: { walletOverageRateMicros: string } };
      expect(snapshot.plan.walletOverageRateMicros).toBe('0');
      await assertOk('verify');
      expect(await prisma!.billingWalletUsagePeriod.findUnique({ where: { id: nonOwned.id } })).toMatchObject({ id: nonOwned.id, peakWalletCount: 7 });

      await assertOk('cleanup');
      expect(await prisma!.billingWalletUsagePeriod.findUnique({ where: { id: owned.id } })).toBeNull();
      expect(await prisma!.billingWalletUsagePeriod.findUnique({ where: { id: nonOwned.id } })).toMatchObject({ id: nonOwned.id, peakWalletCount: 7 });
      expect(await prisma!.billingInvoice.findUnique({ where: { id: invoice.id } })).toBeNull();

      fs.unlinkSync(manifestPath);
      await assertOk('seed');
      owned = await prisma!.billingWalletUsagePeriod.findUniqueOrThrow({
        where: { billingAccountId_periodStart: { billingAccountId: account.id, periodStart: start } },
      });
      expect(owned.peakWalletCount).toBe(0);
      await assertOk('verify');
      await assertOk('cleanup');
      expect(await prisma!.billingWalletUsagePeriod.findUnique({ where: { id: owned.id } })).toBeNull();
      expect(await prisma!.billingWalletUsagePeriod.findUnique({ where: { id: nonOwned.id } })).not.toBeNull();

      const noIdentityEnv = { ...env };
      for (const key of [
        'BILLING_E2E_PROVISIONED', 'BILLING_E2E_DISPOSABLE_DB', 'BILLING_E2E_RUN_ID',
        'BILLING_E2E_EXPECTED_DATABASE', 'BILLING_E2E_EXPECTED_USER',
        'BILLING_E2E_EXPECTED_OWNER', 'BILLING_E2E_APPLICATION_NAME',
      ]) delete noIdentityEnv[key];
      const rejected = await runFixture(cli('seed'), noIdentityEnv);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('runner_isolated_database_required');
    } finally {
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      await prisma!.billingInvoiceLine.deleteMany({ where: { invoice: { billingAccount: { userId } } } });
      await prisma!.billingInvoice.deleteMany({ where: { billingAccount: { userId } } });
      await prisma!.billingUsageEvent.deleteMany({ where: { billingAccount: { userId } } });
      await prisma!.billingWalletUsagePeriod.deleteMany({ where: { billingAccount: { userId } } });
      await prisma!.billingPlanAssignment.deleteMany({ where: { billingAccount: { userId } } });
      await prisma!.billingWalletUsagePeriod.deleteMany({ where: { billingAccount: { userId: otherUserId } } });
      await prisma!.billingAccount.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
      await prisma!.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      if (planVersionId) await prisma!.billingPlanVersion.delete({ where: { id: planVersionId } });
    }
  }, 120_000);
});

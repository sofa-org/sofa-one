/**
 * Real-PostgreSQL lock evidence for BILL-016 direct-egress acceptance.
 *
 * Uses explicit `pg.Client` sessions (BEGIN / SELECT … FOR UPDATE / COMMIT) so
 * backend PIDs are stable and `pg_blocking_pids(waiter)` can prove a real wait.
 * Prisma interactive transactions are not used for the race itself — they can
 * hide blocked backends until query resolution.
 *
 * Evidence (not full Nest HTTP race):
 *  1) Revoke holds api_keys FOR UPDATE → send FOR UPDATE blocked (pg_blocking_pids)
 *     → revoke COMMIT → send reads revoked=true.
 *  2) Send holds FOR UPDATE → revoke blocked → send COMMIT → revoke proceeds.
 *  3) Destination advisory: add holds → send blocked → add COMMIT → send sees row.
 *
 * Runner-owned BILLING_E2E_* DB only. Run via `npm run test:e2e:billing`.
 */
import { randomUUID, createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';

const billingE2eDb = applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget());
const SUITE = randomUUID().replace(/-/g, '').slice(0, 12);

type PgClient = {
  connect: () => Promise<void>;
  end: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type PgClientCtor = new (config: { connectionString: string }) => PgClient;

function loadPg(): PgClientCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('pg') as { Client: PgClientCtor }).Client;
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function safeResolve(d: Deferred) {
  try {
    d.resolve();
  } catch {
    /* settled */
  }
}

describe('API-key direct-egress concurrency (real PostgreSQL locks)', () => {
  jest.setTimeout(90_000);

  const Client = loadPg();
  let seedPrisma: PrismaClient;
  let observer: PgClient;
  let dbIdentityVerified = false;

  beforeAll(async () => {
    seedPrisma = new PrismaClient({ adapter: new PrismaPg(billingE2eDb.url) });
    await seedPrisma.$connect();
    await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
      queryBillingE2eIdentityWithPrisma(seedPrisma),
    );
    observer = new Client({ connectionString: billingE2eDb.url });
    await observer.connect();
    dbIdentityVerified = true;
  });

  afterAll(async () => {
    try {
      if (dbIdentityVerified) {
        await cleanupAll(seedPrisma);
      }
    } finally {
      await observer?.end().catch(() => undefined);
      await seedPrisma?.$disconnect().catch(() => undefined);
    }
  });

  it('revoke holds FOR UPDATE: send is blocked (pg_blocking_pids), then reads revoked=true', async () => {
    if (!dbIdentityVerified) throw new Error('identity unverified');
    const { userId, keyId } = await seedUserAndKey(seedPrisma, 'revoke-first');

    const holder = new Client({ connectionString: billingE2eDb.url });
    const waiter = new Client({ connectionString: billingE2eDb.url });
    await holder.connect();
    await waiter.connect();

    const holderReady = deferred();
    const waiterBlocked = deferred();

    let holderPid = 0;
    let waiterPid = 0;

    try {
      const holderWork = (async () => {
        try {
          await holder.query('BEGIN');
          const pidRes = await holder.query('SELECT pg_backend_pid() AS pid');
          holderPid = Number(pidRes.rows[0]!.pid);

          const lockRes = await holder.query(
            `SELECT id, revoked FROM api_keys WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
            [keyId, userId],
          );
          expect(lockRes.rows).toHaveLength(1);
          expect(lockRes.rows[0]!.revoked).toBe(false);

          holderReady.resolve();
          await waiterBlocked.promise;

          await holder.query(
            `UPDATE api_keys SET revoked = true WHERE id = $1::uuid AND user_id = $2::uuid AND revoked = false`,
            [keyId, userId],
          );
          await holder.query('COMMIT');
          return 'revoked';
        } catch (err) {
          await holder.query('ROLLBACK').catch(() => undefined);
          holderReady.reject(err);
          waiterBlocked.reject(err);
          throw err;
        }
      })();

      const waiterWork = (async () => {
        try {
          await holderReady.promise;
          await waiter.query('BEGIN');
          const pidRes = await waiter.query('SELECT pg_backend_pid() AS pid');
          waiterPid = Number(pidRes.rows[0]!.pid);
          expect(waiterPid).not.toBe(holderPid);

          // Start FOR UPDATE without awaiting — must block on holder.
          const lockPromise = waiter.query(
            `SELECT revoked, user_id FROM api_keys WHERE id = $1::uuid FOR UPDATE`,
            [keyId],
          );

          await waitUntilBlockedBy(observer, waiterPid, holderPid, 20_000);
          waiterBlocked.resolve();

          const rows = await lockPromise;
          expect(rows.rows[0]!.revoked).toBe(true);
          expect(rows.rows[0]!.user_id).toBe(userId);
          await waiter.query('COMMIT');
          return rows.rows[0];
        } catch (err) {
          await waiter.query('ROLLBACK').catch(() => undefined);
          waiterBlocked.reject(err);
          throw err;
        }
      })();

      const [holderResult, sendRow] = await Promise.all([holderWork, waiterWork]);
      expect(holderResult).toBe('revoked');
      expect(sendRow?.revoked).toBe(true);

      const final = await seedPrisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
      expect(final.revoked).toBe(true);
    } finally {
      safeResolve(holderReady);
      safeResolve(waiterBlocked);
      await holder.end().catch(() => undefined);
      await waiter.end().catch(() => undefined);
    }
  });

  it('send holds FOR UPDATE: revoke is blocked until acceptance commits', async () => {
    if (!dbIdentityVerified) throw new Error('identity unverified');
    const { userId, keyId } = await seedUserAndKey(seedPrisma, 'send-first');

    const holder = new Client({ connectionString: billingE2eDb.url });
    const waiter = new Client({ connectionString: billingE2eDb.url });
    await holder.connect();
    await waiter.connect();

    const holderReady = deferred();
    const waiterBlocked = deferred();

    let holderPid = 0;
    let waiterPid = 0;

    try {
      const holderWork = (async () => {
        try {
          await holder.query('BEGIN');
          const pidRes = await holder.query('SELECT pg_backend_pid() AS pid');
          holderPid = Number(pidRes.rows[0]!.pid);

          const lockRes = await holder.query(
            `SELECT revoked FROM api_keys WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
            [keyId, userId],
          );
          expect(lockRes.rows[0]!.revoked).toBe(false);

          holderReady.resolve();
          await waiterBlocked.promise;
          // Acceptance done under lock (no provider).
          await holder.query('COMMIT');
          return 'accepted';
        } catch (err) {
          await holder.query('ROLLBACK').catch(() => undefined);
          holderReady.reject(err);
          waiterBlocked.reject(err);
          throw err;
        }
      })();

      const waiterWork = (async () => {
        try {
          await holderReady.promise;
          await waiter.query('BEGIN');
          const pidRes = await waiter.query('SELECT pg_backend_pid() AS pid');
          waiterPid = Number(pidRes.rows[0]!.pid);
          expect(waiterPid).not.toBe(holderPid);

          const lockPromise = waiter.query(
            `SELECT revoked FROM api_keys WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
            [keyId, userId],
          );

          await waitUntilBlockedBy(observer, waiterPid, holderPid, 20_000);
          waiterBlocked.resolve();

          const rows = await lockPromise;
          expect(rows.rows[0]!.revoked).toBe(false);
          await waiter.query(
            `UPDATE api_keys SET revoked = true WHERE id = $1::uuid AND user_id = $2::uuid`,
            [keyId, userId],
          );
          await waiter.query('COMMIT');
          return 'revoked-after-wait';
        } catch (err) {
          await waiter.query('ROLLBACK').catch(() => undefined);
          waiterBlocked.reject(err);
          throw err;
        }
      })();

      const [sendResult, revokeResult] = await Promise.all([holderWork, waiterWork]);
      expect(sendResult).toBe('accepted');
      expect(revokeResult).toBe('revoked-after-wait');

      const final = await seedPrisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
      expect(final.revoked).toBe(true);
    } finally {
      safeResolve(holderReady);
      safeResolve(waiterBlocked);
      await holder.end().catch(() => undefined);
      await waiter.end().catch(() => undefined);
    }
  });

  it('destination advisory lock: send blocked until allowlist add commits', async () => {
    if (!dbIdentityVerified) throw new Error('identity unverified');
    const { userId } = await seedUserAndKey(seedPrisma, 'dest-adv');
    await seedPrisma.withdrawalPolicy.create({
      data: {
        userId,
        requireAddressAllowlist: true,
        newAddressCooldownHours: 24,
      },
    });

    const DEST = '0x2222222222222222222222222222222222222222';
    const lockKey = `withdrawal_dest:${userId}`;

    const holder = new Client({ connectionString: billingE2eDb.url });
    const waiter = new Client({ connectionString: billingE2eDb.url });
    await holder.connect();
    await waiter.connect();

    const holderReady = deferred();
    const waiterBlocked = deferred();

    let holderPid = 0;
    let waiterPid = 0;

    try {
      const addWork = (async () => {
        try {
          await holder.query('BEGIN');
          const pidRes = await holder.query('SELECT pg_backend_pid() AS pid');
          holderPid = Number(pidRes.rows[0]!.pid);
          await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
          holderReady.resolve();
          await waiterBlocked.promise;
          await holder.query(
            `INSERT INTO withdrawal_addresses (id, user_id, address, available_at, created_at)
             VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, NOW())`,
            [randomUUID(), userId, DEST.toLowerCase(), new Date(Date.now() - 1_000).toISOString()],
          );
          await holder.query('COMMIT');
          return 'added';
        } catch (err) {
          await holder.query('ROLLBACK').catch(() => undefined);
          holderReady.reject(err);
          waiterBlocked.reject(err);
          throw err;
        }
      })();

      const sendWork = (async () => {
        try {
          await holderReady.promise;
          await waiter.query('BEGIN');
          const pidRes = await waiter.query('SELECT pg_backend_pid() AS pid');
          waiterPid = Number(pidRes.rows[0]!.pid);
          expect(waiterPid).not.toBe(holderPid);

          const lockPromise = waiter.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

          await waitUntilBlockedBy(observer, waiterPid, holderPid, 20_000);
          waiterBlocked.resolve();

          await lockPromise;
          const row = await waiter.query(
            `SELECT address FROM withdrawal_addresses WHERE user_id = $1::uuid AND address = $2`,
            [userId, DEST.toLowerCase()],
          );
          expect(row.rows).toHaveLength(1);
          await waiter.query('COMMIT');
          return row.rows[0];
        } catch (err) {
          await waiter.query('ROLLBACK').catch(() => undefined);
          waiterBlocked.reject(err);
          throw err;
        }
      })();

      const [addResult, seen] = await Promise.all([addWork, sendWork]);
      expect(addResult).toBe('added');
      expect(seen?.address).toBe(DEST.toLowerCase());
    } finally {
      safeResolve(holderReady);
      safeResolve(waiterBlocked);
      await holder.end().catch(() => undefined);
      await waiter.end().catch(() => undefined);
    }
  });
});

/**
 * Prove `waiterPid` is blocked by `holderPid` using parameterized pg_blocking_pids only.
 * Success requires holderPid ∈ pg_blocking_pids(waiterPid). No ungranted-lock fallback.
 */
async function waitUntilBlockedBy(
  observer: PgClient,
  waiterPid: number,
  holderPid: number,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isInteger(waiterPid) || waiterPid <= 0) {
    throw new Error('invalid waiterPid');
  }
  if (!Number.isInteger(holderPid) || holderPid <= 0) {
    throw new Error('invalid holderPid');
  }
  if (waiterPid === holderPid) {
    throw new Error('holder and waiter PIDs must be distinct');
  }

  const start = Date.now();
  let lastDiag = 'no samples';
  while (Date.now() - start < timeoutMs) {
    const blocked = await observer.query(
      `SELECT pg_blocking_pids($1::int) AS blockers,
              (SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1::int) AS wait_event_type,
              (SELECT wait_event FROM pg_stat_activity WHERE pid = $1::int) AS wait_event,
              (SELECT state FROM pg_stat_activity WHERE pid = $1::int) AS state,
              EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1::int AND NOT granted) AS lock_waiting`,
      [waiterPid],
    );
    const row = blocked.rows[0] ?? {};
    const blockers = (row.blockers as number[] | null) ?? [];
    lastDiag = JSON.stringify({
      waiterPid,
      holderPid,
      blockers,
      wait_event_type: row.wait_event_type,
      wait_event: row.wait_event,
      state: row.state,
      lock_waiting: row.lock_waiting,
    });

    if (Array.isArray(blockers) && blockers.includes(holderPid)) {
      return;
    }

    await sleep(15);
  }
  throw new Error(
    `waiter pid=${waiterPid} was not blocked by holder pid=${holderPid} within ${timeoutMs}ms (pg_blocking_pids required); last=${lastDiag}`,
  );
}

async function seedUserAndKey(prisma: PrismaClient, label: string) {
  const socialId = `deg_conc_${label}_${SUITE}`;
  const user = await prisma.user.create({
    data: {
      socialProvider: 'google',
      socialId,
      email: `${socialId}@example.com`,
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const argon2 = require('argon2') as typeof import('argon2');
  const rawKey = `sk_${createHash('sha256').update(socialId).digest('hex')}`;
  const hash = await argon2.hash(rawKey, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
  const key = await prisma.apiKey.create({
    data: {
      userId: user.id,
      apiKeyHash: hash,
      keyPrefix: rawKey.slice(0, 27),
      name: `conc-${label}`,
      canSendTransaction: true,
      canSign: false,
      canReadTransactionStatus: true,
      canUseEoaExecution: false,
      allowedIps: ['127.0.0.1'],
      directEgressPolicyAcceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { userId: user.id, keyId: key.id, rawKey };
}

async function cleanupAll(prisma: PrismaClient) {
  await prisma.withdrawalAddress.deleteMany().catch(() => undefined);
  await prisma.withdrawalPolicy.deleteMany().catch(() => undefined);
  await prisma.apiKeyEvent.deleteMany().catch(() => undefined);
  await prisma.apiKey.deleteMany().catch(() => undefined);
  await prisma.user.deleteMany().catch(() => undefined);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

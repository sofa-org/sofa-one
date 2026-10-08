/** Real PostgreSQL race exercising the TransactionsService acceptance path. */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client as Pg } from 'pg';
import { encodeFunctionData, type Hex } from 'viem';
jest.mock('../src/core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
import { applyBillingE2eDatabaseUrl, assertBillingE2eDatabaseIdentity, queryBillingE2eIdentityWithPrisma, resolveBillingE2eDatabaseTarget } from './billing-e2e-database';
import { TransactionsService } from '../src/modules/transactions/transactions.service';
import { WithdrawalDestinationPolicyService } from '../src/modules/withdrawal-destination/withdrawal-destination-policy.service';
import { POLYMARKET_PUSD_WRAP_ABI, POLYMARKET_PUSD_WRAP_IDENTITY } from '../src/modules/defi/execution/pusd-identity';

const target = applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget());
const DEST = '0x2222222222222222222222222222222222222222';
const LOCK = (userId: string) => `withdrawal_dest:${userId}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


describe('Polymarket pUSD destination mutation race (PostgreSQL)', () => {
  jest.setTimeout(90_000);
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg(target.url) });
    await prisma.$connect();
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prisma));
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('waits on the actual destination advisory lock and denies after concurrent recipient removal', async () => {
    const suffix = randomUUID().replace(/-/g, '');
    const user = await prisma.user.create({ data: { socialProvider: 'google', socialId: `pusd_race_${suffix}`, email: `pusd_${suffix}@example.test` } });
    const key = await prisma.apiKey.create({ data: {
      userId: user.id, apiKeyHash: 'test-hash-not-used', keyPrefix: `sk_${suffix.slice(0, 24)}`,
      canSendTransaction: true, canSign: false, canReadTransactionStatus: true, canUseEoaExecution: false,
      allowedIps: [], directEgressPolicyAcceptedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } });
    await prisma.withdrawalPolicy.create({ data: { userId: user.id, requireAddressAllowlist: true, newAddressCooldownHours: 24 } });
    await prisma.withdrawalAddress.create({ data: { userId: user.id, address: DEST, availableAt: new Date(Date.now() - 60_000) } });

    const holder = new Pg({ connectionString: target.url });
    const observer = new Pg({ connectionString: target.url });
    await holder.connect(); await observer.connect();
    const lockHeld = new Promise<void>((resolve) => { void (async () => {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK(user.id)]);
      resolve();
    })(); });

    let auditObservedReleasedDestinationLock = false;
    const events = { record: jest.fn().mockImplementation(async () => {
      const probe = await observer.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [LOCK(user.id)]);
      auditObservedReleasedDestinationLock = probe.rows[0]?.acquired === true;
    }) };
    const destinationPolicy = new WithdrawalDestinationPolicyService(prisma as any, events as any);
    const openfort = { sendUserOperation: jest.fn(), submitUserOperation: jest.fn(), sendBackendTransaction: jest.fn() };
    const defi = { assertStillAuthorized: jest.fn().mockResolvedValue(undefined), recordAllowedInTx: jest.fn() };
    const transactionPolicy = { assertSpendAllowedInTx: jest.fn().mockResolvedValue(undefined) };
    const service = new TransactionsService(prisma as any, openfort as any, transactionPolicy as any,
      {} as any, {} as any, destinationPolicy, defi as any, {} as any);

    const interaction = {
      to: POLYMARKET_PUSD_WRAP_IDENTITY.contract,
      data: encodeFunctionData({ abi: POLYMARKET_PUSD_WRAP_ABI, functionName: 'wrap', args: [POLYMARKET_PUSD_WRAP_IDENTITY.asset as Hex, DEST as Hex, 10n] }),
      value: '0',
    };
    const gate: any = {
      userId: user.id, destinations: [DEST], intents: [], fullyProvenDirectEgress: false, notProven: [],
      chainId: 137, walletId: 'wallet-unused', apiKeyId: key.id, apiKeyPrefix: key.keyPrefix,
      executionMode: 'session_key', restrictedWrap: true,
    };
    const authorization: any = { interactions: [interaction] };
    const createParams: any = {
      apiKeyId: key.id, apiKeyPrefix: key.keyPrefix, operationType: 'send', idempotencyKey: `pusd-${suffix}`,
      chainId: 137, requestHash: `req-${suffix}`, legacyRequestHash: `legacy-${suffix}`, walletId: 'wallet-unused',
      walletAddress: '0x1111111111111111111111111111111111111111', executionMode: 'session_key',
      details: { type: 'send', walletId: 'wallet-unused', executionMode: 'session_key' }, destinationGate: gate,
      defiAuthorization: authorization, nativeValueWei: '0',
    };

    try {
      await lockHeld;
      const acceptance = (service as any).createPendingOrReturnExisting(user.id, createParams);
      const deadline = Date.now() + 20_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const activity = await observer.query(`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name = current_setting('application_name') AND pid <> pg_backend_pid()`);
        // Prisma adapter connections share the target application name. Confirm a waiter is blocked specifically by holder PID.
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        if (activity.rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(holderPid))) { blocked = true; break; }
        await wait(20);
      }
      expect(blocked).toBe(true);
      await holder.query('DELETE FROM withdrawal_addresses WHERE user_id = $1::uuid AND address = $2', [user.id, DEST]);
      await holder.query('COMMIT');
      await expect(acceptance).rejects.toMatchObject({ response: { code: 'WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED' } });
      expect(events.record).toHaveBeenCalledTimes(1);
      expect(auditObservedReleasedDestinationLock).toBe(true);
      expect(await prisma.transaction.count({ where: { userId: user.id, idempotencyKey: createParams.idempotencyKey } })).toBe(0);
      expect(openfort.sendUserOperation).not.toHaveBeenCalled();
      expect(openfort.submitUserOperation).not.toHaveBeenCalled();
      expect(openfort.sendBackendTransaction).not.toHaveBeenCalled();
      expect(defi.assertStillAuthorized).not.toHaveBeenCalled();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end(); await observer.end();
      await prisma.transaction.deleteMany({ where: { userId: user.id } });
      await prisma.withdrawalAddress.deleteMany({ where: { userId: user.id } });
      await prisma.withdrawalPolicy.deleteMany({ where: { userId: user.id } });
      await prisma.apiKey.deleteMany({ where: { id: key.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('holds the acceptance lock through insert so a concurrent destination mutation waits until commit', async () => {
    const suffix = randomUUID().replace(/-/g, '');
    const user = await prisma.user.create({ data: { socialProvider: 'google', socialId: `pusd_hold_${suffix}`, email: `pusd_hold_${suffix}@example.test` } });
    const key = await prisma.apiKey.create({ data: {
      userId: user.id, apiKeyHash: 'test-hash-not-used', keyPrefix: `sk_${suffix.slice(0, 24)}`,
      canSendTransaction: true, canSign: false, canReadTransactionStatus: true, canUseEoaExecution: false,
      allowedIps: [], directEgressPolicyAcceptedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } });
    await prisma.withdrawalPolicy.create({ data: { userId: user.id, requireAddressAllowlist: true, newAddressCooldownHours: 24 } });
    await prisma.withdrawalAddress.create({ data: { userId: user.id, address: DEST, availableAt: new Date(Date.now() - 60_000) } });

    const mutation = new Pg({ connectionString: target.url });
    const observer = new Pg({ connectionString: target.url });
    await mutation.connect(); await observer.connect();
    let signalChecked!: () => void;
    let continueAcceptance!: () => void;
    const checked = new Promise<void>((resolve) => { signalChecked = resolve; });
    const release = new Promise<void>((resolve) => { continueAcceptance = resolve; });
    const destinationPolicy = new WithdrawalDestinationPolicyService(prisma as any, { record: jest.fn(), exportCommitted: jest.fn() } as any);
    const realAssert = destinationPolicy.assertDestinationsAllowed.bind(destinationPolicy);
    jest.spyOn(destinationPolicy, 'assertDestinationsAllowed').mockImplementation(async (...args: any[]) => {
      await realAssert(args[0], args[1], args[2], args[3]);
      if (args[3]?.prisma) { signalChecked(); await release; }
    });
    const openfort = { sendUserOperation: jest.fn(), submitUserOperation: jest.fn(), sendBackendTransaction: jest.fn() };
    const service = new TransactionsService(prisma as any, openfort as any,
      { assertSpendAllowedInTx: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any,
      destinationPolicy, { assertStillAuthorized: jest.fn().mockResolvedValue(undefined), recordAllowedInTx: jest.fn().mockResolvedValue(null) } as any,
      { exportCommitted: jest.fn() } as any);
    // Isolate destination serialization from the independent API-key row lock;
    // the first race above exercises the production destination gate itself.
    (service as any).assertDirectEgressKeyStateInTx = jest.fn().mockResolvedValue(undefined);
    const interaction = {
      to: POLYMARKET_PUSD_WRAP_IDENTITY.contract,
      data: encodeFunctionData({ abi: POLYMARKET_PUSD_WRAP_ABI, functionName: 'wrap', args: [POLYMARKET_PUSD_WRAP_IDENTITY.asset as Hex, DEST as Hex, 10n] }), value: '0',
    };
    const idempotencyKey = `pusd-held-${suffix}`;
    const createParams: any = {
      apiKeyId: key.id, apiKeyPrefix: key.keyPrefix, operationType: 'send', idempotencyKey,
      chainId: 137, requestHash: `req-${suffix}`, legacyRequestHash: `legacy-${suffix}`, walletId: 'wallet-unused',
      walletAddress: '0x1111111111111111111111111111111111111111', executionMode: 'session_key',
      details: { type: 'send', walletId: 'wallet-unused', executionMode: 'session_key' },
      destinationGate: { userId: user.id, destinations: [DEST], intents: [], fullyProvenDirectEgress: false, notProven: [], chainId: 137,
        walletId: 'wallet-unused', apiKeyId: key.id, apiKeyPrefix: key.keyPrefix, executionMode: 'session_key', restrictedWrap: true },
      defiAuthorization: { interactions: [interaction] }, nativeValueWei: '0',
    };
    const lockKey = LOCK(user.id);
    try {
      const acceptance = (service as any).createPendingOrReturnExisting(user.id, createParams);
      await checked;
      await mutation.query('BEGIN');
        const mutationPid = Number((await mutation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const mutationLock = mutation.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      const deadline = Date.now() + 20_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const row = await observer.query('SELECT pg_blocking_pids($1::int) AS blockers', [mutationPid]);
        if (Array.isArray(row.rows[0]?.blockers) && row.rows[0].blockers.length > 0) { blocked = true; break; }
        await wait(20);
      }
      expect(blocked).toBe(true);
      continueAcceptance();
      await expect(acceptance).resolves.toMatchObject({ created: true });
      await mutationLock;
      await mutation.query('DELETE FROM withdrawal_addresses WHERE user_id = $1::uuid AND address = $2', [user.id, DEST]);
      await mutation.query('COMMIT');
      expect(await prisma.transaction.count({ where: { userId: user.id, idempotencyKey } })).toBe(1);
      expect(openfort.sendUserOperation).not.toHaveBeenCalled();
    } finally {
      continueAcceptance();
      await mutation.query('ROLLBACK').catch(() => undefined);
      await mutation.end(); await observer.end();
      await prisma.transaction.deleteMany({ where: { userId: user.id } });
      await prisma.withdrawalAddress.deleteMany({ where: { userId: user.id } });
      await prisma.withdrawalPolicy.deleteMany({ where: { userId: user.id } });
      await prisma.apiKey.deleteMany({ where: { id: key.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

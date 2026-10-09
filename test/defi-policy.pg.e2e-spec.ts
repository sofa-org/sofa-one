import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'crypto';
import { Client as Pg } from 'pg';
type PgClient = Pg;
import { encodeFunctionData, parseAbi } from 'viem';

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { TransactionsService } from '../src/modules/transactions/transactions.service';
import { TransactionPolicyService } from '../src/modules/transactions/transaction-policy.service';
import { extractDirectTransferIntents, uniqueDirectTransferDestinations } from '../src/modules/transactions/direct-transfer-intents';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';
import { DefiCatalogService } from '../src/modules/defi/defi-catalog.service';
import { DefiPolicyService } from '../src/modules/defi/defi-policy.service';
import { DefiPauseService } from '../src/modules/defi/defi-pause.service';
import { DefiGrantService } from '../src/modules/defi/defi-grant.service';
import { SecurityEventService } from '../src/modules/security-events/security-event.service';
import { ApiKeyService } from '../src/modules/api-key/api-key.service';
import { buildReviewedManifest, functionAbiHash } from '../src/modules/defi/registry/defi-manifest';
import type { DefiAuthorization, DefiCatalog } from '../src/modules/defi/defi.types';

const target = applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget());
const suiteId = randomBytes(6).toString('hex');
const capabilityId = `cap:pg-test:${suiteId}:v1`;
const approvalCapabilityId = `${capabilityId}:approve`;
const borrowCapabilityId = `${capabilityId}:borrow`;
const payableCapabilityId = `${capabilityId}:pay`;
const transferCapabilityId = `${capabilityId}:transfer`;
const npmWrapperId = `${capabilityId}:npm-wrapper`;
const npmChildIds = Array.from({ length: 8 }, (_, index) => `${capabilityId}:npm-child:${index}`);
const address = '0x1111111111111111111111111111111111111111' as const;
const abi = { type: 'function', name: 'ping', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] } as const;
const abiFunction = (name: string, stateMutability: 'nonpayable' | 'payable', inputs: { name: string; type: string }[]) => ({ type: 'function' as const, name, stateMutability, inputs, outputs: [] as const });
const fixtureFunctions = [
  { capabilityId, functionName: 'ping', signature: 'ping(uint256)', abi },
  { capabilityId: approvalCapabilityId, functionName: 'approve', signature: 'approve(address,uint256)', abi: abiFunction('approve', 'nonpayable', [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }]) },
  { capabilityId: borrowCapabilityId, functionName: 'borrow', signature: 'borrow(address,uint256,uint256,uint16,address)', abi: abiFunction('borrow', 'nonpayable', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'referralCode', type: 'uint16' }, { name: 'onBehalfOf', type: 'address' }]) },
  { capabilityId: payableCapabilityId, functionName: 'pay', signature: 'pay(uint256)', abi: abiFunction('pay', 'payable', [{ name: 'amount', type: 'uint256' }]) },
  { capabilityId: transferCapabilityId, functionName: 'transfer', signature: 'transfer(address,uint256)', abi: abiFunction('transfer', 'nonpayable', [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }]) },
].map((fn) => ({ ...fn, type: 'contract_call' as const, chainId: 8453, contract: address, status: 'active' as const, provenance: { sourceRef: 'runner-owned PG fixture ABI', verifiedAt: '2026-10-02', status: 'verified' as const } }));
const baseCatalogFunctions = [...fixtureFunctions];
const npmDefinitions = [
  ['mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))', 'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable'],
  ['increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))', 'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable'],
  ['decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))', 'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable'],
  ['collect((uint256,address,uint128,uint128))', 'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable'],
  ['burn(uint256)', 'function burn(uint256 tokenId) payable'], ['refundETH()', 'function refundETH() payable'],
  ['unwrapWETH9(uint256,address)', 'function unwrapWETH9(uint256 amountMinimum,address recipient) payable'],
  ['sweepToken(address,uint256,address)', 'function sweepToken(address token,uint256 amountMinimum,address recipient) payable'],
] as const;
const npmFunctions = npmDefinitions.map(([signature, declaration], index) => {
  const abi = parseAbi([declaration])[0];
  return { capabilityId: npmChildIds[index], type: 'contract_call' as const, chainId: 8453, contract: address, functionName: abi.name, signature, abi, status: 'active' as const, provenance: { sourceRef: 'runner-owned scoped NPM fixture', verifiedAt: '2026-10-04', status: 'verified' as const } };
});
const npmWrapperAbi = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])[0];
const npmWrapper = { capabilityId: npmWrapperId, type: 'contract_call' as const, chainId: 8453, contract: address, functionName: 'multicall', signature: 'multicall(bytes[])', abi: npmWrapperAbi, status: 'active' as const, provenance: { sourceRef: 'runner-owned scoped NPM fixture', verifiedAt: '2026-10-04', status: 'verified' as const }, executionScope: { kind: 'same-target-multicall-v1' as const, bytesArrayArgIndex: 0 as const, allowedChildren: npmFunctions.map((fn) => ({ capabilityId: fn.capabilityId, signature: fn.signature, abiHash: functionAbiHash(fn) })) } };
const catalogFixture: DefiCatalog = [{ chainId: 8453, status: 'active', contracts: [{ address, status: 'active', functions: [...baseCatalogFunctions, npmWrapper, ...npmFunctions] }] }];
const reviewedManifest = buildReviewedManifest([{ chains: catalogFixture }]);
let allowedEventExporter: { exportSecurityEvent: jest.Mock };


const deferred = () => {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function waitForAcceptancePause(
  milestone: Promise<void>,
  acceptance: Promise<unknown>,
  label: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      milestone,
      acceptance.then(
        () => { throw new Error(`${label}: acceptance finished before expected lock milestone`); },
        (error) => { throw error; },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out waiting for acceptance lock milestone`)), 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('DeFi policy PostgreSQL serialization (runner-owned disposable DB)', () => {
  jest.setTimeout(90_000);
  let prismaA: PrismaClient;
  let prismaB: PrismaClient;
  let observer: PgClient;
  let events: SecurityEventService;
  let policy: DefiPolicyService;
  let pause: DefiPauseService;
  let grants: DefiGrantService;
  let apiKeys: ApiKeyService;
  let userId: string;
  let keyId: string;
  let walletId: string;
  let identityVerified = false;

  let auth: DefiAuthorization;

  beforeAll(async () => {
    prismaA = new PrismaClient({ adapter: new PrismaPg(target.url) });
    prismaB = new PrismaClient({ adapter: new PrismaPg(target.url) });
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prismaA));
    observer = new Pg({ connectionString: target.url });
    await observer.connect();
    identityVerified = true;

    allowedEventExporter = { exportSecurityEvent: jest.fn().mockResolvedValue(undefined) };
    events = new SecurityEventService(prismaA as never, { getRequestId: () => null } as never, undefined, undefined, allowedEventExporter as never);
    const catalog = new DefiCatalogService(catalogFixture, prismaA as never, reviewedManifest);
    policy = new DefiPolicyService(prismaA as never, events, catalog);
    pause = new DefiPauseService(prismaA as never, events);
    grants = new DefiGrantService(catalog);
    apiKeys = new ApiKeyService(prismaA as never, events, grants, policy);

    const uid = `defi_pg_${suiteId}`;
    const user = await prismaA.user.create({ data: { socialProvider: 'google', socialId: uid, email: `${uid}@example.invalid` } });
    userId = user.id;
    const wallet = await prismaA.userWallet.create({ data: { userId, walletAddress: `0x${suiteId.padEnd(40, '1').slice(0, 40)}`, status: 'active' } });
    walletId = wallet.id;
    const key = await prismaA.apiKey.create({ data: { userId, apiKeyHash: 'test-hash', keyPrefix: `sk_${suiteId.padEnd(24, 'a').slice(0, 24)}`, name: 'DeFi PG test', allowedIps: [], canSendTransaction: true, allowedCapabilityIds: [capabilityId], directEgressPolicyAcceptedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    keyId = key.id;
    const context = { userId, apiKeyId: keyId, walletId, chainId: 8453, executionMode: 'session_key', executionOwner: address, allowedCapabilityIds: [capabilityId] };
    const interactions = [Object.freeze({ to: address, data: encodeFunctionData({ abi: [abi], functionName: 'ping', args: [1n] }) as `0x${string}`, value: '0' })];
    auth = await policy.authorizeContractCalls(interactions, context);
  });

  beforeEach(async () => {
    await prismaA.defiPolicyState.update({ where: { id: 'global' }, data: { pausedScopeKeys: [] } }).catch(() => undefined);
    await apiKeys.replaceCapabilities(keyId, userId, [capabilityId]);
  });

  afterAll(async () => {
    try {
      if (identityVerified) {
        await prismaA.securityEvent.deleteMany({ where: { userId } }).catch(() => undefined);
        await prismaA.apiKeyEvent.deleteMany({ where: { userId } }).catch(() => undefined);
        await prismaA.apiKey.deleteMany({ where: { userId } }).catch(() => undefined);
        await prismaA.userWallet.deleteMany({ where: { userId } }).catch(() => undefined);
        await prismaA.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
      }
    } finally {
      await observer?.end().catch(() => undefined);
      await Promise.all([prismaA?.$disconnect().catch(() => undefined), prismaB?.$disconnect().catch(() => undefined)]);
    }
  });

  function createAcceptance(
    authorization: DefiAuthorization = auth,
    policyService: DefiPolicyService = policy,
    db: PrismaClient = prismaA,
    requestHashOverride?: string,
  ) {
    const destinationPolicy = {
      acquireUserDestinationLock: (user: string, tx: any) =>
        tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`withdrawal_dest:${user}`}))`,
      assertDestinationsAllowed: async () => undefined,
      recordDeferredDenial: async () => undefined,
      recordUnprovenAssetOutflowDenial: async () => undefined,
    };
    const service = new TransactionsService(
      db as never, {} as never, new TransactionPolicyService(db as never, events), {} as never, {} as never,
      destinationPolicy as never, policyService,
      events as never,
    );
    const extraction = extractDirectTransferIntents(authorization.interactions as any, authorization.context.executionOwner);
    if (!extraction.ok) throw new Error('Invalid destination fixture');
    const directDestinations = uniqueDirectTransferDestinations(extraction.intents);
    return (idempotencyKey = randomBytes(12).toString('hex')) =>
      (service as any).createPendingOrReturnExisting(userId, {
        apiKeyId: keyId,
        apiKeyPrefix: `sk_${suiteId.padEnd(24, 'a').slice(0, 24)}`,
        operationType: 'send',
        idempotencyKey,
        chainId: authorization.context.chainId,
        requestHash: requestHashOverride ?? `request-${idempotencyKey}`,
        legacyRequestHash: `legacy-${idempotencyKey}`,
        walletId,
        walletAddress: address,
        executionMode: 'session_key',
        nativeValueWei: authorization.interactions.reduce((sum, interaction) => sum + BigInt(interaction.value ?? '0'), 0n).toString(),
        details: { interactionCount: 1, nativeValueWei: authorization.interactions.reduce((sum, interaction) => sum + BigInt(interaction.value ?? '0'), 0n).toString(), walletId, executionMode: authorization.context.executionMode },
        destinationGate: {
          userId,
          destinations: directDestinations,
          directDestinations,
          wrapRecipients: [],
          intents: extraction.intents,
          fullyProvenDirectEgress: authorization.interactions.length > 0 && extraction.notProven.length === 0 && extraction.intents.length === authorization.interactions.length,
          notProven: extraction.notProven,
          chainId: authorization.context.chainId,
          walletId,
          apiKeyId: keyId,
          apiKeyPrefix: `sk_${suiteId.padEnd(24, 'a').slice(0, 24)}`,
          executionMode: 'session_key',
          restrictedWrap: false,
        },
        defiAuthorization: authorization,
      });
  }

  async function authorizeNpmWrapper(value = '60'): Promise<DefiAuthorization> {
    const selected = [npmWrapperId, npmChildIds[0]!, npmChildIds[5]!];
    await apiKeys.replaceCapabilities(keyId, userId, selected);
    const mintData = encodeFunctionData({
      abi: [npmFunctions[0]!.abi], functionName: 'mint',
      args: [[address, '0x2222222222222222222222222222222222222222', 3000, -887220, 887220, (1n << 255n), (1n << 255n), 0n, 0n, address, 4_000_000_000n]],
    } as never);
    const refundData = encodeFunctionData({ abi: [npmFunctions[5]!.abi], functionName: 'refundETH', args: [] });
    const rootData = encodeFunctionData({ abi: [npmWrapperAbi], functionName: 'multicall', args: [[mintData, refundData]] });
    return policy.authorizeContractCalls([{ to: address, data: rootData, value }], {
      userId, apiKeyId: keyId, walletId, chainId: 8453, executionMode: 'session_key', executionOwner: address, allowedCapabilityIds: selected,
    });
  }

  it('acceptance holds pause FOR SHARE and blocks pause UPDATE until commit', async () => {
    const accepted = deferred(); const release = deferred();
    const acceptance = prismaA.$transaction(async (tx) => {
      await policy.assertStillAuthorized(tx, auth);
      accepted.resolve();
      await release.promise;
    }, { isolationLevel: 'ReadCommitted' });
    await accepted.promise;

    const waiter = new Pg({ connectionString: target.url });
    await waiter.connect();
    try {
      await waiter.query('BEGIN');
      const { rows } = await waiter.query('SELECT pg_backend_pid() AS pid');
      const waiterPid = Number(rows[0]!.pid);
      const lockWait = waiter.query(`SELECT id FROM defi_policy_state WHERE id = 'global' FOR UPDATE`);
      await waitUntilBlocked(observer, waiterPid);
      release.resolve();
      await acceptance;
      await lockWait;
      await waiter.query(`UPDATE defi_policy_state SET paused_scope_keys = ARRAY[$1] WHERE id = 'global'`, [`capability:${capabilityId}`]);
      await waiter.query('COMMIT');
    } finally {
      release.resolve();
      await waiter.query('ROLLBACK').catch(() => undefined);
      await waiter.end();
    }
    await prismaA.defiPolicyState.update({ where: { id: 'global' }, data: { pausedScopeKeys: [] } });
  });

  it('a committed pause is observed by final authorization and rejects acceptance', async () => {
    await pause.setPaused({ kind: 'capability', capabilityId }, true, { operatorId: userId, reason: 'PG integration pause test', reference: `test/${suiteId}` });
    await expect(prismaA.$transaction((tx) => policy.assertStillAuthorized(tx, auth), { isolationLevel: 'ReadCommitted' })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    await pause.setPaused({ kind: 'capability', capabilityId }, false, { operatorId: userId, reason: 'PG integration pause cleared', reference: `test/${suiteId}` });
  });

  it('grant replacement waits behind accepted API-key row lock; next acceptance sees removed grant', async () => {
    const held = deferred(); const release = deferred();
    const accepting = prismaB.$transaction(async (tx) => { await policy.assertStillAuthorized(tx, auth); held.resolve(); await release.promise; }, { isolationLevel: 'ReadCommitted' });
    await held.promise;
    const replacing = apiKeys.replaceCapabilities(keyId, userId, []);
    let replacingResult: unknown;
    let replacingError: unknown;
    const settled = replacing.then((value) => { replacingResult = value; }, (error) => { replacingError = error; });
    try {
      await waitForAnyLockWait(observer, 4_000);
    } finally {
      release.resolve();
      await accepting;
    }
    await settled;
    if (replacingError) throw replacingError;
    expect(replacingResult).toEqual({ id: keyId, allowedCapabilityIds: [] });
    await expect(prismaA.$transaction((tx) => policy.assertStillAuthorized(tx, auth), { isolationLevel: 'ReadCommitted' })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('composed transaction acceptance holds destination, pause, then API-key locks against a real pause race', async () => {
    const reachedAudit = deferred(); const releaseAcceptance = deferred();
    const record = policy.recordAllowedInTx.bind(policy);
    const recordSpy = jest.spyOn(policy, 'recordAllowedInTx').mockImplementation(async (...args) => {
      const event = await record(...args);
      reachedAudit.resolve();
      await releaseAcceptance.promise;
      return event;
    });
    const accept = createAcceptance();
    const pending = accept();
    try {
      await waitForAcceptancePause(reachedAudit.promise, pending, 'pause race');
      const changingPause = pause.setPaused({ kind: 'capability', capabilityId }, true, { operatorId: userId, reason: 'composed acceptance race', reference: `test/${suiteId}` });
      await waitForAnyLockWait(observer, 4_000);
      releaseAcceptance.resolve();
      const result = await pending;
      await changingPause;
      expect(result.created).toBe(true);
      await expect(accept()).rejects.toMatchObject({ response: { code: 'DEFI_CAPABILITY_PAUSED' } });
    } finally {
      releaseAcceptance.resolve();
      recordSpy.mockRestore();
      await pause.setPaused({ kind: 'capability', capabilityId }, false, { operatorId: userId, reason: 'composed race cleanup', reference: `test/${suiteId}` }).catch(() => undefined);
    }
  });

  it('composed transaction acceptance holds destination, pause, then API-key locks against grant replacement', async () => {
    const reachedAudit = deferred(); const releaseAcceptance = deferred();
    const record = policy.recordAllowedInTx.bind(policy);
    const recordSpy = jest.spyOn(policy, 'recordAllowedInTx').mockImplementation(async (...args) => {
      const event = await record(...args);
      reachedAudit.resolve();
      await releaseAcceptance.promise;
      return event;
    });
    const accept = createAcceptance();
    const pending = accept();
    try {
      await waitForAcceptancePause(reachedAudit.promise, pending, 'grant race');
      const replacing = apiKeys.replaceCapabilities(keyId, userId, []);
      const replacementOutcome = replacing.then(
        (value) => ({ value } as const),
        (error) => ({ error } as const),
      );
      await waitForAnyLockWait(observer, 4_000);
      releaseAcceptance.resolve();
      const result = await pending;
      const replacement = await replacementOutcome;
      if ('error' in replacement) throw replacement.error;
      expect(result.created).toBe(true);
      expect(replacement.value).toEqual({ id: keyId, allowedCapabilityIds: [] });
      await expect(accept()).rejects.toMatchObject({ response: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    } finally {
      releaseAcceptance.resolve();
      recordSpy.mockRestore();
      await apiKeys.replaceCapabilities(keyId, userId, [capabilityId]).catch(() => undefined);
    }
  });

  it('fails closed when the singleton is absent and rolls back deferred acceptance audit without export', async () => {
    await prismaA.defiPolicyState.delete({ where: { id: 'global' } });
    await expect(prismaA.$transaction((tx) => policy.assertStillAuthorized(tx, auth), { isolationLevel: 'ReadCommitted' })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await prismaA.defiPolicyState.create({ data: { id: 'global', pausedScopeKeys: [] } });

    const before = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
    const exportSpy = jest.spyOn(events, 'exportCommitted');
    await expect(prismaA.$transaction(async (tx) => {
      await policy.recordAllowedInTx(tx, auth);
      throw new Error('force rollback');
    }, { isolationLevel: 'ReadCommitted' })).rejects.toThrow('force rollback');
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(before);
    expect(exportSpy).not.toHaveBeenCalled();
    exportSpy.mockRestore();
  });

  it('accepts independently granted unlimited approvals, borrow arguments, new recipients, and payable native value', async () => {
    const grantIds = [approvalCapabilityId, borrowCapabilityId, payableCapabilityId, transferCapabilityId];
    await apiKeys.replaceCapabilities(keyId, userId, grantIds);
    const context = { userId, apiKeyId: keyId, walletId, chainId: 8453, executionMode: 'session_key', executionOwner: address, allowedCapabilityIds: grantIds };
    const maxUint256 = (1n << 256n) - 1n;
    const arbitrarySpender = '0x2222222222222222222222222222222222222222';
    const arbitraryRecipient = '0x3333333333333333333333333333333333333333';
    const cases = [
      { capability: approvalCapabilityId, name: 'approve', args: [arbitrarySpender, maxUint256], value: '0' },
      { capability: transferCapabilityId, name: 'transfer', args: [arbitraryRecipient, maxUint256], value: '0' },
      { capability: borrowCapabilityId, name: 'borrow', args: [arbitraryRecipient, maxUint256, maxUint256, 65535, arbitraryRecipient], value: '0' },
      { capability: payableCapabilityId, name: 'pay', args: [maxUint256], value: maxUint256.toString() },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const fn = fixtureFunctions.find((candidate) => candidate.capabilityId === item.capability)!;
      const data = encodeFunctionData({ abi: [fn.abi], functionName: item.name, args: item.args as never });
      const interactions = [{ to: address, data, value: item.value }];
      const authorization = await policy.authorizeContractCalls(interactions, context);
      expect(authorization.matches.map((match) => match.capabilityId)).toEqual([item.capability]);
      const idem = `unrestricted-${index}-${suiteId}`;
      const accepted = await createAcceptance(authorization)(idem);
      expect(accepted.created).toBe(true);
      expect(accepted.tx.status).toBe('submitting');
    }

    await apiKeys.replaceCapabilities(keyId, userId, [capabilityId]);
  });

  async function authorizePayable(value: string): Promise<DefiAuthorization> {
    await apiKeys.replaceCapabilities(keyId, userId, [payableCapabilityId]);
    const fn = fixtureFunctions.find((candidate) => candidate.capabilityId === payableCapabilityId)!;
    const context = { userId, apiKeyId: keyId, walletId, chainId: 8453, executionMode: 'session_key', executionOwner: address, allowedCapabilityIds: [payableCapabilityId] };
    return policy.authorizeContractCalls([{
      to: address,
      data: encodeFunctionData({ abi: [fn.abi], functionName: 'pay', args: [1n] }),
      value,
    }], context);
  }

  async function clearSpendReservations(): Promise<void> {
    await prismaA.transaction.deleteMany({ where: { apiKeyId: keyId, operationType: 'send' } });
  }

  it('persists accepted native spend and denies the next request against the committed reservation', async () => {
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '100', monthlySpendLimit: null } });
    const sixty = await authorizePayable('60');
    const accepted = await createAcceptance(sixty)('budget-first-60');
    expect(accepted.created).toBe(true);
    expect(accepted.tx.details).toMatchObject({ nativeValueWei: '60' });
    await expect(createAcceptance(sixty)('budget-second-60')).rejects.toThrow('exceed daily spend limit');
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'budget-second-60' } })).toBe(0);
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'budget-first-60' } })).toBe(1);
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null } });
  });

  it('accepts the original scoped wrapper once: one 60-wei root reservation, safe root/child audit, and later budget denial', async () => {
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '100', monthlySpendLimit: null } });
    const scoped = await authorizeNpmWrapper('60');
    expect(scoped.interactions).toHaveLength(1);
    expect(scoped.executionPlan.map((node) => node.path)).toEqual([[0], [0, 0], [0, 1]]);
    const startingAllowed = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
    allowedEventExporter.exportSecurityEvent.mockClear();
    const rootRequestHash = scoped.requestCommitment.slice(2);
    const accepted = await createAcceptance(scoped, policy, prismaA, rootRequestHash)('scoped-multicall-60');
    expect(accepted.created).toBe(true);
    expect(accepted.tx.details).toMatchObject({ nativeValueWei: '60', interactionCount: 1 });
    expect(accepted.tx.requestHash).toBe(rootRequestHash);
    const allowed = await prismaA.securityEvent.findFirst({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId }, orderBy: { createdAt: 'desc' } });
    const serialized = JSON.stringify(allowed?.metadata);
    expect(serialized).toContain(npmChildIds[0]);
    expect(serialized).toContain(npmChildIds[5]);
    expect(serialized).toContain('[0,0]');
    expect(serialized).toContain('[0,1]');
    expect(serialized).not.toContain(scoped.interactions[0]!.data);
    expect(serialized).not.toContain('340282366920938463463374607431768211456');
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(startingAllowed + 1);
    const allowedExports = allowedEventExporter.exportSecurityEvent.mock.calls.filter(([event]) => (event as { eventType?: string })?.eventType === 'defi.capability_allowed').length;
    expect(allowedExports).toBe(1);
    const repeated = await createAcceptance(scoped, policy, prismaA, rootRequestHash)('scoped-multicall-60');
    expect(repeated.created).toBe(false);
    expect(repeated.tx.id).toBe(accepted.tx.id);
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'scoped-multicall-60' } })).toBe(1);
    expect(allowedEventExporter.exportSecurityEvent.mock.calls.filter(([event]) => (event as { eventType?: string })?.eventType === 'defi.capability_allowed')).toHaveLength(allowedExports);
    const nextHash = `${rootRequestHash[0] === '0' ? '1' : '0'}${rootRequestHash.slice(1)}`;
    await expect(createAcceptance(scoped, policy, prismaA, nextHash)('scoped-multicall-next-60')).rejects.toThrow('exceed daily spend limit');
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'scoped-multicall-next-60' } })).toBe(0);
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(startingAllowed + 1);
    expect(allowedEventExporter.exportSecurityEvent.mock.calls.filter(([event]) => (event as { eventType?: string })?.eventType === 'defi.capability_allowed')).toHaveLength(allowedExports);
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null } });
  });

  it('denies final scoped acceptance after a child grant is revoked without persisting an allowed audit or transaction', async () => {
    await clearSpendReservations();
    const scoped = await authorizeNpmWrapper('60');
    const beforeAllowed = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
    await apiKeys.replaceCapabilities(keyId, userId, [npmWrapperId, npmChildIds[0]!]);
    allowedEventExporter.exportSecurityEvent.mockClear();
    await expect(createAcceptance(scoped, policy, prismaA, scoped.requestCommitment.slice(2))('scoped-child-revoked')).rejects.toMatchObject({ response: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'scoped-child-revoked' } })).toBe(0);
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(beforeAllowed);
    expect(allowedEventExporter.exportSecurityEvent.mock.calls.filter(([event]) => (event as { eventType?: string })?.eventType === 'defi.capability_allowed')).toHaveLength(0);
  });

  it('counts a committed reservation timestamped after acceptance within both UTC periods, but excludes next-period rows', async () => {
    await clearSpendReservations();
    const acceptedAt = new Date('2026-10-02T13:45:00.000Z');
    const budgetPolicy = new TransactionPolicyService(prismaA as never, events);
    const createReservation = (idempotencyKey: string, createdAt: Date, value: string) => prismaA.transaction.create({
      data: {
        userId, apiKeyId: keyId, authMethod: 'api_key',
        apiKeyPrefix: `sk_${suiteId.padEnd(24, 'a').slice(0, 24)}`,
        status: 'submitting', chainId: BigInt(8453), walletAddress: address,
        operationType: 'send', idempotencyKey, requestHash: `window-${idempotencyKey}`,
        createdAt, details: { nativeValueWei: value },
      },
    });
    const assertBudget = () => prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM api_keys WHERE id = ${keyId}::uuid FOR UPDATE`;
      await budgetPolicy.assertSpendAllowedInTx(tx, { userId, apiKeyId: keyId, nativeValueWei: '60', acceptedAt });
    }, { isolationLevel: 'ReadCommitted' });

    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '100', monthlySpendLimit: null } });
    await createReservation('window-daily-after-acceptedAt', new Date('2026-10-02T13:45:01.000Z'), '60');
    await expect(assertBudget()).rejects.toThrow('exceed daily spend limit');

    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null, monthlySpendLimit: '100' } });
    await createReservation('window-monthly-after-acceptedAt', new Date('2026-10-02T13:45:01.000Z'), '60');
    await expect(assertBudget()).rejects.toThrow('exceed monthly spend limit');

    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '100', monthlySpendLimit: null } });
    await createReservation('window-next-day', new Date('2026-10-03T00:00:00.000Z'), '60');
    await expect(assertBudget()).resolves.toBeUndefined();
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null, monthlySpendLimit: '100' } });
    await createReservation('window-next-month', new Date('2026-11-01T00:00:00.000Z'), '60');
    await expect(assertBudget()).resolves.toBeUndefined();
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null, monthlySpendLimit: null } });
  });

  it('serializes concurrent budget acceptance across independent Prisma clients', async () => {
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '100', monthlySpendLimit: null } });
    const sixty = await authorizePayable('60');
    const reachedAudit = deferred(); const release = deferred();
    const record = policy.recordAllowedInTx.bind(policy);
    const recordSpy = jest.spyOn(policy, 'recordAllowedInTx').mockImplementation(async (...args) => {
      const event = await record(...args);
      reachedAudit.resolve();
      await release.promise;
      return event;
    });
    const first = createAcceptance(sixty, policy, prismaA)('budget-race-a');
    try {
      await waitForAcceptancePause(reachedAudit.promise, first, 'first budget acceptance');
      const second = createAcceptance(sixty, policy, prismaB)('budget-race-b');
      await waitForAnyLockWait(observer, 4_000);
      release.resolve();
      const results = await Promise.allSettled([first, second]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: { in: ['budget-race-a', 'budget-race-b'] } } })).toBe(1);
    } finally {
      release.resolve();
      recordSpy.mockRestore();
      await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null } });
    }
  });

  it('rolls back the reservation and allowed audit together, then accepts the spend on retry', async () => {
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '100', monthlySpendLimit: null } });
    const sixty = await authorizePayable('60');
    const beforeAllowed = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
    const exportSpy = jest.spyOn(events, 'exportCommitted');
    const rollbackPolicy = new DefiPolicyService(prismaA as never, events, new DefiCatalogService(catalogFixture, prismaA as never, reviewedManifest));
    jest.spyOn(rollbackPolicy, 'recordAllowedInTx').mockImplementation(async (tx, authorization) => {
      await policy.recordAllowedInTx(tx, authorization);
      throw new Error('forced acceptance rollback');
    });
    await expect(createAcceptance(sixty, rollbackPolicy)('budget-rollback')).rejects.toThrow('forced acceptance rollback');
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'budget-rollback' } })).toBe(0);
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(beforeAllowed);
    expect(exportSpy).not.toHaveBeenCalled();
    const accepted = await createAcceptance(sixty)('budget-rollback-retry');
    expect(accepted.created).toBe(true);
    expect(accepted.tx.details).toMatchObject({ nativeValueWei: '60' });
    exportSpy.mockRestore();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null } });
  });

  it('returns same-idempotency hits without charging twice and preserves different-hash conflicts', async () => {
    await clearSpendReservations();
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: '60', monthlySpendLimit: null } });
    const sixty = await authorizePayable('60');
    const accept = createAcceptance(sixty);
    const first = await accept('budget-idempotent');
    expect(first.created).toBe(true);
    const duplicate = await accept('budget-idempotent');
    expect(duplicate.created).toBe(false);
    expect(duplicate.tx.id).toBe(first.tx.id);
    await expect(createAcceptance(sixty, policy, prismaA, 'different-request-hash')('budget-idempotent')).rejects.toThrow('Idempotency key was already used for a different request');
    expect(await prismaA.transaction.count({ where: { userId, idempotencyKey: 'budget-idempotent' } })).toBe(1);
    await prismaA.apiKey.update({ where: { id: keyId }, data: { dailySpendLimit: null } });
  });

  it('fixture authorization accepts any canonical fixed-ABI arguments under its exact grant', async () => {
    await prismaA.defiPolicyState.update({ where: { id: 'global' }, data: { pausedScopeKeys: [] } });
    const data = encodeFunctionData({ abi: [abi], functionName: 'ping', args: [42n] });
    const result = await policy.authorizeContractCalls([{ to: address, data, value: '0' }], auth.context);
    expect(result.matches.map((match) => match.capabilityId)).toEqual([capabilityId]);
  });
});

async function waitUntilBlocked(client: PgClient, pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await client.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
    if (rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL backend ${pid} was not observed blocked within ${timeoutMs}ms`);
}

async function waitForAnyLockWait(client: PgClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await client.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()");
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no PostgreSQL lock waiter observed within ${timeoutMs}ms`);
}

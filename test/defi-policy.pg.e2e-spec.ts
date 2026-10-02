import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'crypto';
import { encodeFunctionData, keccak256, stringToHex } from 'viem';

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { TransactionsService } from '../src/modules/transactions/transactions.service';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
} from './billing-e2e-database';
import { DefiCatalogService } from '../src/modules/defi/defi-catalog.service';
import { PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS, buildProspectiveEthereumUsdcWeth500 } from '../src/modules/defi/registry/production-registry';
import { DefiPolicyService } from '../src/modules/defi/defi-policy.service';
import { DefiPauseService } from '../src/modules/defi/defi-pause.service';
import { DefiGrantService } from '../src/modules/defi/defi-grant.service';
import { SecurityEventService } from '../src/modules/security-events/security-event.service';
import { ApiKeyService } from '../src/modules/api-key/api-key.service';
import { buildReviewedManifest, reviewedAbiHash } from '../src/modules/defi/registry/defi-manifest';
import { buildDefiPolicyIdentityHash, buildDefiRequestCommitment } from '../src/modules/defi/defi-policy.service';
import type { DefiAuthorization, DefiCatalog, DefiEvidence } from '../src/modules/defi/defi.types';

const target = applyBillingE2eDatabaseUrl(resolveBillingE2eDatabaseTarget());
const suiteId = randomBytes(6).toString('hex');
const capabilityId = `cap:pg-test:${suiteId}:v1`;
const address = '0x1111111111111111111111111111111111111111' as const;
const deploymentRef = `deployment:pg:${suiteId}`;
const abi = { type: 'function', name: 'ping', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] } as const;
const assetRef = `asset:8453:${address}`;
const catalogFixture: DefiCatalog = [{ chainId: 8453, status: 'active', contracts: [{ address, status: 'active', functions: [{ capabilityId, type: 'contract_call', chainId: 8453, contract: address, functionSignature: 'ping(uint256)', functionName: 'ping', signature: 'ping(uint256)', abi, policy: { ref: 'pg-fixture', version: 1 }, status: 'active', manifestRefs: { assets: [assetRef], deployments: [deploymentRef] }, validate: (args) => args[0] === 1n, describe: (_args, _context, index) => ({ kind: 'action', index, operation: 'supply', deploymentRef, token: address, amount: 1n }) }] }] }];
const reviewedManifest = buildReviewedManifest([{
  chains: catalogFixture, assets: [{ ref: assetRef, chainId: 8453, address, symbol: 'USDC', decimals: 6, maxOperationRaw: 1_000_000n, deploymentRef }], priceFeeds: [], pools: [], markets: [],
  deployments: [{ ref: deploymentRef, chainId: 8453, address, status: 'verified', sourceRef: 'pg fixture only', abi: [abi], abiHash: reviewedAbiHash([abi]), runtimeCodeHash: `0x${'2'.repeat(64)}`, identityChecks: [{ getter: 'decimals()', expected: '6' }], verificationRef: 'pg-fixture' }],
  activationEvidence: [{ capabilityId, executionProofRef: 'pg-fixture-only', sourceIdentityRef: 'pg-fixture-only' }],
}]);

type PgClient = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
type PgClientCtor = new (config: { connectionString: string; application_name?: string }) => PgClient;
const Pg = (require('pg') as { Client: PgClientCtor }).Client;

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

  const testEvidence = (): DefiEvidence => {
    const observedAtMs = Date.now();
    return Object.freeze({ requestCommitment: auth.requestCommitment, manifestHash: auth.manifestHash, chainId: 8453, executionOwner: address, blockNumber: 1n, blockHash: `0x${'a'.repeat(64)}`, observedAtMs, expiresAtMs: observedAtMs + 30_000, checksDigest: `0x${'b'.repeat(64)}` });
  };

  beforeAll(async () => {
    prismaA = new PrismaClient({ adapter: new PrismaPg(target.url) });
    prismaB = new PrismaClient({ adapter: new PrismaPg(target.url) });
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(prismaA));
    observer = new Pg({ connectionString: target.url });
    await observer.connect();
    identityVerified = true;

    const exporter = { exportSecurityEvent: jest.fn().mockResolvedValue(undefined) };
    events = new SecurityEventService(prismaA as never, { getRequestId: () => null } as never, undefined, undefined, exporter as never);
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
    const matches = [{ capabilityId, type: 'contract_call' as const, chainId: 8453, contract: address, functionSignature: 'ping(uint256)', policy: { ref: 'pg-fixture', version: 1 } }];
    const interactions = [Object.freeze({ to: address, data: encodeFunctionData({ abi: [abi], functionName: 'ping', args: [1n] }) as `0x${string}`, value: '0' })];
    auth = Object.freeze({ context: Object.freeze(context), requiredPermission: 'canSendTransaction', matches: Object.freeze(matches), interactions: Object.freeze(interactions), batchPlan: Object.freeze({ effects: Object.freeze([{ kind: 'action' as const, index: 0, operation: 'supply' as const, deploymentRef, token: address, amount: 1n }]), fundingTotals: Object.freeze({}) }), manifestHash: reviewedManifest.manifestHash, requestCommitment: buildDefiRequestCommitment(interactions, context, reviewedManifest.manifestHash), policyIdentityHash: buildDefiPolicyIdentityHash(matches) });
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

  function createAcceptance(authorization: DefiAuthorization = auth, evidence: DefiEvidence = testEvidence(), policyService: DefiPolicyService = policy) {
    const destinationPolicy = {
      acquireUserDestinationLock: (user: string, tx: any) =>
        tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`withdrawal_dest:${user}`}))`,
      assertDestinationsAllowed: async () => undefined,
      recordDeferredDenial: async () => undefined,
      recordUnprovenAssetOutflowDenial: async () => undefined,
    };
    const service = new TransactionsService(
      prismaA as never, {} as never, {} as never, {} as never, {} as never,
      destinationPolicy as never, policyService,
      { verify: jest.fn(), assertFresh: jest.fn() } as never,
      events as never,
    );
    return (idempotencyKey = randomBytes(12).toString('hex')) =>
      (service as any).createPendingOrReturnExisting(userId, {
        apiKeyId: keyId,
        apiKeyPrefix: `sk_${suiteId.padEnd(24, 'a').slice(0, 24)}`,
        operationType: 'send',
        idempotencyKey,
        chainId: authorization.context.chainId,
        requestHash: `request-${idempotencyKey}`,
        legacyRequestHash: `legacy-${idempotencyKey}`,
        walletId,
        walletAddress: address,
        executionMode: 'session_key',
        details: { interactionCount: 1, walletId, executionMode: authorization.context.executionMode },
        destinationGate: {
          userId,
          destinations: ['0x2222222222222222222222222222222222222222'],
          intents: [],
          fullyProvenDirectEgress: true,
          notProven: [],
          chainId: authorization.context.chainId,
          walletId,
          apiKeyId: keyId,
          apiKeyPrefix: `sk_${suiteId.padEnd(24, 'a').slice(0, 24)}`,
          executionMode: 'session_key',
        },
        defiAuthorization: authorization,
        defiEvidence: evidence,
      });
  }

  it('acceptance holds pause FOR SHARE and blocks pause UPDATE until commit', async () => {
    const accepted = deferred(); const release = deferred();
    const acceptance = prismaA.$transaction(async (tx) => {
      await policy.assertStillAuthorized(tx, auth, testEvidence());
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
    await expect(prismaA.$transaction((tx) => policy.assertStillAuthorized(tx, auth, testEvidence()), { isolationLevel: 'ReadCommitted' })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    await pause.setPaused({ kind: 'capability', capabilityId }, false, { operatorId: userId, reason: 'PG integration pause cleared', reference: `test/${suiteId}` });
  });

  it('grant replacement waits behind accepted API-key row lock; next acceptance sees removed grant', async () => {
    const held = deferred(); const release = deferred();
    const accepting = prismaB.$transaction(async (tx) => { await policy.assertStillAuthorized(tx, auth, testEvidence()); held.resolve(); await release.promise; }, { isolationLevel: 'ReadCommitted' });
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
    await expect(prismaA.$transaction((tx) => policy.assertStillAuthorized(tx, auth, testEvidence()), { isolationLevel: 'ReadCommitted' })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
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
    await expect(prismaA.$transaction((tx) => policy.assertStillAuthorized(tx, auth, testEvidence()), { isolationLevel: 'ReadCommitted' })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
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

  it('composes the active prospective ETH USDC/WETH 500 catalog, three grants, canonical batches, and final PostgreSQL acceptance', async () => {
    const prospective = buildProspectiveEthereumUsdcWeth500({ activate: true });
    const prospectiveCatalog = new DefiCatalogService(prospective.chains, prismaA as never, prospective);
    const prospectivePolicy = new DefiPolicyService(prismaA as never, events, prospectiveCatalog);
    expect(PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS).toHaveLength(3);
    await prismaA.apiKey.update({ where: { id: keyId }, data: { allowedCapabilityIds: [...PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS] } });

    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const router = '0xe592427a0aece92de3edee1f18e0157c05861564';
    const actionId = PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS[0];
    const action = prospective.capabilities.find((fn) => fn.capabilityId === actionId)!;
    const owner = address;
    const authorized: DefiAuthorization[] = [];
    const successfulKeys: string[] = [];
    const evidenceFor = (authorization: DefiAuthorization): DefiEvidence => {
      const observedAtMs = Date.now();
      return Object.freeze({ requestCommitment: authorization.requestCommitment, manifestHash: authorization.manifestHash, chainId: authorization.context.chainId, executionOwner: authorization.context.executionOwner, blockNumber: 26_102_396n, blockHash: `0x${'c'.repeat(64)}`, observedAtMs, expiresAtMs: observedAtMs + 30_000, checksDigest: `0x${'d'.repeat(64)}` });
    };

    for (const [label, input, output, amount] of [
      ['usdc-to-weth', usdc, weth, 10_000n],
      ['weth-to-usdc', weth, usdc, 10_000_000_000_000_000n],
    ] as const) {
      const approval = prospective.capabilities.find((fn) => fn.functionName === 'approve' && fn.contract.toLowerCase() === input && fn.status === 'active' && fn.dependencies?.includes(actionId));
      expect(approval).toBeDefined();
      const now = Math.floor(Date.now() / 1000);
      const exactSwap = encodeFunctionData({
        abi: [action.abi], functionName: 'exactInputSingle',
        args: [{ tokenIn: input, tokenOut: output, fee: 500, recipient: owner, deadline: BigInt(now + 75), amountIn: amount, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] as never,
      });
      const approve = (quantity: bigint) => encodeFunctionData({
        abi: [approval!.abi], functionName: 'approve', args: [router, quantity] as never,
      });
      const request = [
        { to: input, data: approve(amount), value: '0' },
        { to: router, data: exactSwap, value: '0' },
        { to: input, data: approve(0n), value: '0' },
      ];
      const context = { userId, apiKeyId: keyId, walletId, chainId: 1, executionMode: 'session_key' as const, executionOwner: owner, allowedCapabilityIds: [...PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS] };
      const result = await prospectivePolicy.authorizeContractCalls(request, context);
      expect(result.matches.map((match) => match.capabilityId).sort()).toEqual([actionId, approval!.capabilityId, approval!.capabilityId].sort());
      expect(result.interactions.map((call) => call.to.toLowerCase())).toEqual([input, router, input]);
      expect(result.matches).toHaveLength(3);
      const evidence = evidenceFor(result);
      authorized.push(result);
      const idem = `prospective-${label}-${suiteId}`;
      const accept = createAcceptance(result, evidence, prospectivePolicy);
      const beforeAllowed = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
      const committed = await accept(idem);
      expect(committed.created).toBe(true);
      expect(committed.tx.status).toBe('submitting');
      successfulKeys.push(idem);
      expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(beforeAllowed + 1);
      const sameKey = await accept(idem);
      expect(sameKey.created).toBe(false);
      expect(sameKey.tx.id).toBe(committed.tx.id);
      expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(beforeAllowed + 1);
    }

    // Final acceptance binds the evidence to this exact immutable auth/manifest.
    const bound = authorized[0]!;
    const staleAt = Date.now() - 31_000;
    const stale: DefiEvidence = { ...evidenceFor(bound), observedAtMs: staleAt, expiresAtMs: staleAt + 30_000 };
    const invalidManifest = { ...bound, manifestHash: `0x${'f'.repeat(64)}` as `0x${string}` };
    const mutatedInteractions = bound.interactions.map((interaction, index) => index === 1 ? { ...interaction, data: `${interaction.data.slice(0, -1)}${interaction.data.endsWith('0') ? '1' : '0'}` } : interaction);
    const mutatedAuthorization = { ...bound, interactions: mutatedInteractions };
    for (const [suffix, badAuth, badEvidence] of [
      ['stale', bound, stale],
      ['manifest', invalidManifest, { ...evidenceFor(bound), manifestHash: `0x${'e'.repeat(64)}` } as DefiEvidence],
      ['input-commitment', mutatedAuthorization, evidenceFor(bound)],
    ] as const) {
      const idem = `prospective-invalid-${suffix}-${suiteId}`;
      const allowedBefore = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
      await expect(createAcceptance(badAuth, badEvidence, prospectivePolicy)(idem)).rejects.toMatchObject({ response: expect.objectContaining({ code: expect.any(String) }) });
      expect(await prismaA.transaction.count({ where: { userId, operationType: 'send', idempotencyKey: idem } })).toBe(0);
      expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(allowedBefore);
    }

    // Pause and grant revocation between preflight and final transaction do not create a row.
    const pausedIdem = `prospective-paused-${suiteId}`;
    const allowedBeforePause = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
    await pause.setPaused({ kind: 'capability', capabilityId: actionId }, true, { operatorId: userId, reason: 'prospective PG test', reference: `test/${suiteId}` });
    await expect(createAcceptance(bound, evidenceFor(bound), prospectivePolicy)(pausedIdem)).rejects.toMatchObject({ response: { code: 'DEFI_CAPABILITY_PAUSED' } });
    expect(await prismaA.transaction.count({ where: { userId, operationType: 'send', idempotencyKey: pausedIdem } })).toBe(0);
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(allowedBeforePause);
    await pause.setPaused({ kind: 'capability', capabilityId: actionId }, false, { operatorId: userId, reason: 'prospective PG cleanup', reference: `test/${suiteId}` });

    const revokedIdem = `prospective-revoked-${suiteId}`;
    const allowedBeforeRevoke = await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } });
    await prismaA.apiKey.update({ where: { id: keyId }, data: { allowedCapabilityIds: [] } });
    await expect(createAcceptance(bound, evidenceFor(bound), prospectivePolicy)(revokedIdem)).rejects.toMatchObject({ response: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    expect(await prismaA.transaction.count({ where: { userId, operationType: 'send', idempotencyKey: revokedIdem } })).toBe(0);
    expect(await prismaA.securityEvent.count({ where: { eventType: 'defi.capability_allowed', apiKeyId: keyId } })).toBe(allowedBeforeRevoke);
    await prismaA.apiKey.update({ where: { id: keyId }, data: { allowedCapabilityIds: [...PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS] } });
    // Preserve the suite's fixture key grant for the other lock tests.
    await prismaA.apiKey.update({ where: { id: keyId }, data: { allowedCapabilityIds: [capabilityId] } });
    expect(successfulKeys).toHaveLength(2);
  });

  it('fixture authorization uses real catalog ABI decode and reviewed validator', async () => {
    await prismaA.defiPolicyState.update({ where: { id: 'global' }, data: { pausedScopeKeys: [] } });
    const data = encodeFunctionData({ abi: [abi], functionName: 'ping', args: [1n] });
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

import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { PrismaService } from '../../../../core/database/prisma.service';
import { SecurityEventService } from '../../../security-events/security-event.service';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiInteraction, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { canonicalSourceSha256, validateCatalogDocument } from '../../catalog-tooling/catalog-generator';
import { PRODUCTION_DEFI_MANIFEST } from '../production-registry';
import { loadCurrentProductionExpectations } from '../__fixtures__/current-production-expectations';
import { executionScopeHash } from '../../execution/scope';
import { buildSdaiSavingsRegistry, SDAI_SAVINGS_CAPABILITIES } from './index';

const CONTRACT = '0x83f20f44975d03b1b09e64809b757c47f942beea';
const MAX = (1n << 256n) - 1n;
const USER = 'user';
const API_KEY_ID = '00000000-0000-4000-8000-000000000001';
const OWNER = '0x0000000000000000000000000000000000000002';
const OTHER = '0x0000000000000000000000000000000000000003';
const RECIPIENT = '0x0000000000000000000000000000000000000004';
const sourcePath = 'data/defi-catalog/v9/sources/sdai-savings.json';
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const sourceFamily = source.families.find((family: any) => family.familyId === 'sdai-savings');
const contractSource = sourceFamily.contracts[0];
const builder = buildSdaiSavingsRegistry();
const baselineIds = PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => fn.capabilityId);
const candidateIds = SDAI_SAVINGS_CAPABILITIES.map((fn) => fn.capabilityId);
// Use the pinned historical v8 artifact, not subtraction from an evolving current production catalog.
const historicalV8Projection = validateCatalogDocument(JSON.parse(readFileSync('data/defi-catalog/v8/catalog.json', 'utf8'))).chains;

function argsFor(fn: DefiFunctionPolicy, maxValues = false): readonly unknown[] {
  const amount = maxValues ? MAX : 0n;
  if (fn.functionName === 'deposit' || fn.functionName === 'mint') return [amount, RECIPIENT];
  return [amount, RECIPIENT, OWNER];
}

function interaction(fn: DefiFunctionPolicy, args = argsFor(fn)): DefiInteraction {
  return { to: CONTRACT, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args } as never) };
}

function makePolicy(pausedScopeKeys: string[] = [], events = { record: jest.fn().mockResolvedValue(undefined) }) {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
  const manifest = buildReviewedManifest([{ chains: historicalV8Projection }, builder]);
  const catalog = new DefiCatalogService(manifest.chains, prisma as unknown as PrismaService, manifest);
  return { policy: new DefiPolicyService(prisma as unknown as PrismaService, events as unknown as SecurityEventService, catalog), prisma, manifest, events };
}

function finalTx(grants = candidateIds, pausedScopeKeys: string[] = []) {
  return {
    $queryRaw: jest.fn(),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants }) },
  };
}

describe('sDAI no-referral isolated registry fixture', () => {
  it('binds exactly four declared implementation ABIs, full identities, source roles, and the frozen source digest', () => {
    expect(contractSource).toMatchObject({ chainId: 1, address: CONTRACT, status: 'inactive', contractName: 'SavingsDai' });
    expect(contractSource.abiFunctions.map((fn: any) => fn.name)).toEqual(['deposit', 'mint', 'withdraw', 'redeem']);
    expect(contractSource.abiFunctions.every((fn: any) => fn.stateMutability === 'nonpayable')).toBe(true);
    expect(source.sources.find((item: any) => item.sourceId === 'maker-sdai-mainnet-role-2023-11-02')).toMatchObject({
      url: 'https://github.com/makerdao/sdai/blob/2b7acb95289a9eb3a8844206d5712eabfa206efc/README.md',
      retrievedAt: '2026-10-04',
    });
    expect(source.sources.find((item: any) => item.sourceId === 'maker-sdai-mainnet-role-2023-11-02')?.notes).toMatch(/publication.*2023-11-02.*inspected on 2026-10-04/i);
    expect(source.sources.find((item: any) => item.sourceId === 'maker-sdai-no-referral-implementation-66587976')).toMatchObject({
      url: 'https://github.com/makerdao/sdai/blob/665879762f8b5df5d234463f45d1d6a49bd4fbeb/src/SavingsDai.sol',
      retrievedAt: '2026-10-04',
    });
    expect(source.sources.find((item: any) => item.sourceId === 'maker-sdai-interface-66587976')?.retrievedAt).toBe('2026-10-04');
    expect(source.sources.find((item: any) => item.sourceId === 'maker-sdai-interface-66587976')?.notes).toMatch(/interface parameters\/returns are unnamed/i);

    const parsed = buildReviewedManifest([builder]).capabilities;
    expect(parsed).toHaveLength(4);
    expect(SDAI_SAVINGS_CAPABILITIES).toHaveLength(4);
    const expectedNames = ['deposit', 'mint', 'withdraw', 'redeem'];
    const expectedSignatures = [
      'deposit(uint256,address)',
      'mint(uint256,address)',
      'withdraw(uint256,address,address)',
      'redeem(uint256,address,address)',
    ];
    const expectedSelectors = ['0x6e553f65', '0x94bf804d', '0xb460af94', '0xba087652'];
    const expectedHashes = [
      '0xd9aa3738e0f53bd8105b8c7e2517c7338d49553e906e80abf32af4c3a38f5997',
      '0xb8f77e58b52fad3ac88bf14cb752b27c8e41983c8c149319e73db4c84f21e352',
      '0x59b31bf3102e98ba6650eb9794b53143fd4c1b90166242569843084f9d8df901',
      '0x8926ac0e897fc0dab6e7c43a4888021fd1b5270b6fb7e3046f6023c3c637444e',
    ];
    for (let index = 0; index < expectedNames.length; index++) {
      const fn = parsed.find((candidate) => candidate.functionName === expectedNames[index])!;
      const sourceFn = contractSource.abiFunctions.find((candidate: any) => candidate.name === expectedNames[index]);
      const { sourceId: _sourceId, ...literalAbi } = sourceFn;
      expect(fn.abi).toEqual(literalAbi);
      expect(fn.functionName).toBe(expectedNames[index]);
      expect(fn.signature).toBe(expectedSignatures[index]);
      expect(fn.capabilityId).toBe(`sdai-savings:no-referral-v1:1:${CONTRACT}:${expectedNames[index]}`);
      expect(toFunctionSelector(fn.signature)).toBe(expectedSelectors[index]);
      expect(functionAbiHash(fn)).toBe(expectedHashes[index]);
      expect(fn.abiHash).toBeUndefined();
      expect(fn.status).toBe('active');
      expect(fn.executionScope).toBeUndefined();
    }
    const sourceDigest = canonicalSourceSha256(source);
    expect(sourceDigest).toBe('c1ca1ed92e19a6958b7b5824cf340d82f127605ce0e9e2d531c43dd61258c862');
    expect(sourceDigest).toBe(canonicalSourceSha256(JSON.parse(JSON.stringify(source))));
    expect(sourceFamily.familyVersion).toBe('no-referral-v1@66587976');
  });

  it('uses pinned v8 directly, then adds only the four sDAI methods', () => {
    expect(historicalV8Projection.flatMap((chain) => chain.contracts).some((entry) => entry.address.toLowerCase() === CONTRACT)).toBe(false);
    expect(candidateIds).toEqual([
      `sdai-savings:no-referral-v1:1:${CONTRACT}:deposit`,
      `sdai-savings:no-referral-v1:1:${CONTRACT}:mint`,
      `sdai-savings:no-referral-v1:1:${CONTRACT}:withdraw`,
      `sdai-savings:no-referral-v1:1:${CONTRACT}:redeem`,
    ]);
    expect(candidateIds.every((id) => baselineIds.includes(id))).toBe(true);
    const projectedIds = historicalV8Projection.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId)));
    expect(candidateIds.some((id) => projectedIds.includes(id))).toBe(false);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(loadCurrentProductionExpectations(process.cwd()).definitions);
    const pinnedV8 = buildReviewedManifest([JSON.parse(readFileSync('data/defi-catalog/v8/catalog.json', 'utf8'))]);
    const projectedV8 = buildReviewedManifest([{ chains: historicalV8Projection }]);
    expect(pinnedV8.capabilities).toHaveLength(669);
    expect(projectedV8.capabilities).toHaveLength(669);
    expect(projectedV8.capabilities).toEqual(pinnedV8.capabilities);
    expect(historicalV8Projection.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions))).toHaveLength(669);
    const combined = buildReviewedManifest([{ chains: historicalV8Projection }, builder]);
    expect(combined.capabilities).toHaveLength(673);
    const pinnedV9 = buildReviewedManifest([JSON.parse(readFileSync('data/defi-catalog/v9/catalog.json', 'utf8'))]);
    for (const original of pinnedV9.capabilities.filter((fn) => !candidateIds.includes(fn.capabilityId))) {
      expect(combined.capabilities.find((fn) => fn.capabilityId === original.capabilityId)).toEqual(original);
    }
    const originalScopeHashes = pinnedV8.capabilities.filter((fn) => fn.executionScope).map((fn) => executionScopeHash(fn.executionScope!)).sort();
    const fixtureScopeHashes = combined.capabilities.filter((fn) => fn.executionScope).map((fn) => executionScopeHash(fn.executionScope!)).sort();
    expect(fixtureScopeHashes).toEqual(originalScopeHashes);
  });
});

describe('sDAI explicit-grant policy fixture', () => {
  const contextFor = (fn: DefiFunctionPolicy, allowedCapabilityIds = [fn.capabilityId], chainId = 1): DefiExecutionContext => ({
    userId: USER,
    apiKeyId: API_KEY_ID,
    walletId: 'wallet',
    chainId,
    executionMode: 'session_key',
    executionOwner: OTHER,
    allowedCapabilityIds,
  });

  it.each(SDAI_SAVINGS_CAPABILITIES)('authorizes $functionName with exact grant as one ordinary root and keeps ABI values caller-selected', async (fn) => {
    const { policy } = makePolicy();
    for (const maxValues of [false, true]) {
      const call = interaction(fn, argsFor(fn, maxValues));
      const authorization = await policy.authorizeContractCalls([call], contextFor(fn));
      expect(authorization.matches).toHaveLength(1);
      expect(authorization.matches[0]).toMatchObject({ capabilityId: fn.capabilityId, chainId: 1, contract: CONTRACT, functionSignature: fn.signature });
      expect(authorization.executionPlan).toHaveLength(1);
      expect(authorization.executionPlan[0].path).toEqual([0]);
      await expect(policy.assertStillAuthorized(finalTx() as never, authorization)).resolves.toBeUndefined();
    }
  });

  it.each(SDAI_SAVINGS_CAPABILITIES)('denies missing/unrelated grants and malformed identity or nonpayable value for $functionName', async (fn) => {
    const { policy } = makePolicy();
    const call = interaction(fn);
    await expect(policy.authorizeContractCalls([call], contextFor(fn, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call], contextFor(fn, ['unrelated:grant']))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(makePolicy([`capability:${fn.capabilityId}`]).policy.authorizeContractCalls([call], contextFor(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    await expect(policy.authorizeContractCalls([call], contextFor(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call, to: OTHER }], contextFor(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call, data: `0xdeadbeef${call.data.slice(10)}` }], contextFor(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call, data: `${call.data}00` }], contextFor(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...call, data: call.data.slice(0, -2) }], contextFor(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...call, value: '1' }], contextFor(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rechecks grants, pauses, key revocation/freeze and ordered-plan commitment under the existing final lock sequence', async () => {
    const { policy } = makePolicy();
    for (const fn of SDAI_SAVINGS_CAPABILITIES) {
      let authorization = await policy.authorizeContractCalls([interaction(fn, argsFor(fn))], contextFor(fn));
      let validTx = finalTx();
      await expect(policy.assertStillAuthorized(validTx as never, authorization)).resolves.toBeUndefined();
      expect(validTx.$queryRaw).toHaveBeenCalledTimes(2);
      let lockSql = validTx.$queryRaw.mock.calls.map(([strings]) => strings.join(' ').replace(/\s+/g, ' ').trim());
      expect(lockSql[0]).toContain('defi_policy_state');
      expect(lockSql[0]).toContain('FOR SHARE');
      expect(lockSql[1]).toContain('api_keys');
      expect(lockSql[1]).toContain('FOR UPDATE');
      expect(validTx.$queryRaw.mock.calls[1][1]).toBe(API_KEY_ID);
      authorization = await policy.authorizeContractCalls([interaction(fn, argsFor(fn, true))], contextFor(fn));
      validTx = finalTx();
      await expect(policy.assertStillAuthorized(validTx as never, authorization)).resolves.toBeUndefined();
      expect(validTx.$queryRaw).toHaveBeenCalledTimes(2);
      lockSql = validTx.$queryRaw.mock.calls.map(([strings]) => strings.join(' ').replace(/\s+/g, ' ').trim());
      expect(lockSql[0]).toContain('FOR SHARE');
      expect(lockSql[1]).toContain('FOR UPDATE');
      expect(validTx.$queryRaw.mock.calls[1][1]).toBe(API_KEY_ID);

      const otherGrants = candidateIds.filter((id) => id !== fn.capabilityId);
      await expect(policy.assertStillAuthorized(finalTx(otherGrants) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.assertStillAuthorized(finalTx(['unrelated:grant']) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.assertStillAuthorized(finalTx(candidateIds, [`capability:${fn.capabilityId}`]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      const revoked = finalTx();
      revoked.apiKey.findUnique.mockResolvedValue({ userId: USER, revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: candidateIds });
      await expect(policy.assertStillAuthorized(revoked as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      const frozen = finalTx();
      frozen.apiKey.findUnique.mockResolvedValue({ userId: USER, revoked: false, frozenAt: new Date(), expiresAt: null, canSendTransaction: true, allowedCapabilityIds: candidateIds });
      await expect(policy.assertStillAuthorized(frozen as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], data: '0xdeadbeef' as Hex }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], path: [1] }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], match: { ...authorization.executionPlan[0].match, contract: OTHER } }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], match: { ...authorization.executionPlan[0].match, nativeValue: '1' } }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, interactions: [{ ...authorization.interactions[0], to: OTHER }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, interactions: [{ ...authorization.interactions[0], data: '0xdeadbeef' }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(validTx as never, { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });
});

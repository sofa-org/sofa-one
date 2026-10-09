import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';
import { buildReviewedManifest, functionAbiHash } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';
import { validateCatalogDocument } from '../catalog-tooling/catalog-generator';

const POOLS = [
  { chainId: 1, address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' },
  { chainId: 10, address: '0x794a61358d6845594f94dc1db02a252b5b4814ad' },
  { chainId: 137, address: '0x794a61358d6845594f94dc1db02a252b5b4814ad' },
  { chainId: 8453, address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5' },
  { chainId: 42161, address: '0x794a61358d6845594f94dc1db02a252b5b4814ad' },
];
const IDS = POOLS.map(({ chainId, address }) => `aave-v3:v3-origin:${chainId}:${address}:set-user-use-reserve-as-collateral`);
const LEGACY_METHODS = ['borrow', 'repay', 'supply', 'withdraw'];
const EXPECTED = {
  signature: 'setUserUseReserveAsCollateral(address,bool)',
  selector: '0x5a3b74b9',
  abiHash: '0x2294fd1903e82223e42d8d52c96a6e6a704d31eab78d24677917efc6360045ef',
};
const USER = 'aave-collateral-toggle-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000072';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const ASSETS = ['0x0000000000000000000000000000000000000000', '0x6666666666666666666666666666666666666666'];
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function policyFixture() {
  const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
  return new DefiPolicyService(db as never, {} as never, catalog);
}

function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = fn.chainId): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: EXECUTION_OWNER, allowedCapabilityIds: grants };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

function call(fn: DefiFunctionPolicy, asset: string, enabled: boolean) {
  return {
    to: fn.contract,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [asset, enabled] }),
  };
}

function legacyIds(pool: typeof POOLS[number]) {
  return [
    ...LEGACY_METHODS.map((name) => `aave-v3:${pool.chainId}:${pool.address}:${name}`),
    `aave-v3:v3-origin:${pool.chainId}:${pool.address}:repay-with-a-tokens`,
  ];
}

describe('Aave V3 setUserUseReserveAsCollateral five-chain ordinary additions', () => {
  it('binds all five exact Pool identities and authorizes either bool with caller-selected assets only by each exact new grant', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    const baselineDocument = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/aave-atoken-repay-arbitrum-polygon/catalog.json'), 'utf8')));
    const baselineDefinitions = buildReviewedManifest([baselineDocument]).capabilities.length;
    expect(baselineDefinitions).toBe(682);
    const updateDocument = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/aave-collateral-toggle/catalog.json'), 'utf8')));
    expect(buildReviewedManifest([updateDocument]).capabilities).toHaveLength(baselineDefinitions + 5);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect(functions).toHaveLength(5);
    const policy = policyFixture();

    for (const [index, fn] of functions.entries()) {
      expect(fn).toMatchObject({ capabilityId: IDS[index], chainId: POOLS[index].chainId, contract: POOLS[index].address, signature: EXPECTED.signature, functionName: 'setUserUseReserveAsCollateral', status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toMatchObject({ type: 'function', name: 'setUserUseReserveAsCollateral', stateMutability: 'nonpayable' });
      expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: 'asset', type: 'address', internalType: 'address' },
        { name: 'useAsCollateral', type: 'bool', internalType: 'bool' },
      ]);
      expect(fn.abi.outputs).toEqual([]);
      expect(toFunctionSelector(fn.signature)).toBe(EXPECTED.selector);
      expect(functionAbiHash(fn)).toBe(EXPECTED.abiHash);
      expect(fn.executionScope).toBeUndefined();
      for (const asset of ASSETS) {
        expect(asset.toLowerCase()).not.toBe(EXECUTION_OWNER.toLowerCase());
        for (const enabled of [false, true]) {
          const authorization = await policy.authorizeContractCalls([call(fn, asset, enabled)], context(fn));
          expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, chainId: fn.chainId, contract: fn.contract, functionSignature: EXPECTED.signature, abiHash: EXPECTED.abiHash })]);
          await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
        }
      }
    }
    expect(IDS.every((id) => PRODUCTION_DEFI_CAPABILITY_BUNDLES.every((profile) => !profile.capabilityIds.includes(id)))).toBe(true);
  });

  it('denies missing/unrelated/legacy grants, wrong target or chain, malformed bool/data, and nonpayable value', async () => {
    const policy = policyFixture();
    for (const [index, fn] of functions.entries()) {
      const tx = call(fn, ASSETS[1], true);
      const otherNewIds = IDS.filter((id) => id !== fn.capabilityId);
      for (const grants of [[], otherNewIds, legacyIds(POOLS[index])]) {
        await expect(policy.authorizeContractCalls([tx], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([tx], context(fn, [fn.capabilityId], 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, to: '0x7777777777777777777777777777777777777777' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      const noncanonicalBool = `${EXPECTED.selector}${'0'.repeat(64)}${'0'.repeat(63)}2`;
      await expect(policy.authorizeContractCalls([{ ...tx, data: noncanonicalBool }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks removed grants, pause, API-key state, SQL lock order, and final call/manifest bindings', async () => {
    for (const [index, fn] of functions.entries()) {
      const policy = policyFixture();
      const authorization = await policy.authorizeContractCalls([call(fn, ASSETS[index % ASSETS.length], true)], context(fn));
      const goodTx = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(goodTx as never, authorization)).resolves.toBeUndefined();
      const lockQueries = goodTx.$queryRaw.mock.calls.map(([query]) => query.join(''));
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(lockQueries[1]).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(lockQueries[1]).toContain('FOR UPDATE');
      expect(goodTx.$queryRaw.mock.calls[1][1]).toBe(KEY_ID);

      await expect(policy.assertStillAuthorized(finalTx([]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId], [`capability:${fn.capabilityId}`]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      for (const keyState of [
        { revoked: true },
        { frozenAt: new Date() },
        { expiresAt: new Date(Date.now() - 60_000) },
        { canSendTransaction: false },
      ]) {
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId], [], keyState) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      }

      const altered = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: ASSETS[index % ASSETS.length] }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: call(fn, ASSETS[index % ASSETS.length], false).data }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: IDS[(index + 1) % IDS.length] } })) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      for (const tampered of altered) await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, tampered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });
});

import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';
import { functionAbiHash } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';

const POOLS = [
  { chainId: 1, address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' },
  { chainId: 10, address: '0x794a61358d6845594f94dc1db02a252b5b4814ad' },
  { chainId: 8453, address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5' },
];
const IDS = POOLS.map(({ chainId, address }) => `aave-v3:v3-origin:${chainId}:${address}:repay-with-a-tokens`);
const LEGACY_METHODS = ['borrow', 'repay', 'supply', 'withdraw'];
const EXPECTED = {
  signature: 'repayWithATokens(address,uint256,uint256)',
  selector: '0x2dad97d4',
  abiHash: '0x71271224f317a07c84a48e0f3a9604bcfc9c0045f99457edfea937c25ae0cada',
};
const USER = 'aave-atoken-repay-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000070';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const ASSETS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
];
const MAX = (1n << 256n) - 1n;
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

function call(fn: DefiFunctionPolicy, index: number, edge: 'zero' | 'max' = 'zero') {
  const value = edge === 'max' ? MAX : 0n;
  return {
    to: fn.contract,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [ASSETS[index], value, value] }),
  };
}

function legacyIds(pool: typeof POOLS[number]) {
  return LEGACY_METHODS.map((name) => `aave-v3:${pool.chainId}:${pool.address}:${name}`);
}

describe('Aave V3 repayWithATokens ordinary additions in the production policy', () => {
  it('binds all three exact Pool identities and authorizes zero/MAX caller-selected ABI values only by each exact new grant', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect(functions).toHaveLength(3);
    const policy = policyFixture();

    for (const [index, fn] of functions.entries()) {
      expect(fn).toMatchObject({ capabilityId: IDS[index], chainId: POOLS[index].chainId, contract: POOLS[index].address, signature: EXPECTED.signature, functionName: 'repayWithATokens', status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toMatchObject({ type: 'function', name: 'repayWithATokens', stateMutability: 'nonpayable' });
      expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: 'asset', type: 'address', internalType: 'address' },
        { name: 'amount', type: 'uint256', internalType: 'uint256' },
        { name: 'interestRateMode', type: 'uint256', internalType: 'uint256' },
      ]);
      expect(fn.abi.outputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: '', type: 'uint256', internalType: 'uint256' },
      ]);
      expect(toFunctionSelector(fn.signature)).toBe(EXPECTED.selector);
      expect(functionAbiHash(fn)).toBe(EXPECTED.abiHash);
      expect(fn.executionScope).toBeUndefined();
      for (const edge of ['zero', 'max'] as const) {
        const authorization = await policy.authorizeContractCalls([call(fn, index, edge)], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, chainId: fn.chainId, contract: fn.contract, functionSignature: EXPECTED.signature, abiHash: EXPECTED.abiHash })]);
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
      }
    }
    expect(IDS.every((id) => PRODUCTION_DEFI_CAPABILITY_BUNDLES.every((profile) => !profile.capabilityIds.includes(id)))).toBe(true);
  });

  it('denies missing/new-chain/legacy Aave grants, wrong target or chain, malformed selectors/data, and nonpayable value', async () => {
    const policy = policyFixture();
    for (const [index, fn] of functions.entries()) {
      const tx = call(fn, index);
      const otherNewIds = IDS.filter((id) => id !== fn.capabilityId);
      for (const grants of [[], otherNewIds, legacyIds(POOLS[index])]) {
        await expect(policy.authorizeContractCalls([tx], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([tx], context(fn, [fn.capabilityId], 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, to: '0x7777777777777777777777777777777777777777' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks removed grants, pause, API-key state, lock order, and final call/manifest bindings', async () => {
    for (const [index, fn] of functions.entries()) {
      const policy = policyFixture();
      const interaction = call(fn, index);
      const authorization = await policy.authorizeContractCalls([interaction], context(fn));
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
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: ASSETS[index] }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: call(fn, index, 'max').data }] },
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

import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';
import { functionAbiHash } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';

const TARGET = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const USER = 'comet-delegated-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000069';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const IDS = [
  'compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:supply-from',
  'compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:withdraw-from',
];
const OLD_COMET_IDS = [
  'compound-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:supply',
  'compound-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:withdraw',
];
const EXPECTED = [
  { signature: 'supplyFrom(address,address,address,uint256)', selector: '0x90323177', abiHash: '0x2020844e720825b6535b604bbce504a6c09b7559bebcaea5e59ffdeab1bd06c8' },
  { signature: 'withdrawFrom(address,address,address,uint256)', selector: '0x26441318', abiHash: '0x0348abeab1659c7f632296771445107e1f2ef6f40085865cf627fca8c21c5462' },
];
const MAX = (1n << 256n) - 1n;
const ARGS = [
  ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'],
  ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555', '0x6666666666666666666666666666666666666666'],
];
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function prisma(pausedScopeKeys: string[] = []) {
  return { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
}

function policyFixture() {
  const db = prisma();
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
  return new DefiPolicyService(db as never, {} as never, catalog);
}

function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = 1): DefiExecutionContext {
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
  return {
    to: fn.contract,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [...ARGS[index], edge === 'max' ? MAX : 0n] as never }),
  };
}

describe('Compound Comet USDC delegated ordinary additions in the production policy', () => {
  it('binds both complete ABI identities and authorizes arbitrary delegated arguments with only each exact grant', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect(functions).toHaveLength(2);
    const policy = policyFixture();

    for (const [index, fn] of functions.entries()) {
      expect(fn).toMatchObject({ capabilityId: IDS[index], chainId: 1, contract: TARGET, signature: EXPECTED[index].signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toMatchObject({ type: 'function', name: fn.functionName, stateMutability: 'nonpayable', outputs: [] });
      expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: index === 0 ? 'from' : 'src', type: 'address', internalType: 'address' },
        { name: index === 0 ? 'dst' : 'to', type: 'address', internalType: 'address' },
        { name: 'asset', type: 'address', internalType: 'address' },
        { name: 'amount', type: 'uint256', internalType: 'uint256' },
      ]);
      expect(toFunctionSelector(fn.signature)).toBe(EXPECTED[index].selector);
      expect(functionAbiHash(fn)).toBe(EXPECTED[index].abiHash);
      expect(fn.executionScope).toBeUndefined();
      expect(ARGS[index][0]).not.toBe(EXECUTION_OWNER);
      expect(ARGS[index][1]).not.toBe(EXECUTION_OWNER);

      for (const edge of ['zero', 'max'] as const) {
        const interaction = call(fn, index, edge);
        const authorization = await policy.authorizeContractCalls([interaction], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, chainId: 1, contract: TARGET, functionSignature: fn.signature, abiHash: EXPECTED[index].abiHash })]);
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
      }
    }
    expect(IDS.every((id) => PRODUCTION_DEFI_CAPABILITY_BUNDLES.every((profile) => !profile.capabilityIds.includes(id)))).toBe(true);
  });

  it('denies empty, unrelated, and previous nondelegated grants plus wrong chain/target/selector, malformed data, and value', async () => {
    const policy = policyFixture();
    for (const [index, fn] of functions.entries()) {
      const tx = call(fn, index);
      const unrelated = functions.find((other) => other.capabilityId !== fn.capabilityId)!.capabilityId;
      for (const grants of [[], [unrelated], OLD_COMET_IDS]) {
        await expect(policy.authorizeContractCalls([tx], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([tx], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, to: ARGS[index][0] }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks grant, pause, API-key state, ordered locks, and final authorization bindings for each method', async () => {
    for (const [index, fn] of functions.entries()) {
      const policy = policyFixture();
      const interaction = call(fn, index);
      const authorization = await policy.authorizeContractCalls([interaction], context(fn));
      const validTx = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(validTx as never, authorization)).resolves.toBeUndefined();
      const lockQueries = validTx.$queryRaw.mock.calls.map(([query]) => query.join(''));
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(lockQueries[1]).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(lockQueries[1]).toContain('FOR UPDATE');
      expect(validTx.$queryRaw.mock.calls[1][1]).toBe(KEY_ID);

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
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: ARGS[index][0] }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: call(fn, index, 'max').data }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: IDS[1 - index] } })) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      for (const tampered of altered) await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, tampered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });
});

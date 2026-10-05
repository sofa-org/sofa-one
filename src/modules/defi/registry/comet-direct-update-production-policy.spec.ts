import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { functionAbiHash } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';

const TARGET = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const USER = 'comet-direct-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000068';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const IDS = [
  'compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:supply-to',
  'compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:withdraw-to',
];
const EXPECTED = [
  { signature: 'supplyTo(address,address,uint256)', selector: '0x4232cd63', abiHash: '0x354ce7510e69b2b82081178c5da4c8af37e411423425ad7b60bb8be5846207df' },
  { signature: 'withdrawTo(address,address,uint256)', selector: '0xc3b35a7e', abiHash: '0xbbbf820ef51e8eeaaca6ae4dcabb7d4e5e9eec5bf4221405b1e5ea0d9b6dfea0' },
];
const MAX = (1n << 256n) - 1n;
const ADDRESSES = {
  executionOwner: EXECUTION_OWNER,
  supplyDst: '0x1111111111111111111111111111111111111111',
  supplyAsset: '0x2222222222222222222222222222222222222222',
  withdrawTo: '0x3333333333333333333333333333333333333333',
  withdrawAsset: '0x4444444444444444444444444444444444444444',
  otherWallet: '0x5555555555555555555555555555555555555555',
};
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function prisma(pausedScopeKeys: string[] = []) {
  return { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
}

function policyFixture(pausedScopeKeys: string[] = []) {
  const db = prisma(pausedScopeKeys);
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
  return { db, policy: new DefiPolicyService(db as never, {} as never, catalog) };
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

function call(fn: DefiFunctionPolicy, edge: 'zero' | 'max' = 'zero', recipient?: string) {
  const amount = edge === 'max' ? MAX : 0n;
  const args = fn.functionName === 'supplyTo'
    ? [recipient ?? ADDRESSES.supplyDst, ADDRESSES.supplyAsset, amount]
    : [recipient ?? ADDRESSES.withdrawTo, ADDRESSES.withdrawAsset, amount];
  return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }) };
}

describe('Compound Comet USDC direct additions in the production policy', () => {
  it('binds both exact ordinary ABI identities and authorizes independently granted caller-selected zero/MAX arguments', async () => {
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(675);
    expect(functions).toHaveLength(2);
    const { policy } = policyFixture();

    for (const [index, fn] of functions.entries()) {
      expect(fn).toMatchObject({ capabilityId: IDS[index], chainId: 1, contract: TARGET, signature: EXPECTED[index].signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toMatchObject({ type: 'function', name: fn.functionName, stateMutability: 'nonpayable', outputs: [] });
      expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: index === 0 ? 'dst' : 'to', type: 'address', internalType: 'address' },
        { name: 'asset', type: 'address', internalType: 'address' },
        { name: 'amount', type: 'uint256', internalType: 'uint256' },
      ]);
      expect(toFunctionSelector(fn.signature)).toBe(EXPECTED[index].selector);
      expect(functionAbiHash(fn)).toBe(EXPECTED[index].abiHash);
      expect(fn.executionScope).toBeUndefined();

      for (const edge of ['zero', 'max'] as const) {
        const interaction = call(fn, edge);
        const authorization = await policy.authorizeContractCalls([interaction], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, chainId: 1, contract: TARGET, functionSignature: fn.signature, abiHash: EXPECTED[index].abiHash })]);
        expect(authorization.executionPlan).toHaveLength(1);
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
      }
    }
    expect(ADDRESSES.supplyDst).not.toBe(ADDRESSES.executionOwner);
    expect(ADDRESSES.withdrawTo).not.toBe(ADDRESSES.executionOwner);
    expect(ADDRESSES.supplyDst).not.toBe(ADDRESSES.withdrawTo);
  });

  it('denies missing/unrelated grants, wrong chain/target/selector, malformed calldata, and nonzero value', async () => {
    const { policy } = policyFixture();
    for (const fn of functions) {
      const tx = call(fn, 'zero');
      const unrelated = functions.find((other) => other.capabilityId !== fn.capabilityId)!.capabilityId;
      await expect(policy.authorizeContractCalls([tx], context(fn, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([tx], context(fn, [unrelated]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([tx], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, to: ADDRESSES.otherWallet }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks removed grants, key state, pause, and authorization commitments at final authorization', async () => {
    for (const fn of functions) {
      const { policy } = policyFixture();
      const tx = call(fn, 'zero');
      const authorization = await policy.authorizeContractCalls([tx], context(fn));
      const validTx = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(validTx as never, authorization)).resolves.toBeUndefined();
      const locks = validTx.$queryRaw.mock.calls.map(([query]) => query.join(''));
      expect(locks).toHaveLength(2);
      expect(locks[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(locks[1]).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(locks[1]).toContain('FOR UPDATE');
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

      const mutated = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: ADDRESSES.otherWallet }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: call(fn, 'max').data }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node, index) => index === 0 ? { ...node, match: { ...node.match, capabilityId: IDS[1 - functions.indexOf(fn)] } } : node) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      for (const altered of mutated) await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, altered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });
});

import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { V9_SDAI_BINDINGS } from '../catalog-tooling/v9-identities';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';

const CONTRACT = '0x83f20f44975d03b1b09e64809b757c47f942beea';
const USER = 'v9-sdai-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000009';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const RECEIVER = '0x0000000000000000000000000000000000000002';
const OWNER = '0x0000000000000000000000000000000000000003';
const MAX = (1n << 256n) - 1n;
const functions = V9_SDAI_BINDINGS.map((binding) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === binding.capabilityId)!) as DefiFunctionPolicy[];

function args(fn: DefiFunctionPolicy, edge: 'zero' | 'max' = 'zero') {
  const amount = edge === 'max' ? MAX : 0n;
  return fn.functionName === 'deposit' || fn.functionName === 'mint'
    ? [amount, RECEIVER]
    : [amount, RECEIVER, OWNER];
}
function call(fn: DefiFunctionPolicy, values = args(fn)) {
  return { to: CONTRACT, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values } as never) };
}
function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = 1): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: EXECUTION_OWNER, allowedCapabilityIds: grants };
}
function mockPrisma(pausedScopeKeys: string[] = []) {
  return { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
}
function makePolicy(pausedScopeKeys: string[] = []) {
  const prisma = mockPrisma(pausedScopeKeys);
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, prisma as never, PRODUCTION_DEFI_MANIFEST);
  return { policy: new DefiPolicyService(prisma as never, {} as never, catalog), prisma };
}
function finalTx(grants: string[] = functions.map((fn) => fn.capabilityId), pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('integrated v9 sDAI production policy fixture', () => {
  it('loads the four exact active source-qualified identities and authorizes only ordinary, individually granted roots', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(functions).toHaveLength(4);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.type === 'contract_call' && fn.functionName !== 'approve')).toHaveLength(expected.actions);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(expected.approvals);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope)).toHaveLength(expected.capabilities.filter((fn) => fn.executionScope).length);
    for (const [index, fn] of functions.entries()) {
      const identity = V9_SDAI_BINDINGS[index];
      expect(fn).toMatchObject({ capabilityId: identity.capabilityId, chainId: 1, contract: CONTRACT, signature: identity.signature, status: 'active', provenance: { status: 'verified' } });
      expect(toFunctionSelector(fn.signature)).toBe(identity.selector);
      expect(fn.executionScope).toBeUndefined();
      expect(fn.abi.stateMutability).toBe('nonpayable');
      expect(fn.type).toBe('contract_call');
      expect(fn.operation).not.toBe('approve');
    }
    const { policy } = makePolicy();
    for (const fn of functions) {
      for (const edge of ['zero', 'max'] as const) {
        const interaction = call(fn, args(fn, edge));
        const authorization = await policy.authorizeContractCalls([interaction], context(fn));
        expect(authorization.matches).toHaveLength(1);
        expect(authorization.matches[0]).toMatchObject({ capabilityId: fn.capabilityId, chainId: 1, contract: CONTRACT, functionSignature: fn.signature });
        expect(authorization.executionPlan).toHaveLength(1);
        expect(authorization.executionPlan[0].path).toEqual([0]);
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
      }
      const tx = call(fn, args(fn));
      await expect(policy.authorizeContractCalls([tx], context(fn, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([tx], context(fn, [functions.find((other) => other.capabilityId !== fn.capabilityId)!.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(makePolicy([`capability:${fn.capabilityId}`]).policy.authorizeContractCalls([tx], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      await expect(policy.authorizeContractCalls([tx], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, to: OWNER }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      expect(fn.abi.inputs.some((input) => input.type === 'address')).toBe(true);
      expect(args(fn).slice(1)).toContain(RECEIVER);
      if (fn.functionName === 'withdraw' || fn.functionName === 'redeem') expect(args(fn)[2]).toBe(OWNER);
    }
  });

  it('rechecks per-capability pauses, removed grants, key state and final commitment/plan mutation', async () => {
    const { policy } = makePolicy();
    for (const fn of functions) {
      const authorization = await policy.authorizeContractCalls([call(fn)], context(fn));
      const valid = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(valid as never, authorization)).resolves.toBeUndefined();
      const sql = valid.$queryRaw.mock.calls.map(([query]) => query.join(''));
      expect(sql).toHaveLength(2);
      expect(sql[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(sql[1]).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(sql[1]).toContain('FOR UPDATE');
      expect(valid.$queryRaw.mock.calls[1][1]).toBe(KEY_ID);
      await expect(policy.assertStillAuthorized(finalTx([], []) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId], [`capability:${fn.capabilityId}`]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId], [], { revoked: true }) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId], [], { frozenAt: new Date() }) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
    const fn = functions[0];
    const authorization = await policy.authorizeContractCalls([call(fn)], context(fn));
    const valid = finalTx([fn.capabilityId]);
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, interactions: [{ ...authorization.interactions[0], to: OWNER }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, interactions: [{ ...authorization.interactions[0], data: '0xdeadbeef' }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], match: { ...authorization.executionPlan[0].match, capabilityId: 'unrelated' } }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], path: [1] }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(valid as never, { ...authorization, executionPlan: [{ ...authorization.executionPlan[0], match: { ...authorization.executionPlan[0].match, nativeValue: '1' } }] })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });
});

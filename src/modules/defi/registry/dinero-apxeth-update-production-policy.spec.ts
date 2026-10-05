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

const TARGET = '0x9ba021b0a9b958b5e75ce9f6dff97c7ee52cb3e6';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const OTHER_OWNER = '0x3333333333333333333333333333333333333333';
const SPECS = [
  { name: 'deposit', signature: 'deposit(uint256,address)', selector: '0x6e553f65', hash: '0xd9aa3738e0f53bd8105b8c7e2517c7338d49553e906e80abf32af4c3a38f5997', inputs: ['assets', 'receiver'], output: 'shares', arity: 2 },
  { name: 'mint', signature: 'mint(uint256,address)', selector: '0x94bf804d', hash: '0xb8f77e58b52fad3ac88bf14cb752b27c8e41983c8c149319e73db4c84f21e352', inputs: ['shares', 'receiver'], output: 'assets', arity: 2 },
  { name: 'withdraw', signature: 'withdraw(uint256,address,address)', selector: '0xb460af94', hash: '0x59b31bf3102e98ba6650eb9794b53143fd4c1b90166242569843084f9d8df901', inputs: ['assets', 'receiver', 'owner'], output: 'shares', arity: 3 },
  { name: 'redeem', signature: 'redeem(uint256,address,address)', selector: '0xba087652', hash: '0x8926ac0e897fc0dab6e7c43a4888021fd1b5270b6fb7e3046f6023c3c637444e', inputs: ['shares', 'receiver', 'owner'], output: 'assets', arity: 3 },
];
const IDS = SPECS.map(({ name }) => `dinero-apxeth:v1:1:${TARGET}:${name}`);
const EXECUTION_OWNER = '0x9999999999999999999999999999999999999999';
const USER = 'dinero-apxeth-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000111';
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = fn.chainId): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: EXECUTION_OWNER, allowedCapabilityIds: grants };
}

function tx(fn: DefiFunctionPolicy, amount: bigint, receiver: `0x${string}`, owner = EXECUTION_OWNER) {
  const args = fn.abi.inputs.length === 2 ? [amount, receiver] : [amount, receiver, owner];
  return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args }) };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('Dinero AutoPxEth ordinary ERC4626 additions', () => {
  it('preserves all 721 prior definitions and binds the exact four full nonpayable ABIs', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const prior = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/spark-speth-v2/catalog.json'), 'utf8')));
    const priorManifest = buildReviewedManifest([prior]);
    expect(priorManifest.capabilities).toHaveLength(721);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => [fn.capabilityId, fn]));
    for (const priorFunction of priorManifest.capabilities) expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);
    expect(functions).toHaveLength(4);
    const priorScopes = priorManifest.capabilities.filter((fn) => fn.executionScope);
    expect(priorScopes).toHaveLength(16);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope)).toEqual(priorScopes);

    const profileMembers = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    expect(profileMembers).toHaveLength(399);
    expect(new Set(profileMembers).size).toBe(399);
    expect(IDS.some((id) => profileMembers.includes(id))).toBe(false);

    for (const [index, spec] of SPECS.entries()) {
      const fn = functions[index];
      expect(fn).toMatchObject({ capabilityId: IDS[index], chainId: 1, contract: TARGET, functionName: spec.name, signature: spec.signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toMatchObject({ type: 'function', name: spec.name, stateMutability: 'nonpayable' });
      expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: spec.inputs[0], type: 'uint256', internalType: 'uint256' },
        { name: spec.inputs[1], type: 'address', internalType: 'address' },
        ...(spec.arity === 3 ? [{ name: spec.inputs[2], type: 'address', internalType: 'address' }] : []),
      ]);
      expect(fn.abi.outputs).toEqual([{ name: spec.output, type: 'uint256', internalType: 'uint256' }]);
      expect(toFunctionSelector(fn.signature)).toBe(spec.selector);
      expect(functionAbiHash(fn)).toBe(spec.hash);
      expect(fn.executionScope).toBeUndefined();

      for (const amount of [0n, (1n << 256n) - 1n]) {
        for (const receiver of [ZERO_ADDRESS, OTHER_ADDRESS] as const) {
          const owner = spec.arity === 3 ? OTHER_OWNER : EXECUTION_OWNER;
          expect(receiver.toLowerCase()).not.toBe(EXECUTION_OWNER.toLowerCase());
          if (spec.arity === 3) expect(owner.toLowerCase()).not.toBe(EXECUTION_OWNER.toLowerCase());
          const authorization = await policy.authorizeContractCalls([tx(fn, amount, receiver, owner)], context(fn));
          expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: IDS[index], chainId: 1, contract: TARGET, functionSignature: spec.signature, abiHash: spec.hash })]);
          await expect(policy.assertStillAuthorized(finalTx([IDS[index]]) as never, authorization)).resolves.toBeUndefined();
        }
      }
    }
  });

  it('denies empty/unrelated/cross-method grants, wrong target/chain, malformed calldata, and native value', async () => {
    for (const [index, fn] of functions.entries()) {
      const call = tx(fn, 0n, OTHER_ADDRESS, OTHER_OWNER);
      for (const grants of [[], ['unrelated'], ...IDS.filter((id) => id !== fn.capabilityId).map((id) => [id])]) {
        await expect(policy.authorizeContractCalls([call], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([call], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      const otherVaultFn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.signature === fn.signature && candidate.contract.toLowerCase() !== TARGET)!;
      expect(otherVaultFn).toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call, to: otherVaultFn.contract }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...call, to: '0x1111111111111111111111111111111111111111' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: `0xdeadbeef${call.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: call.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: `${call.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...call, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks grants, pauses and key state with lock ordering/key binding, and rejects changed final commitments', async () => {
    for (const [index, fn] of functions.entries()) {
      const spec = SPECS[index];
      const call = tx(fn, (1n << 256n) - 1n, OTHER_ADDRESS, OTHER_OWNER);
      const authorization = await policy.authorizeContractCalls([call], context(fn));
      const liveTx = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(liveTx as never, authorization)).resolves.toBeUndefined();
      const locks = liveTx.$queryRaw.mock.calls;
      expect(locks).toHaveLength(2);
      expect(locks[0][0].join('')).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(locks[1][0].join('')).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(locks[1][0].join('')).toContain('FOR UPDATE');
      expect(locks[1][1]).toBe(KEY_ID);

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

      const otherVaultFn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.signature === fn.signature && candidate.contract.toLowerCase() !== TARGET)!;
      const changedArgumentCall = tx(fn, 0n, ZERO_ADDRESS, OTHER_OWNER);
      const changed = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: otherVaultFn.contract }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: changedArgumentCall.data }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: IDS.find((id) => id !== fn.capabilityId)! } })) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      expect(changed[2].interactions[0].value).not.toBe(authorization.interactions[0].value);
      expect(changed[3].manifestHash).not.toBe(authorization.manifestHash);
      expect(changed[4].requestCommitment).not.toBe(authorization.requestCommitment);
      expect(changed[5].executionPlan[0].match.capabilityId).not.toBe(fn.capabilityId);
      expect(changed[6].executionPlan[0].match.abiHash).not.toBe(fn.abiHash);
      for (const altered of changed) await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, altered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      expect(spec.signature).toBe(fn.signature);
    }
  });
});

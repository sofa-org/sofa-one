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

const TARGET = '0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SPECS = [
  { name: 'deposit', signature: 'deposit(uint256,address)', selector: '0x6e553f65', hash: '0xbdb2a83ef7a315d0d0bfb11d2b460ba6aea60c52672b65d224eb7586c2d6c063', inputs: ['assets_', 'receiver_'], output: 'shares_' },
  { name: 'mint', signature: 'mint(uint256,address)', selector: '0x94bf804d', hash: '0x3db187758737efd13979f76f7864134fe09d7742d8c7854acfb2ac370aefde4d', inputs: ['shares_', 'receiver_'], output: 'assets_' },
  { name: 'requestRedeem', signature: 'requestRedeem(uint256,address)', selector: '0x107703ab', hash: '0xfa07749076e3b27f9afa7bfea9952779d674a00020e5bea2befa9e85f3e9ae1c', inputs: ['shares_', 'owner_'], output: 'escrowedShares_' },
];
const IDS = SPECS.map(({ name }) => `maple-pool-v2:v2:1:${TARGET}:${name === 'requestRedeem' ? 'request-redeem' : name}`);
const OWNER = '0x9999999999999999999999999999999999999999';
const USER = 'maple-usdg-pool-v2-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000077';
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = fn.chainId): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: OWNER, allowedCapabilityIds: grants };
}

function tx(fn: DefiFunctionPolicy, amount: bigint, address: `0x${string}`) {
  return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [amount, address] }) };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('Maple syrupUSDG Pool V2 ordinary additions', () => {
  it('preserves the exact 702-definition baseline and binds the three named fixed ABIs', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const prior = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/maple-pool-v2/catalog.json'), 'utf8')));
    const priorManifest = buildReviewedManifest([prior]);
    expect(priorManifest.capabilities).toHaveLength(702);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => [fn.capabilityId, fn]));
    for (const priorFunction of priorManifest.capabilities) expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);
    expect(functions).toHaveLength(3);
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
      ]);
      expect(fn.abi.outputs).toEqual([{ name: spec.output, type: 'uint256', internalType: 'uint256' }]);
      expect(toFunctionSelector(fn.signature)).toBe(spec.selector);
      expect(functionAbiHash(fn)).toBe(spec.hash);
      expect(fn.executionScope).toBeUndefined();

      for (const [amount, address] of [
        [0n, '0x1111111111111111111111111111111111111111'],
        [0n, ZERO_ADDRESS],
        [(1n << 256n) - 1n, '0x2222222222222222222222222222222222222222'],
      ] as const) {
        expect(address.toLowerCase()).not.toBe(OWNER.toLowerCase());
        const authorization = await policy.authorizeContractCalls([tx(fn, amount, address)], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: IDS[index], chainId: 1, contract: TARGET, functionSignature: spec.signature, abiHash: spec.hash })]);
        await expect(policy.assertStillAuthorized(finalTx([IDS[index]]) as never, authorization)).resolves.toBeUndefined();
      }
    }
  });

  it('denies missing/cross-method grants, wrong identity, malformed arguments, and native value', async () => {
    for (const [index, fn] of functions.entries()) {
      const call = tx(fn, 0n, '0x1111111111111111111111111111111111111111');
      for (const grants of [[], ['unrelated'], ...IDS.filter((id) => id !== fn.capabilityId).map((id) => [id])]) {
        await expect(policy.authorizeContractCalls([call], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([call], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      const otherPoolMethod = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.signature === fn.signature && candidate.contract.toLowerCase() !== TARGET)!;
      await expect(policy.authorizeContractCalls([{ ...call, to: otherPoolMethod.contract }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: `0xdeadbeef${call.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: call.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: `${call.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...call, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks each final grant, pause and key gate with SQL lock order and denies changed call bindings', async () => {
    for (const [index, fn] of functions.entries()) {
      const spec = SPECS[index];
      const call = tx(fn, (1n << 256n) - 1n, '0x2222222222222222222222222222222222222222');
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

      const otherPoolMethod = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.signature === fn.signature && candidate.contract.toLowerCase() !== TARGET)!;
      const otherTargetCall = tx(otherPoolMethod, (1n << 256n) - 1n, '0x2222222222222222222222222222222222222222');
      const changedArgumentCall = tx(fn, 0n, ZERO_ADDRESS);
      expect(otherTargetCall.to).not.toBe(TARGET);
      expect(changedArgumentCall.data).not.toBe(call.data);
      const changed = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: otherTargetCall.to }] },
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

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
  { symbol: 'syrupUSDC', address: '0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b' },
  { symbol: 'syrupUSDT', address: '0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d' },
];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SPECS = [
  { name: 'deposit', signature: 'deposit(uint256,address)', selector: '0x6e553f65', hash: '0xbdb2a83ef7a315d0d0bfb11d2b460ba6aea60c52672b65d224eb7586c2d6c063', inputs: ['assets_', 'receiver_'], output: 'shares_', args: [0n, '0x1111111111111111111111111111111111111111'] as const, zeroAddressArgs: [0n, ZERO_ADDRESS] as const, second: [((1n << 256n) - 1n), '0x2222222222222222222222222222222222222222'] as const },
  { name: 'mint', signature: 'mint(uint256,address)', selector: '0x94bf804d', hash: '0x3db187758737efd13979f76f7864134fe09d7742d8c7854acfb2ac370aefde4d', inputs: ['shares_', 'receiver_'], output: 'assets_', args: [0n, '0x1111111111111111111111111111111111111111'] as const, zeroAddressArgs: [0n, ZERO_ADDRESS] as const, second: [((1n << 256n) - 1n), '0x2222222222222222222222222222222222222222'] as const },
  { name: 'requestRedeem', signature: 'requestRedeem(uint256,address)', selector: '0x107703ab', hash: '0xfa07749076e3b27f9afa7bfea9952779d674a00020e5bea2befa9e85f3e9ae1c', inputs: ['shares_', 'owner_'], output: 'escrowedShares_', args: [0n, '0x1111111111111111111111111111111111111111'] as const, zeroAddressArgs: [0n, ZERO_ADDRESS] as const, second: [((1n << 256n) - 1n), '0x2222222222222222222222222222222222222222'] as const },
];
const IDS = POOLS.flatMap(({ address }) => SPECS.map(({ name }) => `maple-pool-v2:v2:1:${address}:${name === 'requestRedeem' ? 'request-redeem' : name}`));
const OWNER = '0x9999999999999999999999999999999999999999';
const USER = 'maple-pool-v2-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000076';
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = fn.chainId): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: OWNER, allowedCapabilityIds: grants };
}

function tx(fn: DefiFunctionPolicy, args: readonly [bigint, `0x${string}`]) {
  return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args }) };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('Maple Pool V2 six-method ordinary additions', () => {
  it('binds exact ABI identities and leaves argument values, receivers, and request owners caller-selected', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const prior = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/compound-v2-repay-behalf/catalog.json'), 'utf8')));
    const priorManifest = buildReviewedManifest([prior]);
    expect(priorManifest.capabilities).toHaveLength(696);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => [fn.capabilityId, fn]));
    for (const priorFunction of priorManifest.capabilities) expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);
    expect(functions).toHaveLength(6);
    for (const [poolIndex, pool] of POOLS.entries()) {
      for (const [methodIndex, spec] of SPECS.entries()) {
        const fn = functions[poolIndex * SPECS.length + methodIndex];
        expect(fn).toMatchObject({ capabilityId: `maple-pool-v2:v2:1:${pool.address}:${spec.name === 'requestRedeem' ? 'request-redeem' : spec.name}`, chainId: 1, contract: pool.address, functionName: spec.name, signature: spec.signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
        expect(fn.abi.stateMutability).toBe('nonpayable');
        expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
          { name: spec.inputs[0], type: 'uint256', internalType: 'uint256' },
          { name: spec.inputs[1], type: 'address', internalType: 'address' },
        ]);
        expect(fn.abi.outputs).toEqual([{ name: spec.output, type: 'uint256', internalType: 'uint256' }]);
        expect(toFunctionSelector(fn.signature)).toBe(spec.selector);
        expect(functionAbiHash(fn)).toBe(spec.hash);
        expect(fn.executionScope).toBeUndefined();
        expect(IDS.every((id) => PRODUCTION_DEFI_CAPABILITY_BUNDLES.every((bundle) => !bundle.capabilityIds.includes(id)))).toBe(true);
        for (const args of [spec.args, spec.zeroAddressArgs, spec.second]) {
          expect(args[1].toLowerCase()).not.toBe(OWNER.toLowerCase());
          const authorization = await policy.authorizeContractCalls([tx(fn, args)], context(fn));
          expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, chainId: 1, contract: pool.address, functionSignature: spec.signature, abiHash: spec.hash })]);
          await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
        }
      }
    }
  });

  it('denies cross-method/pool grants, wrong target/chain/selector, malformed calldata, and native value', async () => {
    for (const fn of functions) {
      const call = tx(fn, SPECS.find((spec) => spec.name === fn.functionName)!.args);
      const otherGrants = IDS.filter((id) => id !== fn.capabilityId);
      for (const grants of [[], ['unrelated'], ...otherGrants.map((id) => [id])]) {
        await expect(policy.authorizeContractCalls([call], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([call], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      const differentTarget = POOLS.find((pool) => pool.address !== fn.contract)!.address;
      await expect(policy.authorizeContractCalls([{ ...call, to: differentTarget }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: `0xdeadbeef${call.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: call.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...call, data: `${call.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...call, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks every final grant, pause and key-state gate, lock order, and bound call commitment', async () => {
    for (const fn of functions) {
      const spec = SPECS.find((candidate) => candidate.name === fn.functionName)!;
      const call = tx(fn, spec.second);
      const authorization = await policy.authorizeContractCalls([call], context(fn));
      const liveTx = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(liveTx as never, authorization)).resolves.toBeUndefined();
      const lockCalls = liveTx.$queryRaw.mock.calls;
      expect(lockCalls).toHaveLength(2);
      const globalPauseLock = lockCalls[0][0].join('');
      const apiKeyLock = lockCalls[1][0].join('');
      expect(globalPauseLock).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(apiKeyLock).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(apiKeyLock).toContain('FOR UPDATE');
      expect(lockCalls[1][1]).toBe(KEY_ID);

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

      const otherPoolFunction = functions.find((candidate) => candidate.contract !== fn.contract && candidate.functionName === fn.functionName)!;
      const otherPoolCall = tx(otherPoolFunction, spec.second);
      expect(otherPoolCall.to).not.toBe(fn.contract);
      const differentArgumentsCall = tx(fn, spec.args);
      expect(differentArgumentsCall.data).not.toBe(call.data);
      const tampered = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: otherPoolCall.to }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: differentArgumentsCall.data }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: IDS.find((id) => id !== fn.capabilityId)! } })) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      expect(tampered[2].interactions[0].value).not.toBe(authorization.interactions[0].value);
      expect(tampered[3].manifestHash).not.toBe(authorization.manifestHash);
      expect(tampered[4].requestCommitment).not.toBe(authorization.requestCommitment);
      expect(tampered[5].executionPlan[0].match.capabilityId).not.toBe(fn.capabilityId);
      expect(tampered[6].executionPlan[0].match.abiHash).not.toBe(fn.abiHash);
      for (const alteredAuthorization of tampered) {
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, alteredAuthorization as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      }
    }
  });
});

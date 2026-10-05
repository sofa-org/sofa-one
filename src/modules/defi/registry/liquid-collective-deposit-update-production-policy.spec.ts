import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';
import { buildReviewedManifest, functionAbiHash } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';
import { validateCatalogDocument } from '../catalog-tooling/catalog-generator';

const TARGET = '0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549';
const CAPABILITY_ID = `liquid-collective-river:v1:1:${TARGET}:deposit`;
const PREVIOUS_MANTLE_STAKE = 'mantle-meth-staking:v1:1:0xe3cbd06d7dadb3f4e6557bab7edd924cd1489e8f:stake';
const PREVIOUS_ANKR_STAKE = 'ankr-eth-global-pool:r46:1:0x84db6ee82b7cf3b47e8f19270abde5718b936670:stake-and-claim-aeth-c';
const PREVIOUS_STADER_STAKE = 'stader-ethx-manager:v1:1:0xcf5ea1b38380f6af39068375516daf40ed70d299:deposit';
const PREVIOUS_DINERO_STAKE = 'dinero-apxeth:v1:1:0x9ba021b0a9b958b5e75ce9f6dff97c7ee52cb3e6:deposit';
const OTHER_STAKING_METHOD = 'etherfi:v1:1:0x308861a430be4cce5502d0a12724771fc6daf216:f3409f08';
const KEY_ID = '00000000-0000-4000-8000-000000000225';
const USER = 'liquid-collective-deposit-policy-test';
const SPEC = {
  signature: 'deposit()',
  selector: '0xd0e30db0',
  hash: '0x843bc76e9b37f6f244f6c3fb4e28e3326df5c9f744f45f159a9eed920b284b1a',
};
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === CAPABILITY_ID)! as DefiFunctionPolicy;

function context(grants: string[] = [CAPABILITY_ID], chainId = 1): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x9999999999999999999999999999999999999999', allowedCapabilityIds: grants };
}

function tx(value: string, to = TARGET, data = SPEC.selector) {
  return { to, value, data };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('Liquid Collective River payable deposit ordinary addition', () => {
  it('preserves all 728 prior functions and binds exact generated payable zero-argument ABI', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const prior = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/mantle-meth-staking/catalog.json'), 'utf8')));
    const priorManifest = buildReviewedManifest([prior]);
    expect(priorManifest.capabilities).toHaveLength(728);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const oldFunction of priorManifest.capabilities) expect(currentById.get(oldFunction.capabilityId)).toEqual(oldFunction);

    expect(fn).toMatchObject({ capabilityId: CAPABILITY_ID, chainId: 1, contract: TARGET, functionName: 'deposit', signature: SPEC.signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
    expect(fn.abi).toEqual({ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] });
    expect(toFunctionSelector(fn.signature)).toBe(SPEC.selector);
    expect(functionAbiHash(fn)).toBe(SPEC.hash);
    expect(fn.executionScope).toBeUndefined();
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((candidate) => candidate.executionScope)).toEqual(priorManifest.capabilities.filter((candidate) => candidate.executionScope));

    const profileMembers = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    expect(profileMembers).toHaveLength(399);
    expect(new Set(profileMembers).size).toBe(399);
    expect(profileMembers).not.toContain(CAPABILITY_ID);

    for (const value of ['0', '1', MAX_UINT256]) {
      const authorization = await policy.authorizeContractCalls([tx(value)], context());
      expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: CAPABILITY_ID, chainId: 1, contract: TARGET, functionSignature: SPEC.signature, abiHash: SPEC.hash })]);
      await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, authorization)).resolves.toBeUndefined();
    }
  });

  it('denies absent/unrelated staking grants and changed chain, target, selector, or empty/truncated/trailing calldata', async () => {
    for (const grants of [[], ['unrelated'], [PREVIOUS_MANTLE_STAKE], [PREVIOUS_ANKR_STAKE], [PREVIOUS_STADER_STAKE], [PREVIOUS_DINERO_STAKE], [OTHER_STAKING_METHOD]]) {
      await expect(policy.authorizeContractCalls([tx('1')], context(grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    await expect(policy.authorizeContractCalls([tx('1')], context([CAPABILITY_ID], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([tx('1', '0x1111111111111111111111111111111111111111')], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([tx('1', '0xe3cbd06d7dadb3f4e6557bab7edd924cd1489e8f')], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([tx('1', TARGET, '0x')], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([tx('1', TARGET, '0xd0e30d')], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([tx('1', TARGET, `${SPEC.selector}00`)], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([tx('1', TARGET, '0xdeadbeef')], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('rechecks final grant/pause/key state and global-pause then API-key SQL locks; rejects altered bindings', async () => {
    const authorization = await policy.authorizeContractCalls([tx(MAX_UINT256)], context());
    const liveTx = finalTx([CAPABILITY_ID]);
    await expect(policy.assertStillAuthorized(liveTx as never, authorization)).resolves.toBeUndefined();
    const locks = liveTx.$queryRaw.mock.calls;
    expect(locks).toHaveLength(2);
    expect(locks[0][0].join('')).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
    expect(locks[1][0].join('')).toContain('SELECT id FROM api_keys WHERE id = ');
    expect(locks[1][0].join('')).toContain('FOR UPDATE');
    expect(locks[1][1]).toBe(KEY_ID);

    await expect(policy.assertStillAuthorized(finalTx([]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID], [`capability:${CAPABILITY_ID}`]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    for (const keyState of [{ revoked: true }, { frozenAt: new Date() }, { expiresAt: new Date(Date.now() - 60_000) }, { canSendTransaction: false }]) {
      await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID], [], keyState) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }

    const altered = [
      { ...authorization, interactions: [{ ...authorization.interactions[0], to: '0xe3cbd06d7dadb3f4e6557bab7edd924cd1489e8f' }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], data: '0xdeadbeef' }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
      { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
      { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
      { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: PREVIOUS_MANTLE_STAKE } })) },
      { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
    ];
    for (const changed of altered) await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, changed as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });
});

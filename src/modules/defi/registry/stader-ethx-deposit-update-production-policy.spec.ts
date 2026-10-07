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

const TARGET = '0xcf5ea1b38380f6af39068375516daf40ed70d299';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const CAPABILITY_ID = `stader-ethx-manager:v1:1:${TARGET}:deposit`;
const LEGACY_DINERO_DEPOSIT = 'dinero-apxeth:v1:1:0x9ba021b0a9b958b5e75ce9f6dff97c7ee52cb3e6:deposit';
const OTHER_STAKING_DEPOSIT = 'etherfi:v1:1:0x308861a430be4cce5502d0a12724771fc6daf216:f3409f08';
const EXECUTION_OWNER = '0x9999999999999999999999999999999999999999';
const USER = 'stader-ethx-deposit-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000222';
const SPEC = {
  signature: 'deposit(address)',
  selector: '0xf340fa01',
  hash: '0x42abde06a5110aaf72bf13d8ac24f72c008cc68abb15657c3e1ce24ff971c062',
};
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === CAPABILITY_ID)! as DefiFunctionPolicy;

function context(grants: string[] = [CAPABILITY_ID], chainId = 1): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: EXECUTION_OWNER, allowedCapabilityIds: grants };
}

function tx(receiver: `0x${string}`, value: string) {
  return {
    to: TARGET,
    value,
    data: encodeFunctionData({ abi: [fn.abi], functionName: 'deposit', args: [receiver] }),
  };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('Stader ETHx StakePoolsManager payable deposit ordinary addition', () => {
  it('preserves all 725 prior functions and authorizes exact payable ABI with caller-selected value/receiver', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const prior = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/dinero-apxeth/catalog.json'), 'utf8')));
    const priorManifest = buildReviewedManifest([prior]);
    expect(priorManifest.capabilities).toHaveLength(725);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const oldFunction of priorManifest.capabilities) expect(currentById.get(oldFunction.capabilityId)).toEqual(oldFunction);
    expect(fn).toMatchObject({ capabilityId: CAPABILITY_ID, chainId: 1, contract: TARGET, functionName: 'deposit', signature: SPEC.signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
    expect(fn.abi).toEqual({
      type: 'function', name: 'deposit', stateMutability: 'payable',
      inputs: [{ internalType: 'address', name: '_receiver', type: 'address' }],
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    });
    expect(toFunctionSelector(fn.signature)).toBe(SPEC.selector);
    expect(functionAbiHash(fn)).toBe(SPEC.hash);
    expect(fn.executionScope).toBeUndefined();
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((candidate) => candidate.executionScope && candidate.capabilityId !== 'polymarket-pusd:v1:137:0x93070a847efef7f70739046a929d47a521f5b8ee:wrap')).toEqual(priorManifest.capabilities.filter((candidate) => candidate.executionScope));

    const profileMembers = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    expect(profileMembers).toHaveLength(399);
    expect(new Set(profileMembers).size).toBe(399);
    expect(profileMembers).not.toContain(CAPABILITY_ID);

    for (const receiver of [ZERO_ADDRESS, OTHER_ADDRESS] as const) {
      expect(receiver.toLowerCase()).not.toBe(EXECUTION_OWNER.toLowerCase());
      for (const value of ['0', '1', ((1n << 256n) - 1n).toString()]) {
        const authorization = await policy.authorizeContractCalls([tx(receiver, value)], context());
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: CAPABILITY_ID, chainId: 1, contract: TARGET, functionSignature: SPEC.signature, abiHash: SPEC.hash })]);
        await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, authorization)).resolves.toBeUndefined();
      }
    }
  });

  it('denies missing, unrelated legacy/other-staking grants and changed target, chain, selector or noncanonical calldata', async () => {
    const call = tx(OTHER_ADDRESS, '1');
    for (const grants of [[], ['unrelated'], [LEGACY_DINERO_DEPOSIT], [OTHER_STAKING_DEPOSIT]]) {
      await expect(policy.authorizeContractCalls([call], context(grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    await expect(policy.authorizeContractCalls([call], context([CAPABILITY_ID], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call, to: '0x1111111111111111111111111111111111111111' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call, to: '0x308861a430be4cce5502d0a12724771fc6daf216' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...call, data: `0xdeadbeef${call.data.slice(10)}` }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call, data: call.data.slice(0, -2) }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...call, data: `${call.data}00` }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const nonCanonicalAddress = `${call.data.slice(0, 10)}1${call.data.slice(11)}`;
    await expect(policy.authorizeContractCalls([{ ...call, data: nonCanonicalAddress }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    for (const value of ['0', '1', ((1n << 256n) - 1n).toString()]) {
      await expect(policy.authorizeContractCalls([{ ...call, value }], context())).resolves.toBeDefined();
    }
  });

  it('rechecks final grant/pause/key state and SQL lock order, then rejects tampered bindings', async () => {
    const call = tx(OTHER_ADDRESS, ((1n << 256n) - 1n).toString());
    const authorization = await policy.authorizeContractCalls([call], context());
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
    for (const keyState of [
      { revoked: true },
      { frozenAt: new Date() },
      { expiresAt: new Date(Date.now() - 60_000) },
      { canSendTransaction: false },
    ]) {
      await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID], [], keyState) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }

    const altered = [
      { ...authorization, interactions: [{ ...authorization.interactions[0], to: '0x308861a430be4cce5502d0a12724771fc6daf216' }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], data: tx(ZERO_ADDRESS, '0').data }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
      { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
      { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
      { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: OTHER_STAKING_DEPOSIT } })) },
      { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
    ];
    expect(altered[2].interactions[0].value).not.toBe(authorization.interactions[0].value);
    expect(altered[3].manifestHash).not.toBe(authorization.manifestHash);
    expect(altered[4].requestCommitment).not.toBe(authorization.requestCommitment);
    expect(altered[5].executionPlan[0].match.capabilityId).not.toBe(CAPABILITY_ID);
    expect(altered[6].executionPlan[0].match.abiHash).not.toBe(fn.abiHash);
    for (const changed of altered) await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, changed as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });
});

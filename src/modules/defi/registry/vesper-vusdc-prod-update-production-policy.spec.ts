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

const TARGET = '0x0c49066c0808ee8c673553b7cbd99bcc9abf113d';
const DEPOSIT_ID = `vesper-vusdc:v1:1:${TARGET}:deposit`;
const WITHDRAW_ID = `vesper-vusdc:v1:1:${TARGET}:withdraw`;
const PREVIOUS_VAETH_DEPOSIT = 'vesper-vaeth:v1:1:0xd1c117319b3595fbc39b471ab1fd485629eb05f2:deposit';
const PREVIOUS_LIQUID_COLLECTIVE = 'liquid-collective-river:v1:1:0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549:deposit';
const PREVIOUS_MANTLE_STAKE = 'mantle-meth-staking:v1:1:0xe3cbd06d7dadb3f4e6557bab7edd924cd1489e8f:stake';
const PREVIOUS_ANKR_STAKE = 'ankr-eth-global-pool:r46:1:0x84db6ee82b7cf3b47e8f19270abde5718b936670:stake-and-claim-aeth-c';
const PREVIOUS_STADER_STAKE = 'stader-ethx-manager:v1:1:0xcf5ea1b38380f6af39068375516daf40ed70d299:deposit';
const PREVIOUS_DINERO_STAKE = 'dinero-apxeth:v1:1:0x9ba021b0a9b958b5e75ce9f6dff97c7ee52cb3e6:deposit';
const KEY_ID = '00000000-0000-4000-8000-000000000228';
const USER = 'vesper-vusdc-prod-policy-test';
const FUNCTIONS = {
  deposit: {
    signature: 'deposit(uint256)',
    selector: '0xb6b55f25',
    hash: '0x4b8d5087f536c653adfbe5bb850747e7d834ad59aa36b4fdbb671f0a4dcc38ba',
    abi: { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }], outputs: [] },
    id: DEPOSIT_ID,
  },
  withdraw: {
    signature: 'withdraw(uint256)',
    selector: '0x2e1a7d4d',
    hash: '0xedeff682646a16fce72d0397c106942d1bc502ff5fc61027967fd2bf63a97071',
    abi: { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }], outputs: [] },
    id: WITHDRAW_ID,
  },
} as const;
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const functions = Object.fromEntries(Object.entries(FUNCTIONS).map(([name, spec]) => [name, PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === spec.id)! as DefiFunctionPolicy])) as Record<keyof typeof FUNCTIONS, DefiFunctionPolicy>;

function context(grants: string[] = [DEPOSIT_ID, WITHDRAW_ID], chainId = 1): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x9999999999999999999999999999999999999999', allowedCapabilityIds: grants };
}

function calldata(name: keyof typeof FUNCTIONS, amount: string): string {
  return `${FUNCTIONS[name].selector}${BigInt(amount).toString(16).padStart(64, '0')}`;
}

function tx(name: keyof typeof FUNCTIONS, amount: string, to = TARGET, value = '0', data = calldata(name, amount)) {
  return { to, value, data };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

describe('Vesper production vUSDC deposit and withdraw ordinary additions', () => {
  it('preserves the full prior catalog and admits only the exact nonpayable amount/share ABIs', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    const prior = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/vesper-vaeth-deposit/catalog.json'), 'utf8')));
    const priorManifest = buildReviewedManifest([prior]);
    expect(priorManifest.capabilities).toHaveLength(730);
    const savedUpdate = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/vesper-vusdc-prod/catalog.json'), 'utf8')));
    const savedUpdateManifest = buildReviewedManifest([savedUpdate]);
    expect(savedUpdateManifest.capabilities).toHaveLength(732);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const oldFunction of priorManifest.capabilities) expect(currentById.get(oldFunction.capabilityId)).toEqual(oldFunction);

    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      const fn = functions[name];
      expect(fn).toMatchObject({ capabilityId: spec.id, chainId: 1, contract: TARGET, functionName: name, signature: spec.signature, status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toEqual(spec.abi);
      expect(toFunctionSelector(fn.signature)).toBe(spec.selector);
      expect(functionAbiHash(fn)).toBe(spec.hash);
      expect(fn.executionScope).toBeUndefined();
    }
    const newCapabilityIds = [DEPOSIT_ID, WITHDRAW_ID];
    expect(savedUpdateManifest.capabilities.filter((candidate) => newCapabilityIds.includes(candidate.capabilityId)).map((candidate) => candidate.capabilityId)).toEqual(newCapabilityIds);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((candidate) => candidate.executionScope && candidate.capabilityId !== 'polymarket-pusd:v1:137:0x93070a847efef7f70739046a929d47a521f5b8ee:wrap')).toEqual(priorManifest.capabilities.filter((candidate) => candidate.executionScope));

    const profileMembers = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    expect(profileMembers).toHaveLength(399);
    expect(new Set(profileMembers).size).toBe(399);
    expect(profileMembers).not.toContain(DEPOSIT_ID);
    expect(profileMembers).not.toContain(WITHDRAW_ID);

    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      for (const amount of ['0', '1', MAX_UINT256]) {
        const authorization = await policy.authorizeContractCalls([tx(name, amount)], context([spec.id]));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: spec.id, chainId: 1, contract: TARGET, functionSignature: spec.signature, abiHash: spec.hash })]);
        await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, authorization)).resolves.toBeUndefined();
      }
    }
  });

  it('requires separate grants and denies wrong chain/target, the other method, malformed calldata, and nonzero native value', async () => {
    const historicalGrants = ['unrelated', PREVIOUS_VAETH_DEPOSIT, PREVIOUS_LIQUID_COLLECTIVE, PREVIOUS_MANTLE_STAKE, PREVIOUS_ANKR_STAKE, PREVIOUS_STADER_STAKE, PREVIOUS_DINERO_STAKE];
    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      const otherId = name === 'deposit' ? WITHDRAW_ID : DEPOSIT_ID;
      for (const grants of [[], ...historicalGrants.map((id) => [id]), [otherId]]) {
        await expect(policy.authorizeContractCalls([tx(name, '1')], context(grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([tx(name, '1')], context([spec.id], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      for (const wrongTarget of ['0x1111111111111111111111111111111111111111', '0xc1efbee3a8dabd30d1d789138bc6ea43a399c335']) {
        await expect(policy.authorizeContractCalls([tx(name, '1', wrongTarget)], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      }
      await expect(policy.authorizeContractCalls([tx(name, '1', '0xd1c117319b3595fbc39b471ab1fd485629eb05f2')], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([tx(name, '1', TARGET, '0', '0x')], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([tx(name, '1', TARGET, '0', spec.selector)], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([tx(name, '1', TARGET, '0', `${spec.selector}${'00'.repeat(31)}`)], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([tx(name, '1', TARGET, '0', `${calldata(name, '1')}00`)], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([tx(name, '1', TARGET, '0', `${FUNCTIONS[otherId === WITHDRAW_ID ? 'withdraw' : 'deposit'].selector}${'00'.repeat(32)}`)], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([tx(name, '1', TARGET, '1')], context([spec.id]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks both grants, pauses, and live-key state under ordered tagged SQL locks; rejects binding tampering', async () => {
    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      const otherId = name === 'deposit' ? WITHDRAW_ID : DEPOSIT_ID;
      const authorization = await policy.authorizeContractCalls([tx(name, MAX_UINT256)], context([spec.id]));
      const liveTx = finalTx([spec.id]);
      await expect(policy.assertStillAuthorized(liveTx as never, authorization)).resolves.toBeUndefined();
      const locks = liveTx.$queryRaw.mock.calls;
      expect(locks).toHaveLength(2);
      expect(locks[0][0].join('')).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(locks[1][0].join('')).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(locks[1][0].join('')).toContain('FOR UPDATE');
      expect(locks[1][1]).toBe(KEY_ID);

      const withoutGrant = finalTx([otherId]);
      await expect(policy.assertStillAuthorized(withoutGrant as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.assertStillAuthorized(finalTx([spec.id], [`capability:${spec.id}`]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      for (const keyState of [{ revoked: true }, { frozenAt: new Date() }, { expiresAt: new Date(Date.now() - 60_000) }, { canSendTransaction: false }]) {
        await expect(policy.assertStillAuthorized(finalTx([spec.id], [], keyState) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      }

      const altered = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: '0xd1c117319b3595fbc39b471ab1fd485629eb05f2' }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: '0xdeadbeef' }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: name === 'deposit' ? WITHDRAW_ID : DEPOSIT_ID } })) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      for (const changed of altered) await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, changed as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });
});

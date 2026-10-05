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

const TARGET = '0x09db87a538bd693e9d08544577d5ccfaa6373a48';
const CAPABILITY_ID = `yieldnest-yneth:v1:1:${TARGET}:deposit-eth`;
const STADER_NATIVE_CAPABILITY_ID = 'stader-ethx-manager:v1:1:0xcf5ea1b38380f6af39068375516daf40ed70d299:deposit';
const KEY_ID = '00000000-0000-4000-8000-000000000229';
const USER = 'yieldnest-yneth-deposit-policy-test';
const ABI = {
  type: 'function',
  name: 'depositETH',
  stateMutability: 'payable',
  inputs: [{ internalType: 'address', name: 'receiver', type: 'address' }],
  outputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }],
} as const;
const SELECTOR = '0x2d2da806';
const ABI_HASH = '0x6a1d580b4b90de967b8917e88ef6867c2b4234d2ad9508a5362c221324be25d4';
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OTHER_RECEIVER = '0x2222222222222222222222222222222222222222';
const OWNER = '0x9999999999999999999999999999999999999999';
const PREVIOUS_CATALOG_PATH = 'data/defi-catalog/updates/vesper-vusdc-prod/catalog.json';
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === CAPABILITY_ID)! as DefiFunctionPolicy;
const previousManifest = buildReviewedManifest([
  validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), PREVIOUS_CATALOG_PATH), 'utf8'))),
]);
const previousNativeCapabilityIds = previousManifest.capabilities
  .filter((candidate) => candidate.abi.stateMutability === 'payable')
  .map((candidate) => candidate.capabilityId);

function context(grants: string[] = [CAPABILITY_ID], chainId = 1): DefiExecutionContext {
  return {
    userId: USER,
    apiKeyId: KEY_ID,
    walletId: 'wallet',
    chainId,
    executionMode: 'session_key',
    executionOwner: OWNER,
    allowedCapabilityIds: grants,
  };
}

function calldata(receiver: string): string {
  return encodeFunctionData({ abi: [ABI], functionName: 'depositETH', args: [receiver as `0x${string}`] });
}

function tx(receiver = OTHER_RECEIVER, value = '1', data = calldata(receiver)) {
  return { to: TARGET, value, data };
}

function finalTx(
  grants: string[],
  pausedScopeKeys: string[] = [],
  keyOverrides: Record<string, unknown> = {},
) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: {
      findUnique: jest.fn().mockResolvedValue({
        userId: USER,
        revoked: false,
        frozenAt: null,
        expiresAt: null,
        canSendTransaction: true,
        allowedCapabilityIds: grants,
        ...keyOverrides,
      }),
    },
  };
}

describe('YieldNest mainnet ynETH depositETH ordinary addition', () => {
  it('preserves every prior full function and admits only the exact payable receiver ABI', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(previousManifest.capabilities).toHaveLength(732);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const priorFunction of previousManifest.capabilities) expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);

    const savedUpdate = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/yieldnest-yneth-deposit/catalog.json'), 'utf8')));
    const savedUpdateManifest = buildReviewedManifest([savedUpdate]);
    expect(savedUpdateManifest.capabilities).toHaveLength(previousManifest.capabilities.length + 1);
    expect(savedUpdateManifest.capabilities.filter((candidate) => candidate.contract.toLowerCase() === TARGET).map((candidate) => candidate.capabilityId)).toEqual([CAPABILITY_ID]);
    expect(fn).toMatchObject({
      capabilityId: CAPABILITY_ID,
      chainId: 1,
      contract: TARGET,
      functionName: 'depositETH',
      signature: 'depositETH(address)',
      status: 'active',
      provenance: { status: 'verified' },
      type: 'contract_call',
    });
    expect(fn.abi).toEqual(ABI);
    expect(fn.abi.stateMutability).toBe('payable');
    expect(toFunctionSelector(fn.signature)).toBe(SELECTOR);
    expect(functionAbiHash(fn)).toBe(ABI_HASH);
    expect(fn.executionScope).toBeUndefined();
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((candidate) => candidate.executionScope)).toEqual(
      previousManifest.capabilities.filter((candidate) => candidate.executionScope),
    );

    const profileMembers = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    expect(profileMembers).toHaveLength(399);
    expect(new Set(profileMembers).size).toBe(399);
    expect(profileMembers).not.toContain(CAPABILITY_ID);

    for (const receiver of [ZERO_ADDRESS, OTHER_RECEIVER]) {
      for (const value of ['0', '1', MAX_UINT256]) {
        const authorization = await policy.authorizeContractCalls([tx(receiver, value)], context([CAPABILITY_ID]));
        expect(authorization.matches).toEqual([
          expect.objectContaining({ capabilityId: CAPABILITY_ID, chainId: 1, contract: TARGET, functionSignature: 'depositETH(address)', abiHash: ABI_HASH }),
        ]);
        await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, authorization)).resolves.toBeUndefined();
      }
    }
  });

  it('requires this exact grant and rejects other chains/targets, selectors, and noncanonical calldata', async () => {
    for (const grants of [[], ['unrelated'], ...previousNativeCapabilityIds.map((id) => [id])]) {
      await expect(policy.authorizeContractCalls([tx()], context(grants))).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
      });
    }
    expect(previousNativeCapabilityIds).toContain(STADER_NATIVE_CAPABILITY_ID);
    await expect(policy.authorizeContractCalls([tx()], context([CAPABILITY_ID], 10))).rejects.toMatchObject({
      audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
    });
    await expect(policy.authorizeContractCalls([{ ...tx(), to: '0x1111111111111111111111111111111111111111' }], context([CAPABILITY_ID]))).rejects.toMatchObject({
      audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
    });
    await expect(policy.authorizeContractCalls([{ ...tx(), to: '0xcf5ea1b38380f6af39068375516daf40ed70d299' }], context([CAPABILITY_ID]))).rejects.toMatchObject({
      audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' },
    });

    const canonical = calldata(OTHER_RECEIVER);
    const malformedAddress = `${SELECTOR}01${'00'.repeat(31)}`;
    for (const data of ['0x', '0xdeadbeef']) {
      await expect(policy.authorizeContractCalls([tx(OTHER_RECEIVER, '1', data)], context([CAPABILITY_ID]))).rejects.toMatchObject({
        audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' },
      });
    }
    for (const data of [SELECTOR, `${SELECTOR}${'00'.repeat(31)}`, `${canonical}00`, malformedAddress]) {
      await expect(policy.authorizeContractCalls([tx(OTHER_RECEIVER, '1', data)], context([CAPABILITY_ID]))).rejects.toMatchObject({
        audit: { code: 'DEFI_INVALID_PARAMETERS' },
      });
    }
  });

  it('rechecks grant, global pause, and live key under tagged ordered SQL locks; rejects every binding mutation', async () => {
    const authorization = await policy.authorizeContractCalls([tx(OTHER_RECEIVER, MAX_UINT256)], context([CAPABILITY_ID]));
    const liveTx = finalTx([CAPABILITY_ID]);
    await expect(policy.assertStillAuthorized(liveTx as never, authorization)).resolves.toBeUndefined();
    const locks = liveTx.$queryRaw.mock.calls;
    expect(locks).toHaveLength(2);
    expect(locks[0][0].join('')).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
    expect(locks[1][0].join('')).toContain('SELECT id FROM api_keys WHERE id = ');
    expect(locks[1][0].join('')).toContain('FOR UPDATE');
    expect(locks[1][1]).toBe(KEY_ID);

    await expect(policy.assertStillAuthorized(finalTx([]) as never, authorization)).rejects.toMatchObject({
      audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
    });
    await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID], ['global']) as never, authorization)).rejects.toMatchObject({
      audit: { code: 'DEFI_CAPABILITY_PAUSED' },
    });
    await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID], [`capability:${CAPABILITY_ID}`]) as never, authorization)).rejects.toMatchObject({
      audit: { code: 'DEFI_CAPABILITY_PAUSED' },
    });
    for (const keyState of [
      { revoked: true },
      { frozenAt: new Date() },
      { expiresAt: new Date(Date.now() - 60_000) },
      { canSendTransaction: false },
    ]) {
      await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID], [], keyState) as never, authorization)).rejects.toMatchObject({
        audit: { code: 'DEFI_POLICY_UNAVAILABLE' },
      });
    }

    const altered = [
      { ...authorization, interactions: [{ ...authorization.interactions[0], to: '0xcf5ea1b38380f6af39068375516daf40ed70d299' }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], data: '0xdeadbeef' }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
      { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
      { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
      {
        ...authorization,
        executionPlan: authorization.executionPlan.map((node) => ({
          ...node,
          match: { ...node.match, capabilityId: STADER_NATIVE_CAPABILITY_ID },
        })),
      },
      {
        ...authorization,
        executionPlan: authorization.executionPlan.map((node) => ({
          ...node,
          match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` },
        })),
      },
      {
        ...authorization,
        matches: authorization.matches.map((match) => ({ ...match, abiHash: `0x${'00'.repeat(32)}` })),
      },
    ];
    for (const changed of altered) {
      await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, changed as never)).rejects.toMatchObject({
        audit: { code: 'DEFI_POLICY_UNAVAILABLE' },
      });
    }
  });
});

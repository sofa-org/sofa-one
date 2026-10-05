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

const TARGET = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const CHAIN_ID = 1;
const CAPABILITY_ID = `compound-iii:v3-comet:${CHAIN_ID}:${TARGET}:buy-collateral`;
const OLD_COMET_IDS = [
  `compound-comet:${CHAIN_ID}:${TARGET}:supply`,
  `compound-comet:${CHAIN_ID}:${TARGET}:withdraw`,
  `compound-iii:v3-comet:${CHAIN_ID}:${TARGET}:supply-to`,
  `compound-iii:v3-comet:${CHAIN_ID}:${TARGET}:withdraw-to`,
  `compound-iii:v3-comet:${CHAIN_ID}:${TARGET}:supply-from`,
  `compound-iii:v3-comet:${CHAIN_ID}:${TARGET}:withdraw-from`,
];
const EXPECTED = {
  signature: 'buyCollateral(address,uint256,uint256,address)',
  selector: '0xe4e6e779',
  abiHash: '0xa6e84436299da494593db33a343545d2fd6c769e10b73bd387a468f0abd013e2',
};
const USER = 'comet-collateral-purchase-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000073';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const CASES = [
  { asset: '0x0000000000000000000000000000000000000000', minAmount: 0n, baseAmount: 0n, recipient: '0x2222222222222222222222222222222222222222' },
  { asset: '0x1111111111111111111111111111111111111111', minAmount: (1n << 256n) - 1n, baseAmount: 0n, recipient: '0x0000000000000000000000000000000000000000' },
  { asset: '0x3333333333333333333333333333333333333333', minAmount: 0n, baseAmount: (1n << 256n) - 1n, recipient: '0x4444444444444444444444444444444444444444' },
  { asset: '0x5555555555555555555555555555555555555555', minAmount: (1n << 256n) - 1n, baseAmount: (1n << 256n) - 1n, recipient: '0x6666666666666666666666666666666666666666' },
];
const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.capabilityId === CAPABILITY_ID)! as DefiFunctionPolicy;

function policyFixture() {
  const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
  return new DefiPolicyService(db as never, {} as never, catalog);
}

function context(grants: string[] = [CAPABILITY_ID], chainId = CHAIN_ID): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: EXECUTION_OWNER, allowedCapabilityIds: grants };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

function call(args: typeof CASES[number] = CASES[0]) {
  return {
    to: TARGET,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [args.asset, args.minAmount, args.baseAmount, args.recipient] }),
  };
}

describe('Compound Comet USDC buyCollateral ordinary addition in the production policy', () => {
  it('binds the exact Comet selector and authorizes independently caller-selected asset, recipient, minAmount, and baseAmount', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    const baselineDocument = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/aave-collateral-toggle/catalog.json'), 'utf8')));
    const baselineDefinitions = buildReviewedManifest([baselineDocument]).capabilities.length;
    expect(baselineDefinitions).toBe(687);
    const updateDocument = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/comet-usdc-collateral-purchase/catalog.json'), 'utf8')));
    expect(buildReviewedManifest([updateDocument]).capabilities).toHaveLength(baselineDefinitions + 1);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect(fn).toMatchObject({ capabilityId: CAPABILITY_ID, chainId: CHAIN_ID, contract: TARGET, signature: EXPECTED.signature, functionName: 'buyCollateral', status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
    expect(fn.abi).toMatchObject({ type: 'function', name: 'buyCollateral', stateMutability: 'nonpayable' });
    expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
      { name: 'asset', type: 'address', internalType: 'address' },
      { name: 'minAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'baseAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'recipient', type: 'address', internalType: 'address' },
    ]);
    expect(fn.abi.outputs).toEqual([]);
    expect(toFunctionSelector(fn.signature)).toBe(EXPECTED.selector);
    expect(functionAbiHash(fn)).toBe(EXPECTED.abiHash);
    expect(fn.executionScope).toBeUndefined();

    const policy = policyFixture();
    for (const args of CASES) {
      expect(args.recipient.toLowerCase()).not.toBe(EXECUTION_OWNER.toLowerCase());
      const authorization = await policy.authorizeContractCalls([call(args)], context());
      expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: CAPABILITY_ID, chainId: CHAIN_ID, contract: TARGET, functionSignature: EXPECTED.signature, abiHash: EXPECTED.abiHash })]);
      await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, authorization)).resolves.toBeUndefined();
    }
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.every((profile) => !profile.capabilityIds.includes(CAPABILITY_ID))).toBe(true);
  });

  it('denies missing, unrelated, old Comet legacy/To/From grants, wrong chain/target/selector, malformed calldata, and native value', async () => {
    const policy = policyFixture();
    const tx = call();
    for (const grants of [[], ['unrelated-capability-id'], ...OLD_COMET_IDS.map((id) => [id]), OLD_COMET_IDS]) {
      await expect(policy.authorizeContractCalls([tx], context(grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    await expect(policy.authorizeContractCalls([tx], context([CAPABILITY_ID], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...tx, to: '0x7777777777777777777777777777777777777777' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rechecks removed grants, pause, API-key state, SQL lock order, and final call/manifest bindings', async () => {
    const policy = policyFixture();
    const interaction = call(CASES[1]);
    const authorization = await policy.authorizeContractCalls([interaction], context());
    const goodTx = finalTx([CAPABILITY_ID]);
    await expect(policy.assertStillAuthorized(goodTx as never, authorization)).resolves.toBeUndefined();
    const lockQueries = goodTx.$queryRaw.mock.calls.map(([query]) => query.join(''));
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
    expect(lockQueries[1]).toContain('SELECT id FROM api_keys WHERE id = ');
    expect(lockQueries[1]).toContain('FOR UPDATE');
    expect(goodTx.$queryRaw.mock.calls[1][1]).toBe(KEY_ID);

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
      { ...authorization, interactions: [{ ...authorization.interactions[0], to: CASES[1].asset }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], data: call(CASES[2]).data }] },
      { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
      { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
      { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
      { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: OLD_COMET_IDS[2] } })) },
      { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
    ];
    for (const tampered of altered) await expect(policy.assertStillAuthorized(finalTx([CAPABILITY_ID]) as never, tampered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });
});

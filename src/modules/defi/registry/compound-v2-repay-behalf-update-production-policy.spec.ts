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

const MARKETS = [
  { symbol: 'cDAI', address: '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643' },
  { symbol: 'cUSDC', address: '0x39aa39c021dfbae8fac545936693ac917d5e7563' },
  { symbol: 'cUSDT', address: '0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9' },
];
const IDS = MARKETS.map(({ address }) => `compound-v2:v2-compound:1:${address}:repay-borrow-behalf`);
const LEGACY_METHODS = ['borrow', 'mint', 'redeem', 'redeem-underlying', 'repay-borrow'];
const EXPECTED = {
  signature: 'repayBorrowBehalf(address,uint256)',
  selector: '0x2608f818',
  abiHash: '0x03d2ed7ac3a5890a630d11b74cee9b475908a97c7b47e95ce94d3b361c11cc0c',
};
const USER = 'compound-v2-repay-behalf-policy-test';
const KEY_ID = '00000000-0000-4000-8000-000000000075';
const EXECUTION_OWNER = '0x0000000000000000000000000000000000000001';
const CALLS = [
  { borrower: '0x0000000000000000000000000000000000000000', repayAmount: 0n },
  { borrower: '0x2222222222222222222222222222222222222222', repayAmount: (1n << 256n) - 1n },
  { borrower: '0x3333333333333333333333333333333333333333', repayAmount: 0n },
];
const functions = IDS.map((id) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === id)!) as DefiFunctionPolicy[];

function policyFixture() {
  const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
  return new DefiPolicyService(db as never, {} as never, catalog);
}

function context(fn: DefiFunctionPolicy, grants: string[] = [fn.capabilityId], chainId = fn.chainId): DefiExecutionContext {
  return { userId: USER, apiKeyId: KEY_ID, walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: EXECUTION_OWNER, allowedCapabilityIds: grants };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: USER, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants, ...keyOverrides }) },
  };
}

function call(fn: DefiFunctionPolicy, args: typeof CALLS[number]) {
  return {
    to: fn.contract,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [args.borrower, args.repayAmount] }),
  };
}

function oldMarketIds(market: typeof MARKETS[number]) {
  return [
    ...LEGACY_METHODS.map((method) => `compound-v2:v2-compound:1:${market.address}:${method}`),
    `compound-v2:1:${market.address}:repay-borrow-behalf`,
  ];
}

describe('Compound V2 repayBorrowBehalf three-market ordinary additions', () => {
  it('binds the exact cDAI/cUSDC/cUSDT ABI and authorizes caller-selected borrower and repayment values', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    const baselineDocument = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/aave-emode/catalog.json'), 'utf8')));
    const baseline = buildReviewedManifest([baselineDocument]);
    expect(baseline.capabilities).toHaveLength(693);
    expect(baseline.capabilities.some((fn) => fn.functionName === 'repayBorrowBehalf' || fn.signature.startsWith('repayBorrowBehalf('))).toBe(false);
    const updateDocument = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/compound-v2-repay-behalf/catalog.json'), 'utf8')));
    expect(buildReviewedManifest([updateDocument]).capabilities).toHaveLength(baseline.capabilities.length + 3);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect(functions).toHaveLength(3);
    const policy = policyFixture();

    for (const [index, fn] of functions.entries()) {
      expect(fn).toMatchObject({ capabilityId: IDS[index], chainId: 1, contract: MARKETS[index].address, signature: EXPECTED.signature, functionName: 'repayBorrowBehalf', status: 'active', provenance: { status: 'verified' }, type: 'contract_call' });
      expect(fn.abi).toMatchObject({ type: 'function', name: 'repayBorrowBehalf', stateMutability: 'nonpayable' });
      expect(fn.abi.inputs.map(({ name, type, internalType }) => ({ name, type, internalType }))).toEqual([
        { name: 'borrower', type: 'address', internalType: 'address' },
        { name: 'repayAmount', type: 'uint256', internalType: 'uint256' },
      ]);
      expect(fn.abi.outputs).toEqual([{ name: '', type: 'uint256', internalType: 'uint256' }]);
      expect(toFunctionSelector(fn.signature)).toBe(EXPECTED.selector);
      expect(functionAbiHash(fn)).toBe(EXPECTED.abiHash);
      expect(fn.executionScope).toBeUndefined();

      for (const args of CALLS) {
        expect(args.borrower.toLowerCase()).not.toBe(EXECUTION_OWNER.toLowerCase());
        const authorization = await policy.authorizeContractCalls([call(fn, args)], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, chainId: 1, contract: fn.contract, functionSignature: EXPECTED.signature, abiHash: EXPECTED.abiHash })]);
        await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, authorization)).resolves.toBeUndefined();
      }
    }
    expect(IDS.every((id) => PRODUCTION_DEFI_CAPABILITY_BUNDLES.every((profile) => !profile.capabilityIds.includes(id)))).toBe(true);
  });

  it('denies missing, unrelated, old market, other new-market grants, wrong identity, malformed calldata, and native value', async () => {
    const policy = policyFixture();
    for (const [index, fn] of functions.entries()) {
      const tx = call(fn, CALLS[0]);
      const otherNewMarketIds = IDS.filter((id) => id !== fn.capabilityId);
      for (const grants of [[], ['unrelated-capability-id'], oldMarketIds(MARKETS[index]), ...otherNewMarketIds.map((id) => [id])]) {
        await expect(policy.authorizeContractCalls([tx], context(fn, grants))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([tx], context(fn, [fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      const otherMarket = MARKETS[(index + 1) % MARKETS.length];
      await expect(policy.authorizeContractCalls([{ ...tx, to: otherMarket.address }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `0xdeadbeef${tx.data.slice(10)}` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: tx.data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, data: `${tx.data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...tx, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('rechecks removed grants, pause, API-key state, SQL lock order, and final market/call bindings', async () => {
    for (const [index, fn] of functions.entries()) {
      const policy = policyFixture();
      const interaction = call(fn, CALLS[0]);
      const authorization = await policy.authorizeContractCalls([interaction], context(fn));
      const goodTx = finalTx([fn.capabilityId]);
      await expect(policy.assertStillAuthorized(goodTx as never, authorization)).resolves.toBeUndefined();
      const lockQueries = goodTx.$queryRaw.mock.calls.map(([query]) => query.join(''));
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(lockQueries[1]).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(lockQueries[1]).toContain('FOR UPDATE');
      expect(goodTx.$queryRaw.mock.calls[1][1]).toBe(KEY_ID);

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

      const oldCapabilityId = `compound-v2:v2-compound:1:${fn.contract}:repay-borrow`;
      expect(oldCapabilityId).not.toBe(fn.capabilityId);
      const altered = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: MARKETS[(index + 1) % MARKETS.length].address }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: call(fn, CALLS[1]).data }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, capabilityId: oldCapabilityId } })) },
        { ...authorization, executionPlan: authorization.executionPlan.map((node) => ({ ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` } })) },
      ];
      for (const tampered of altered) await expect(policy.assertStillAuthorized(finalTx([fn.capabilityId]) as never, tampered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });
});

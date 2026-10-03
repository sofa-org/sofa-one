import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { DefiPolicyDenial, defiPauseScopeKeysForCapability, type DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_CATALOG } from '../registry/production-registry';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from './production-bundles';
import { capabilityBundleFingerprint } from './bundle.service';
import { DefiBundleService } from './bundle.service';

const OWNER = '0x0000000000000000000000000000000000000001';
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const flat = PRODUCTION_DEFI_MANIFEST.capabilities;
const addressValue = '0x0000000000000000000000000000000000000002';
type TestAbiParameter = { type: string; components?: readonly TestAbiParameter[] };

function sample(parameter: TestAbiParameter): unknown {
  if (parameter.type === 'address') return addressValue;
  if (parameter.type === 'bool') return false;
  if (parameter.type === 'bytes') return '0x';
  if (parameter.type === 'string') return '';
  if (parameter.type === 'bytes32') return `0x${'00'.repeat(32)}`;
  if (parameter.type.endsWith('[]')) return [];
  if (parameter.type.startsWith('tuple')) return (parameter.components ?? []).map(sample);
  if (/^(u?int)/.test(parameter.type)) return 1n;
  return addressValue;
}

function encoded(fn: DefiFunctionPolicy, overrides: Record<string, unknown> = {}): `0x${string}` {
  const args = fn.abi.inputs.map((input, index) => {
    if (Object.prototype.hasOwnProperty.call(overrides, String(index))) return overrides[String(index)];
    return sample(input as TestAbiParameter);
  });
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
}

function makePolicy(pausedScopeKeys: string[] = []) {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
  return { policy: new DefiPolicyService(prisma as never, {} as never, catalog), prisma, catalog };
}

function additionalCatalogIds(): string[] {
  const root = resolve(process.cwd(), 'data/defi-catalog');
  const before = JSON.parse(readFileSync(resolve(root, 'v2/catalog.json'), 'utf8')) as { chains: Array<{ contracts: Array<{ functions: Array<{ capabilityId: string }> }> }> };
  const after = JSON.parse(readFileSync(resolve(root, 'v3/catalog.json'), 'utf8')) as { chains: Array<{ contracts: Array<{ functions: Array<{ capabilityId: string }> }> }> };
  const existing = new Set(before.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
  return after.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))).filter((id) => !existing.has(id)).sort(cmp);
}

describe('published v3 production profiles', () => {
  it('pins the actual production manifest inventory and all nine literal fingerprints', () => {
    expect(flat).toHaveLength(349);
    expect(flat.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(flat.filter((fn) => fn.type === 'contract_call' && !(fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)'))).toHaveLength(326);
    expect(flat.filter((fn) => fn.executionScope)).toHaveLength(13);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(9);
    const ids = new Set<string>();
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES) {
      expect(bundle.version).toBe('1.0.0');
      expect(bundle.chainIds).toHaveLength(1);
      expect(bundle.capabilityIds).toHaveLength(bundle.bundleId.startsWith('uniswap-v3-') ? 9 : 6);
      expect(bundle.capabilityIds).toEqual([...bundle.capabilityIds].sort(cmp));
      expect(new Set(bundle.capabilityIds).size).toBe(bundle.capabilityIds.length);
      expect(bundle.fingerprint).toBe(capabilityBundleFingerprint(bundle, flat));
      for (const id of bundle.capabilityIds) {
        expect(ids.has(`${bundle.bundleId}:${id}`)).toBe(false);
        ids.add(`${bundle.bundleId}:${id}`);
        expect(flat.find((fn) => fn.capabilityId === id)).toMatchObject({ status: 'active', type: 'contract_call' });
      }
    }
    const npm = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((bundle) => bundle.bundleId.startsWith('uniswap-v3-'));
    const blue = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((bundle) => bundle.bundleId.startsWith('morpho-blue-'));
    expect(npm).toHaveLength(7);
    expect(blue).toHaveLength(2);
    expect(npm.map((bundle) => bundle.chainIds[0])).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(blue.map((bundle) => bundle.chainIds[0])).toEqual([1, 8453]);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.reduce((sum, bundle) => sum + bundle.capabilityIds.length, 0)).toBe(75);
    expect(new Set(PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((bundle) => bundle.capabilityIds)).size).toBe(75);
    expect(Math.max(...PRODUCTION_DEFI_CAPABILITY_BUNDLES.map((bundle) => bundle.capabilityIds.length))).toBe(9);
    expect(npm.find((bundle) => bundle.chainIds[0] === 1)!.capabilityIds.length + blue.find((bundle) => bundle.chainIds[0] === 1)!.capabilityIds.length).toBe(15);
    expect(npm.find((bundle) => bundle.chainIds[0] === 8453)!.capabilityIds.length + blue.find((bundle) => bundle.chainIds[0] === 8453)!.capabilityIds.length).toBe(15);
  });

  it('binds every NPM multicall profile to its wrapper and exactly its eight explicit child grants', () => {
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((item) => item.bundleId.startsWith('uniswap-v3-'))) {
      const wrapper = flat.find((fn) => fn.capabilityId.endsWith(':multicall') && fn.chainId === bundle.chainIds[0])!;
      expect(wrapper.executionScope?.kind).toBe('same-target-multicall-v1');
      if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Expected scoped NPM multicall');
      expect(wrapper.executionScope.allowedChildren.map((child) => child.capabilityId).sort(cmp)).toEqual(bundle.capabilityIds.filter((id) => id !== wrapper.capabilityId));
      expect(wrapper.executionScope.allowedChildren).toHaveLength(8);
      expect(bundle.warnings.join(' ')).toMatch(/delegatecall/);
      expect(bundle.warnings.join(' ')).toMatch(/residual contract balances/);
    }
  });

  it('includes all legacy Morpho methods and only the three callback-free additions per chain', () => {
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((item) => item.bundleId.startsWith('morpho-blue-'))) {
      const functions = bundle.capabilityIds.map((id) => flat.find((fn) => fn.capabilityId === id)!);
      expect(functions.map((fn) => fn.functionName).sort(cmp)).toEqual(['borrow', 'repay', 'supply', 'supplyCollateral', 'withdraw', 'withdrawCollateral'].sort(cmp));
      expect(functions.filter((fn) => fn.protocol === 'Morpho Blue')).toHaveLength(3);
      expect(functions.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1')).toHaveLength(3);
      expect(bundle.warnings.join(' ')).toMatch(/supply, supplyCollateral, and repay/);
      expect(bundle.warnings.join(' ')).toMatch(/caller-controlled/);
    }
  });

  it('authorizes every one of the 34 new actual catalog functions only with its exact member grant', async () => {
    const newIds = additionalCatalogIds();
    expect(newIds).toHaveLength(34);
    const grants = [...new Set([...newIds, ...PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((bundle) => bundle.capabilityIds)])];
    const { policy } = makePolicy();
    for (const id of newIds) {
      const fn = flat.find((candidate) => candidate.capabilityId === id)!;
      const data = fn.signature === 'multicall(bytes[])'
        ? encoded(fn, { 0: [encoded(flat.find((child) => child.chainId === fn.chainId && child.contract === fn.contract && child.functionName === 'refundETH')!)] })
        : encoded(fn);
      const context = (allowedCapabilityIds: string[]) => ({
        userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
        executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds,
      });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(grants))).resolves.toMatchObject({ matches: [expect.objectContaining({ capabilityId: id })] });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(grants.filter((grant) => grant !== id)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });

  it('requires the NPM wrapper and each selected child grant independently and denies unknown recursion', async () => {
    const profile = PRODUCTION_DEFI_CAPABILITY_BUNDLES.find((bundle) => bundle.bundleId === 'uniswap-v3-positions-1')!;
    const wrapper = flat.find((fn) => fn.capabilityId.endsWith(':multicall') && fn.chainId === 1)!;
    if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Missing production NPM scope');
    const children = wrapper.executionScope.allowedChildren.map((binding) => flat.find((fn) => fn.capabilityId === binding.capabilityId)!);
    const childCalls = children.map((child) => encoded(child));
    const allCalls = encoded(wrapper, { 0: childCalls });
    const { policy } = makePolicy();
    const context = (allowedCapabilityIds: string[]) => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: 1, executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context([...profile.capabilityIds]))).resolves.toMatchObject({ executionPlan: expect.arrayContaining([expect.objectContaining({ path: [0, 0] })]) });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context(profile.capabilityIds.filter((id) => id !== wrapper.capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context(profile.capabilityIds.filter((id) => id !== children[0].capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const recursive = encoded(wrapper, { 0: [encoded(wrapper, { 0: [encoded(children[0])] })] });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: recursive }], context([...profile.capabilityIds]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('permits only empty callback bytes for all six actual Morpho callback functions', async () => {
    const callbacks = flat.filter((fn) => fn.protocol === 'morpho-blue' && fn.executionScope?.kind === 'empty-callback-data-v1');
    expect(callbacks).toHaveLength(6);
    const grants = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((bundle) => bundle.bundleId.startsWith('morpho-blue-')).flatMap((bundle) => bundle.capabilityIds);
    const { policy } = makePolicy();
    for (const fn of callbacks) {
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn) }], {
        userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
        executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: grants,
    })).resolves.toMatchObject({ matches: [expect.objectContaining({ capabilityId: fn.capabilityId })] });
    }
    const fn = callbacks[0];
    const scope = fn.executionScope;
    if (!scope || scope.kind !== 'empty-callback-data-v1') throw new Error('Expected Morpho callback scope');
    const bytesIndex = scope.bytesArgIndex;
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn, { [bytesIndex]: '0x00' }) }], {
      userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
      executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: grants,
    })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('keeps complete fixed membership visible when a live pause marks one bundle member unavailable', async () => {
    const bundle = PRODUCTION_DEFI_CAPABILITY_BUNDLES[0];
    const pausedId = bundle.capabilityIds[0];
    const pausedFunction = flat.find((fn) => fn.capabilityId === pausedId)!;
    const state = { id: 'global', pausedScopeKeys: [defiPauseScopeKeysForCapability(pausedFunction).at(-1)!] };
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue(state) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const service = new DefiBundleService(PRODUCTION_DEFI_CAPABILITY_BUNDLES, catalog);
    const response = await service.listMetadata();
    expect(response.maxGrants).toBe(100);
    expect(response.bundles[0]).toMatchObject({ available: false, capabilityIds: bundle.capabilityIds, unavailableCapabilityIds: [pausedId] });
    expect(response.bundles).toHaveLength(9);
  });
});

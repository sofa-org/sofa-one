import { readFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { defiPauseScopeKeysForCapability, type DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_CATALOG } from '../registry/production-registry';
import { GENERATED_DEFI_REGISTRY } from '../registry/generated/production-catalog';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from './production-bundles';
import { capabilityBundleFingerprint, DefiBundleService } from './bundle.service';

const OWNER = '0x0000000000000000000000000000000000000001';
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
  const args = fn.abi.inputs.map((input, index) => Object.prototype.hasOwnProperty.call(overrides, String(index))
    ? overrides[String(index)] : sample(input as TestAbiParameter));
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
}

function makePolicy() {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
  return { policy: new DefiPolicyService(prisma as never, {} as never, catalog), prisma, catalog };
}

describe('current production profiles', () => {
  it('matches the single checked-in catalog and fingerprints every literal metadata profile', () => {
    const document = JSON.parse(readFileSync('data/defi-catalog/catalog.json', 'utf8')) as { chains: unknown };
    expect(document.chains).toEqual(GENERATED_DEFI_REGISTRY.chains);
    expect(flat).toHaveLength(797);
    expect(flat.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(flat.filter((fn) => fn.executionScope)).toHaveLength(17);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);

    const profileIds = new Set<string>();
    for (const profile of PRODUCTION_DEFI_CAPABILITY_BUNDLES) {
      expect(profile.version).toBe('1.0.0');
      expect(profile.capabilityIds).toEqual([...profile.capabilityIds].sort());
      expect(profile.fingerprint).toBe(capabilityBundleFingerprint(profile, flat));
      for (const id of profile.capabilityIds) {
        expect(profileIds.has(id)).toBe(false);
        profileIds.add(id);
        expect(flat.find((fn) => fn.capabilityId === id)).toMatchObject({ status: 'active', type: 'contract_call' });
      }
    }
    expect(profileIds.size).toBe(399);
  });

  it('binds each Uniswap V3 multicall profile to its wrapper and exact explicit children', () => {
    for (const profile of PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((item) => item.bundleId.startsWith('uniswap-v3-'))) {
      const wrapper = flat.find((fn) => fn.capabilityId.endsWith(':multicall') && fn.chainId === profile.chainIds[0] && fn.capabilityId.startsWith('uniswap-v3-position-manager:'))!;
      expect(wrapper.executionScope?.kind).toBe('same-target-multicall-v1');
      if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Expected scoped NPM multicall');
      expect(wrapper.executionScope.allowedChildren.map((child) => child.capabilityId).sort()).toEqual(profile.capabilityIds.filter((id) => id !== wrapper.capabilityId));
      expect(wrapper.executionScope.allowedChildren).toHaveLength(8);
    }
  });

  it('includes only the six Morpho callback-free operations in its two profiles', () => {
    for (const profile of PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((item) => item.bundleId.startsWith('morpho-blue-'))) {
      const functions = profile.capabilityIds.map((id) => flat.find((fn) => fn.capabilityId === id)!);
      expect(functions.map((fn) => fn.functionName).sort()).toEqual(['borrow', 'repay', 'supply', 'supplyCollateral', 'withdraw', 'withdrawCollateral'].sort());
      expect(functions.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1')).toHaveLength(3);
    }
  });

  it('requires the wrapper and every selected child grant independently and denies recursion', async () => {
    const profile = PRODUCTION_DEFI_CAPABILITY_BUNDLES.find((bundle) => bundle.bundleId === 'uniswap-v3-positions-1')!;
    const wrapper = flat.find((fn) => fn.capabilityId.endsWith(':multicall') && fn.chainId === 1)!;
    if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Missing production NPM scope');
    const children = wrapper.executionScope.allowedChildren.map((binding) => flat.find((fn) => fn.capabilityId === binding.capabilityId)!);
    const allCalls = encoded(wrapper, { 0: children.map((child) => encoded(child)) });
    const { policy } = makePolicy();
    const context = (allowedCapabilityIds: string[]) => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: 1, executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context([...profile.capabilityIds]))).resolves.toMatchObject({ executionPlan: expect.arrayContaining([expect.objectContaining({ path: [0, 0] })]) });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context(profile.capabilityIds.filter((id) => id !== wrapper.capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context(profile.capabilityIds.filter((id) => id !== children[0].capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const recursive = encoded(wrapper, { 0: [encoded(wrapper, { 0: [encoded(children[0])] })] });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: recursive }], context([...profile.capabilityIds]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('permits only empty callback bytes for each Morpho callback function', async () => {
    const callbacks = flat.filter((fn) => fn.protocol === 'morpho-blue' && fn.executionScope?.kind === 'empty-callback-data-v1');
    expect(callbacks).toHaveLength(6);
    const grants = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((profile) => profile.bundleId.startsWith('morpho-blue-')).flatMap((profile) => profile.capabilityIds);
    const { policy } = makePolicy();
    for (const fn of callbacks) {
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn) }], {
        userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
        executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: grants,
      })).resolves.toMatchObject({ matches: [expect.objectContaining({ capabilityId: fn.capabilityId })] });
    }
    const fn = callbacks[0];
    if (fn.executionScope?.kind !== 'empty-callback-data-v1') throw new Error('Expected Morpho callback scope');
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn, { [fn.executionScope.bytesArgIndex]: '0x00' }) }], {
      userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
      executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: grants,
    })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('keeps all profile members visible while pause state makes a profile unavailable', async () => {
    const profile = PRODUCTION_DEFI_CAPABILITY_BUNDLES[0];
    const pausedId = profile.capabilityIds[0];
    const pausedFunction = flat.find((fn) => fn.capabilityId === pausedId)!;
    const state = { id: 'global', pausedScopeKeys: [defiPauseScopeKeysForCapability(pausedFunction).at(-1)!] };
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue(state) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const response = await new DefiBundleService(PRODUCTION_DEFI_CAPABILITY_BUNDLES, catalog).listMetadata();
    expect(response.bundles[0]).toMatchObject({ available: false, capabilityIds: profile.capabilityIds, unavailableCapabilityIds: [pausedId] });
    expect(response.bundles).toHaveLength(69);
  });
});

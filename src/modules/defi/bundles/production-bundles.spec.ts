import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { defiPauseScopeKeysForCapability, type DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_CATALOG } from '../registry/production-registry';
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
  it('binds metadata profile fingerprints to active catalog members without duplicate membership', () => {
    const profileIds = new Set<string>();
    for (const profile of PRODUCTION_DEFI_CAPABILITY_BUNDLES) {
      expect(profile.fingerprint).toBe(capabilityBundleFingerprint(profile, flat));
      for (const id of profile.capabilityIds) {
        expect(profileIds.has(id)).toBe(false);
        profileIds.add(id);
        expect(flat.find((fn) => fn.capabilityId === id)).toMatchObject({ status: 'active', type: 'contract_call' });
      }
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
    const callbacks = flat.filter((fn) => fn.capabilityId.startsWith('morpho-blue:') && fn.executionScope?.kind === 'empty-callback-data-v1');
    const callbackArgIndexes = new Set<number>();
    const { policy } = makePolicy();
    for (const fn of callbacks) {
      if (fn.executionScope?.kind !== 'empty-callback-data-v1') throw new Error('Expected Morpho callback scope');
      callbackArgIndexes.add(fn.executionScope.bytesArgIndex);
      const context = {
        userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
        executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: [fn.capabilityId],
      };
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn) }], context))
        .resolves.toMatchObject({ matches: [expect.objectContaining({ capabilityId: fn.capabilityId })] });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn) }], { ...context, allowedCapabilityIds: [] }))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn, { [fn.executionScope.bytesArgIndex]: '0x00' }) }], context))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    expect([...callbackArgIndexes]).toEqual(expect.arrayContaining([3, 4]));
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
  });
});

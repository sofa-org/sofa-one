import { parseAbi } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiChainPolicy, DefiFunctionPolicy } from './defi.types';
import { buildReviewedManifest } from './registry/defi-manifest';

const contract = '0x0000000000000000000000000000000000000001';
const abi = parseAbi(['function touch(address owner, uint256 amount)']);
const fn: DefiFunctionPolicy = {
  capabilityId: 'fixture:touch:v1', type: 'contract_call', chainId: 1, contract,
  signature: 'touch(address,uint256)', functionName: 'touch', abi: abi[0],
  policy: { ref: 'fixture', version: 1 }, status: 'active',
  provenance: { sourceRef: 'fixture verified ABI', verifiedAt: '2026-01-01', status: 'verified' },
};
const makeCatalog = (functions: DefiFunctionPolicy[] = [fn]): DefiChainPolicy[] => [{ chainId: 1, status: 'active', contracts: [{ address: contract, status: 'active', functions }] }];
const makeService = (catalog: DefiChainPolicy[], state: unknown = { id: 'global', pausedScopeKeys: [] }) => {
  const manifest = buildReviewedManifest([{ chains: catalog }]);
  return new DefiCatalogService(catalog, { defiPolicyState: { findUnique: jest.fn().mockResolvedValue(state) } } as unknown as PrismaService, manifest);
};

describe('DefiCatalogService', () => {
  it('filters requested metadata in order, preserves paused states, and returns unknown IDs', async () => {
    const pausedFn = {
      ...fn,
      capabilityId: 'fixture:paused:v1',
      signature: 'touchPaused(address,uint256)',
      functionName: 'touchPaused',
      abi: parseAbi(['function touchPaused(address owner, uint256 amount)'])[0],
    };
    const service = makeService(makeCatalog([fn, pausedFn]), {
      id: 'global',
      pausedScopeKeys: ['capability:fixture:paused:v1'],
    });
    const response = await service.listMetadataByIds([
      'fixture:paused:v1',
      'unknown',
      'fixture:touch:v1',
    ]);
    expect(response.capabilities.map((item) => item?.capabilityId)).toEqual([
      'fixture:paused:v1',
      'fixture:touch:v1',
    ]);
    expect(response.capabilities[0]?.status).toBe('paused');
    expect(response.unknownIds).toEqual(['unknown']);
  });

  it('fails closed when metadata state is unavailable for a filtered query', async () => {
    const service = makeService(makeCatalog(), null);
    await expect(service.listMetadataByIds(['fixture:touch:v1'])).rejects.toThrow();
  });

  it('rejects duplicate capability IDs and per-contract selectors at construction', () => {
    expect(() => makeService(makeCatalog([fn, { ...fn }]))).toThrow(/Duplicate DeFi capability identity/);
    expect(() => makeService(makeCatalog([fn, { ...fn, capabilityId: 'fixture:other:v1' }]))).toThrow(/Ambiguous DeFi selector/);
  });

  it('rejects inconsistent hierarchy, ABI, and unverified active provenance', () => {
    expect(() => makeService(makeCatalog([{ ...fn, chainId: 2 }]))).toThrow(/Inconsistent DeFi catalog hierarchy/);
    expect(() => makeService(makeCatalog([{ ...fn, functionName: 'other' }]))).toThrow(/Invalid fixed DeFi ABI/);
    expect(() => makeService(makeCatalog([{ ...fn, signature: 'touch(uint256,address)' }]))).toThrow(/Inconsistent fixed DeFi ABI/);
    expect(() => makeService(makeCatalog([{ ...fn, provenance: { sourceRef: 'candidate', verifiedAt: '2026-01-01', status: 'candidate' } }]))).toThrow(/requires verified provenance/);
    expect(() => makeService([{ ...makeCatalog()[0], contracts: [{ ...makeCatalog()[0].contracts[0], functions: [{ ...fn, type: 'typed_data_sign' }] }] }])).toThrow(/Invalid active DeFi capability hierarchy/);
  });

  it('does not expose mutable catalog identities and omits chains with no active contract-call capability', () => {
    const source = makeCatalog() as Array<{ chainId: number; status: 'active' | 'inactive'; contracts: Array<{ address: string; status: 'active' | 'inactive'; functions: DefiFunctionPolicy[] }> }>;
    const service = makeService(source);
    source[0].contracts.splice(0);
    expect(service.activeChain(1)?.contracts).toHaveLength(1);
    expect(Object.isFrozen(service.chains())).toBe(true);
    expect(Object.isFrozen(service.chains()[0].contracts[0].functions)).toBe(true);
    expect(Object.isFrozen(service.functionForCapability(fn.capabilityId))).toBe(true);
    expect(makeService([{ ...makeCatalog()[0], contracts: [{ address: contract, status: 'inactive', functions: [{ ...fn, status: 'inactive' }] }] }]).activeChain(1)).toBeUndefined();
  });

  it('returns authoritative paused metadata and fails closed on missing state', async () => {
    await expect(makeService(makeCatalog(), { id: 'global', pausedScopeKeys: ['contract:1:0x0000000000000000000000000000000000000001'] }).listMetadata()).resolves.toMatchObject({ capabilities: expect.arrayContaining([expect.objectContaining({ capabilityId: fn.capabilityId, status: 'paused' }), expect.objectContaining({ capabilityId: 'polymarket:137:clob-auth:v1', type: 'typed_data_sign' })]) });
    await expect(makeService(makeCatalog(), null).listMetadata()).rejects.toMatchObject({ response: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const inactive = [{ ...makeCatalog()[0], contracts: [{ ...makeCatalog()[0].contracts[0], status: 'inactive' as const, functions: [{ ...fn, status: 'inactive' as const }] }] }];
    await expect(makeService(inactive, { id: 'global', pausedScopeKeys: ['global'] }).listMetadata()).resolves.toMatchObject({ capabilities: expect.arrayContaining([expect.objectContaining({ capabilityId: fn.capabilityId, status: 'inactive' }), expect.objectContaining({ capabilityId: 'polymarket:137:clob-auth:v1', status: 'paused' })]) });
  });
});

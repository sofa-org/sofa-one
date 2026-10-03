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
    await expect(makeService(makeCatalog(), { id: 'global', pausedScopeKeys: ['contract:1:0x0000000000000000000000000000000000000001'] }).listMetadata()).resolves.toMatchObject({ capabilities: [{ status: 'paused' }] });
    await expect(makeService(makeCatalog(), null).listMetadata()).rejects.toMatchObject({ response: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const inactive = [{ ...makeCatalog()[0], contracts: [{ ...makeCatalog()[0].contracts[0], status: 'inactive' as const, functions: [{ ...fn, status: 'inactive' as const }] }] }];
    await expect(makeService(inactive, { id: 'global', pausedScopeKeys: ['global'] }).listMetadata()).resolves.toMatchObject({ capabilities: [{ status: 'inactive' }] });
  });
});

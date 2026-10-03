import { DefiCatalogService } from './defi-catalog.service';
import { DefiGrantService } from './defi-grant.service';
import { buildReviewedManifest } from './registry/defi-manifest';
import { DefiChainPolicy } from './defi.types';
import { parseAbi } from 'viem';

const address = '0x0000000000000000000000000000000000000001';
const activeCatalog: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address, status: 'active', functions: [{
  capabilityId: 'cap:active', type: 'contract_call', chainId: 1, contract: address, signature: 'touch()', functionName: 'touch', abi: parseAbi(['function touch()'])[0], policy: { ref: 'test', version: 1 }, status: 'active', provenance: { sourceRef: 'fixture', verifiedAt: '2026-01-01', status: 'verified' },
}] }] }];

describe('DefiGrantService', () => {
  const service = new DefiGrantService(new DefiCatalogService([] as DefiChainPolicy[], {} as never, buildReviewedManifest()));
  it('normalizes grants in stable sorted order', () => expect(service.normalizeIds(['z', 'a'])).toEqual(['a', 'z']));
  it('rejects duplicates and overlong IDs', () => {
    expect(() => service.normalizeIds(['x', 'x'])).toThrow();
    expect(() => service.normalizeIds(['x'.repeat(161)])).toThrow();
  });
  it('defaults only omitted grants to empty, locks pause state, and ships no grantable capabilities', async () => {
    const tx = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    expect(service.normalizeIds(undefined)).toEqual([]);
    expect(() => service.normalizeIds(null)).toThrow();
    await expect(service.assertGrantableInTx(tx as never, ['unknown'])).rejects.toThrow();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('allows only active, unpaused grants and rejects paused scopes', async () => {
    const active = new DefiGrantService(new DefiCatalogService(activeCatalog, {} as never, buildReviewedManifest([{ chains: activeCatalog }])));
    const tx = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    await expect(active.assertGrantableInTx(tx as never, ['cap:active'])).resolves.toEqual(['cap:active']);
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: ['chain:1'] });
    await expect(active.assertGrantableInTx(tx as never, ['cap:active'])).rejects.toThrow();
  });
  it('fails closed with a stable unavailable code when the singleton is missing', async () => {
    const tx = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn().mockResolvedValue(null) } };
    await expect(service.assertGrantableInTx(tx as never, [])).rejects.toMatchObject({ response: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });
});

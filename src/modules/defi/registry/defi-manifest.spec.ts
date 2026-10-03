import { parseAbi } from 'viem';
import { buildReviewedManifest, buildDefiManifestHash, functionAbiHash, reviewedAbiHash } from './defi-manifest';
import type { DefiRegistryFragment } from './defi-manifest.types';

const fn = (capabilityId: string, overrides: Record<string, unknown> = {}) => ({
  capabilityId, type: 'contract_call' as const, chainId: 1, contract: '0x0000000000000000000000000000000000000001',
  functionName: 'x', signature: 'x()', abi: parseAbi(['function x()'])[0], policy: { ref: 'p', version: 1 }, status: 'inactive' as const,
  provenance: { sourceRef: 'official source', verifiedAt: '2026-01-01', status: 'candidate' as const }, ...overrides,
});
const fragment = (capabilityId: string): DefiRegistryFragment => ({ chains: [{ chainId: 1, status: 'inactive', contracts: [{ address: '0x0000000000000000000000000000000000000001', status: 'inactive', functions: [fn(capabilityId)] }] }] });

describe('reviewed manifest assembler', () => {
  it('merges nested family catalogs, deep-clones/freezes inputs, and sorts identities deterministically', () => {
    const a = fragment('a');
    const b = { chains: [{ ...fragment('b').chains[0], contracts: [{ ...fragment('b').chains[0].contracts[0], address: '0x0000000000000000000000000000000000000004', functions: [fn('b', { contract: '0x0000000000000000000000000000000000000004' })] }] }] };
    const manifest = buildReviewedManifest([a, b]);
    expect(manifest.chains[0].contracts).toHaveLength(2);
    expect(Object.isFrozen(a.chains[0].contracts[0].functions[0])).toBe(false);
    expect(Object.isFrozen(manifest.chains[0].contracts[0].functions[0])).toBe(true);
    expect(buildReviewedManifest([b, a]).manifestHash).toBe(manifest.manifestHash);
  });

  it('hashes only sorted capability identity fields, excluding copy and provenance dates', () => {
    const original = fn('a');
    const cosmetic = fn('a', { label: 'different', description: 'copy', provenance: { sourceRef: 'same source', verifiedAt: '2026-02-02', status: 'candidate' } });
    expect(buildDefiManifestHash([original])).toBe(buildDefiManifestHash([cosmetic]));
    expect(buildDefiManifestHash([original])).not.toBe(buildDefiManifestHash([fn('b')]));
    expect(functionAbiHash(original)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reviewedAbiHash(original.abi ? [original.abi] : [])).toBe(functionAbiHash(original));
  });

  it('rejects duplicate IDs, ambiguous selectors, and inconsistent chain/address/ABI identities', () => {
    expect(() => buildReviewedManifest([fragment('x'), fragment('x')])).toThrow(/Duplicate DeFi capability identity/);
    expect(() => buildReviewedManifest([fragment('a'), fragment('b')])).toThrow(/Ambiguous DeFi selector/);
    expect(() => buildReviewedManifest([{ chains: [{ ...fragment('x').chains[0], contracts: [{ ...fragment('x').chains[0].contracts[0], functions: [fn('x', { chainId: 2 })] }] }] }])).toThrow(/Inconsistent DeFi catalog hierarchy/);
    expect(() => buildReviewedManifest([{ chains: [{ ...fragment('x').chains[0], status: 'active', contracts: [{ ...fragment('x').chains[0].contracts[0], status: 'active', functions: [fn('x', { status: 'active', provenance: { sourceRef: 'candidate source', verifiedAt: '2026-01-01', status: 'candidate' } })] }] }] }])).toThrow(/requires verified provenance/);
  });

  it('allows verified active identity without execution or funded evidence', () => {
    const active = { ...fn('active', { status: 'active', provenance: { sourceRef: 'official deployment and ABI', verifiedAt: '2026-01-01', status: 'verified' } }), contract: '0x0000000000000000000000000000000000000001' };
    const manifest = buildReviewedManifest([{ chains: [{ chainId: 1, status: 'active', contracts: [{ address: active.contract, status: 'active', functions: [active] }] }] }]);
    expect(manifest.capabilities[0].status).toBe('active');
  });
});

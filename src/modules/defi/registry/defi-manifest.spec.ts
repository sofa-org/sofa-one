import { parseAbi } from 'viem';
import { buildReviewedManifest, buildDefiManifestHash, functionAbiHash, reviewedAbiHash } from './defi-manifest';
import type { DefiRegistryFragment } from './defi-manifest.types';
import { GENERATED_DEFI_REGISTRY } from './generated/production-catalog';
import { createEnsoStaticWeirollScope, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from '../execution/enso-identity';
import type { DefiFunctionPolicy } from '../defi.types';

const fn = (capabilityId: string, overrides: Record<string, unknown> = {}) => ({
  capabilityId, type: 'contract_call' as const, chainId: 1, contract: '0x0000000000000000000000000000000000000001',
  functionName: 'x', signature: 'x()', abi: parseAbi(['function x()'])[0], policy: { ref: 'p', version: 1 }, status: 'inactive' as const,
  provenance: { sourceRef: 'official source', verifiedAt: '2026-01-01', status: 'candidate' as const }, ...overrides,
});
const fragment = (capabilityId: string): DefiRegistryFragment => ({ chains: [{ chainId: 1, status: 'inactive', contracts: [{ address: '0x0000000000000000000000000000000000000001', status: 'inactive', functions: [fn(capabilityId)] }] }] });

const ensoAbi = {
  type: 'function' as const,
  name: 'routeSingle',
  stateMutability: 'payable' as const,
  inputs: [
    { internalType: 'struct Token', name: 'tokenIn', type: 'tuple', components: [
      { internalType: 'enum TokenType', name: 'tokenType', type: 'uint8' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
    ] },
    { internalType: 'bytes', name: 'data', type: 'bytes' },
  ],
  outputs: [{ internalType: 'bytes', name: 'response', type: 'bytes' }],
};

const ensoRoot = (overrides: Record<string, unknown> = {}): DefiFunctionPolicy => ({
  capabilityId: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId,
  type: 'contract_call',
  chainId: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.chainId,
  contract: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract,
  functionName: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.functionName,
  signature: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.signature,
  abi: ensoAbi as never,
  status: 'inactive',
  provenance: { sourceRef: 'pinned Enso router/Weiroll source', verifiedAt: '2026-10-05', status: 'candidate' },
  executionScope: createEnsoStaticWeirollScope(),
  ...overrides,
} as DefiFunctionPolicy);

const ensoRootFragment = (root: DefiFunctionPolicy): DefiRegistryFragment => ({ chains: [{ chainId: 1, status: 'inactive', contracts: [{ address: root.contract, status: 'inactive', functions: [root] }] }] });
const cloneGeneratedRegistry = (): DefiRegistryFragment => JSON.parse(JSON.stringify(GENERATED_DEFI_REGISTRY)) as DefiRegistryFragment;
/** Reconstitute only the frozen v7 fixture view by removing the one exact v8 Enso root identity. */
const cloneV7BaselineWithoutEnsoRoot = (): DefiRegistryFragment => {
  const generated = cloneGeneratedRegistry();
  return {
    ...generated,
    chains: generated.chains.map((chain) => ({
      ...chain,
      contracts: chain.contracts.map((contract) => ({
        ...contract,
        functions: contract.functions.filter((item) => item.capabilityId !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId),
      })),
    })),
  };
};

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

  it('accepts only the exact inactive Enso router root with its mandatory finite child scope', () => {
    expect(functionAbiHash({ abi: ensoAbi as never })).toBe(ENSO_STATIC_WEIROLL_ROOT_IDENTITY.abiHash);
    const manifest = buildReviewedManifest([cloneV7BaselineWithoutEnsoRoot(), ensoRootFragment(ensoRoot())]);
    const root = manifest.capabilities.find((item) => item.capabilityId === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId)!;
    expect(root.status).toBe('inactive');
    expect(root.executionScope?.kind).toBe('enso-static-weiroll-v1');
    expect(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES).toHaveLength(3);
  });

  it('requires the exact Enso root identity and cannot move the language onto another root', () => {
    expect(() => buildReviewedManifest([ensoRootFragment(ensoRoot({ executionScope: undefined }))])).toThrow(/Enso static Weiroll root/);
    expect(() => buildReviewedManifest([ensoRootFragment(ensoRoot({ executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 1 } }))])).toThrow(/Enso static Weiroll root/);
    expect(() => buildReviewedManifest([ensoRootFragment(ensoRoot({ capabilityId: 'enso:unreviewed' }))])).toThrow(/Enso static Weiroll root/);
    expect(() => buildReviewedManifest([ensoRootFragment(ensoRoot({ contract: '0x0000000000000000000000000000000000000001' }))])).toThrow(/Enso static Weiroll root/);
    const alteredAbi = { ...ensoAbi, outputs: [{ ...ensoAbi.outputs[0], name: 'altered' }] };
    expect(() => buildReviewedManifest([ensoRootFragment(ensoRoot({ abi: alteredAbi }))])).toThrow(/Enso static Weiroll root/);
    const unrelatedWithScope = fn('foreign-root', { executionScope: createEnsoStaticWeirollScope() });
    expect(() => buildReviewedManifest([{ chains: [{ chainId: 1, status: 'inactive', contracts: [{ address: unrelatedWithScope.contract, status: 'inactive', functions: [unrelatedWithScope] }] }] }])).toThrow(/Enso static Weiroll root/);
  });

  it('resolves every Enso child to an active exact ordinary function in the combined manifest', () => {
    const withRoot = (base: DefiRegistryFragment) => buildReviewedManifest([base, ensoRootFragment(ensoRoot())]);
    expect(withRoot(cloneV7BaselineWithoutEnsoRoot()).capabilities).toHaveLength(buildReviewedManifest([cloneV7BaselineWithoutEnsoRoot()]).capabilities.length + 1);
    for (const missing of ENSO_STATIC_WEIROLL_CHILD_IDENTITIES) {
      const base = cloneV7BaselineWithoutEnsoRoot();
      const withoutChild = { ...base, chains: base.chains.map((chain) => ({ ...chain, contracts: chain.contracts.map((contract) => ({ ...contract, functions: contract.functions.filter((item) => item.capabilityId !== missing.capabilityId) })) })) };
      expect(() => withRoot(withoutChild)).toThrow(/Enso static Weiroll child binding/);

      const inactive = cloneV7BaselineWithoutEnsoRoot();
      const inactiveChild = { ...inactive, chains: inactive.chains.map((chain) => ({ ...chain, contracts: chain.contracts.map((contract) => ({ ...contract, functions: contract.functions.map((item) => item.capabilityId === missing.capabilityId ? { ...item, status: 'inactive' as const } : item) })) })) };
      expect(() => withRoot(inactiveChild)).toThrow(/Enso static Weiroll child binding/);

      const alteredAbi = cloneV7BaselineWithoutEnsoRoot();
      const alteredChildAbi = {
        ...alteredAbi,
        chains: alteredAbi.chains.map((chain) => ({
          ...chain,
          contracts: chain.contracts.map((contract) => ({
            ...contract,
            functions: contract.functions.map((item) => {
              if (item.capabilityId !== missing.capabilityId) return item;
              const abi = { ...item.abi, outputs: [...item.abi.outputs, { type: 'uint8' }] };
              return { ...item, abi, abiHash: functionAbiHash({ abi } as never) };
            }),
          })),
        })),
      };
      expect(() => withRoot(alteredChildAbi)).toThrow(/Enso static Weiroll child binding/);
    }
  });
});

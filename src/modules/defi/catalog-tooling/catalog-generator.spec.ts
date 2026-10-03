import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReviewedManifest } from '../registry/defi-manifest';
import { assertBaselinePreserved, BASELINE_MANIFEST_HASH, catalogDiff, renderGeneratedModule, stableCatalogJson, validateBaseline, validateCatalogDocument } from './catalog-generator';
import { buildSparkLendRegistry } from '../registry/spark-lend';

const valid = { schemaVersion: 1, chains: buildSparkLendRegistry().chains };

describe('DeFi catalog generator', () => {
  it('pins the complete pre-migration 202-definition snapshot, hierarchy, and 179/23 action-approval split', () => {
    const dataRoot = resolve(process.cwd(), 'data/defi-catalog/v1');
    const baseline = validateBaseline(JSON.parse(readFileSync(resolve(dataRoot, 'pre-migration-baseline.json'), 'utf8')));
    const catalog = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'catalog.json'), 'utf8')));
    const capabilities = buildReviewedManifest([catalog]).capabilities;
    expect(capabilities).toHaveLength(202);
    expect(capabilities.filter((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(capabilities).toHaveLength(179 + 23);
    expect(buildReviewedManifest([catalog]).manifestHash).toBe(BASELINE_MANIFEST_HASH);
    expect(baseline.chains.map((chain) => chain.chainId)).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(catalogDiff({ chains: baseline.chains }, catalog)).toEqual({ added: [], removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
  });

  it('validates a versioned nested fragment and renders deterministic TypeScript without runtime imports', () => {
    const fragment = validateCatalogDocument(valid);
    expect(stableCatalogJson(fragment)).toBe(stableCatalogJson(validateCatalogDocument(JSON.parse(stableCatalogJson(fragment)))));
    const generated = renderGeneratedModule(fragment);
    expect(generated).toContain("import type { DefiRegistryFragment }");
    expect(generated).not.toContain('from "viem"');
    expect(buildReviewedManifest([fragment]).capabilities).toHaveLength(4);
  });

  it.each([
    [{ ...valid, schemaVersion: 2 }, /schemaVersion/],
    [{ ...valid, unknown: true }, /unsupported fields/],
    [{ ...valid, chains: [{ ...valid.chains[0], chainId: Number.POSITIVE_INFINITY }] }, /invalid fields/],
    [{ ...valid, chains: [{ ...valid.chains[0], contracts: [{ ...valid.chains[0].contracts[0], functions: [{ ...valid.chains[0].contracts[0].functions[0], extra: 'no' }] }] }] }, /unsupported fields/],
  ])('rejects malformed or unsupported catalog data', (document, error) => {
    expect(() => validateCatalogDocument(document)).toThrow(error);
  });

  it('fails closed on active unverified provenance, inconsistent ABI, duplicate IDs and colliding selectors', () => {
    const source = valid.chains[0];
    const contract = source.contracts[0];
    const fn = contract.functions[0];
    const withFunctions = (functions: unknown[]) => ({ schemaVersion: 1, chains: [{ ...source, contracts: [{ ...contract, functions }] }] });
    expect(() => validateCatalogDocument(withFunctions([{ ...fn, provenance: { ...fn.provenance, status: 'candidate' } }]))).toThrow(/requires verified provenance/);
    expect(() => validateCatalogDocument(withFunctions([{ ...fn, signature: 'wrong()' }]))).toThrow(/Inconsistent fixed DeFi ABI/);
    expect(() => validateCatalogDocument(withFunctions([fn, fn]))).toThrow(/Duplicate DeFi capability identity/);
    expect(() => validateCatalogDocument(withFunctions([fn, { ...fn, capabilityId: `${fn.capabilityId}:duplicate` }]))).toThrow(/Ambiguous DeFi selector/);
  });

  it('reports metadata changes separately from ABI identity and blocks baseline changes', () => {
    const before = validateCatalogDocument(valid);
    const fn = before.chains[0].contracts[0].functions[0];
    const after = validateCatalogDocument({ schemaVersion: 1, chains: [{ ...before.chains[0], contracts: [{ ...before.chains[0].contracts[0], functions: before.chains[0].contracts[0].functions.map((item) => item.capabilityId === fn.capabilityId ? { ...item, label: 'Changed copy' } : item) }] }] });
    expect(catalogDiff(before, after)).toMatchObject({ added: [], removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [fn.capabilityId] });
    expect(() => assertBaselinePreserved(after, { schemaVersion: 1, baselineManifestHash: 'ignored', chains: before.chains } as never)).toThrow(/Pinned baseline definition changed/);
  });

  it('classifies same-ID target, chain, type, function, status, and ABI changes as authority changes', () => {
    const source = validateCatalogDocument(valid).chains[0];
    const baseFn = source.contracts[0].functions[0];
    const fragment = (fn: typeof baseFn, chainId = fn.chainId) => ({ chains: [{ chainId, status: 'active' as const, contracts: [{ address: fn.contract, status: 'active' as const, functions: [fn] }] }] });
    const cases = [
      { name: 'target', fn: { ...baseFn, contract: '0x0000000000000000000000000000000000000009' } },
      { name: 'chain', fn: { ...baseFn, chainId: 10 }, chainId: 10 },
      { name: 'type', fn: { ...baseFn, type: 'typed_data_sign' as const } },
      { name: 'functionName', fn: { ...baseFn, functionName: 'supplyElsewhere' } },
      { name: 'status', fn: { ...baseFn, status: 'inactive' as const } },
      { name: 'ABI/signature', fn: { ...baseFn, functionName: 'supplyElsewhere', signature: 'supplyElsewhere(address,uint256,address,uint16)', abi: { ...baseFn.abi, name: 'supplyElsewhere' } }, abiChanged: true },
    ];
    for (const item of cases) {
      const diff = catalogDiff(fragment(baseFn), fragment(item.fn, item.chainId));
      expect(diff.authorityChanged).toEqual([baseFn.capabilityId]);
      expect(diff.metadataChanged).toEqual([]);
      expect(diff.abiChanged).toEqual(item.abiChanged ? [baseFn.capabilityId] : []);
    }
  });

  it('classifies provenance source/date copy changes as metadata only', () => {
    const before = validateCatalogDocument(valid);
    const fn = before.chains[0].contracts[0].functions[0];
    for (const provenance of [
      { ...fn.provenance, sourceRef: 'new display/source reference' },
      { ...fn.provenance, verifiedAt: '2026-10-04' },
    ]) {
      const after = validateCatalogDocument({ schemaVersion: 1, chains: [{ ...before.chains[0], contracts: [{ ...before.chains[0].contracts[0], functions: before.chains[0].contracts[0].functions.map((item) => item.capabilityId === fn.capabilityId ? { ...item, provenance } : item) }] }] });
      expect(catalogDiff(before, after)).toMatchObject({ authorityChanged: [], abiChanged: [], metadataChanged: [fn.capabilityId] });
    }
  });
});

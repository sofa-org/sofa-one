import { GENERATED_DEFI_REGISTRY } from '../registry/generated/production-catalog';
import { readFileSync } from 'node:fs';
import {
  catalogDiff,
  parseCatalogCliArgs,
  renderGeneratedModule,
  stableCatalogJson,
  validateCatalogDocument,
} from './catalog-generator';

const document = { schemaVersion: 1, chains: GENERATED_DEFI_REGISTRY.chains };

describe('current DeFi catalog pipeline', () => {
  it('accepts only the single generate/check/diff workflow without path overrides', () => {
    for (const mode of ['generate', 'check', 'diff'] as const) {
      expect(parseCatalogCliArgs([mode])).toEqual({ mode, inputPath: 'data/defi-catalog/catalog.json' });
      expect(() => parseCatalogCliArgs([mode, '--input', 'data/defi-catalog/archive/catalog.json'])).toThrow();
    }
    expect(() => parseCatalogCliArgs(['assemble'])).toThrow();
    expect(() => parseCatalogCliArgs(['check', '--plan', 'plan.json'])).toThrow();
  });

  it('round-trips the committed catalog to the exact static runtime module', () => {
    const current = validateCatalogDocument(document);
    expect(JSON.parse(stableCatalogJson(current))).toEqual(document);
    expect(renderGeneratedModule(current)).toBe(readFileSync('src/modules/defi/registry/generated/production-catalog.ts', 'utf8'));
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, chains: [] },
    { schemaVersion: 1, chains: [{ chainId: 1, status: 'active', contracts: [], surprise: true }] },
    { schemaVersion: 1, chains: [{ chainId: 1, status: 'active', contracts: [{ address: '0xabc', status: 'active', functions: [] }] }] },
  ])('rejects malformed catalog documents (%#)', (value) => {
    expect(() => validateCatalogDocument(value)).toThrow();
  });

  it('rejects altered ABI hashes, invalid source status, and malformed execution scopes', () => {
    const chain = structuredClone(document.chains);
    const fn = chain[0].contracts[0].functions[0];
    const badHash = structuredClone(chain);
    (badHash[0].contracts[0].functions[0] as any).abiHash = `0x${'0'.repeat(64)}`;
    expect(() => validateCatalogDocument({ schemaVersion: 1, chains: badHash })).toThrow();

    const badSource = structuredClone(chain);
    (badSource[0].contracts[0].functions[0].provenance as any).status = 'candidate';
    expect(() => validateCatalogDocument({ schemaVersion: 1, chains: badSource })).toThrow();

    const scoped = structuredClone(chain);
    (scoped[0].contracts[0].functions[0] as any).executionScope = { kind: 'unknown-scope' };
    expect(() => validateCatalogDocument({ schemaVersion: 1, chains: scoped })).toThrow();
    expect(fn.status).toBe('active');
  });

  it('reports metadata changes without mutating the source', () => {
    const original = validateCatalogDocument(document);
    const changed = structuredClone(document);
    const fn = changed.chains[0].contracts[0].functions[0];
    (fn as any).description = `${fn.description} Updated copy.`;
    const result = catalogDiff(original, validateCatalogDocument(changed));
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.metadataChanged).toContain(fn.capabilityId);
    expect(result.abiChanged).toEqual([]);
    expect(document.chains[0].contracts[0].functions[0].description).not.toContain('Updated copy');
  });

  it('flags grant-relevant status changes as authority changes', () => {
    const original = validateCatalogDocument(document);
    const changed = structuredClone(document);
    const fn = changed.chains[0].contracts[0].functions[0];
    (fn as any).status = 'inactive';
    const result = catalogDiff(original, validateCatalogDocument(changed));
    expect(result.authorityChanged).toContain(fn.capabilityId);
    expect(result.metadataChanged).toEqual([]);
    expect(result.abiChanged).toEqual([]);
  });
});

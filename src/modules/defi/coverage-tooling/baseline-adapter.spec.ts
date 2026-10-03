import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { adaptFrozenBaseline, compactJsonPropertyHash } from './baseline-adapter';
import { computeCoverage } from './calculator';
import type { CoverageManifestCapability } from './types';
import { functionAbiHash } from '../registry/defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';

const market = JSON.parse(readFileSync('data/defi-coverage/market-snapshot.json', 'utf8'));
const marketText = readFileSync('data/defi-coverage/market-snapshot.json', 'utf8');
const classification = JSON.parse(readFileSync('data/defi-coverage/discovery-classification.json', 'utf8'));
const workflows = JSON.parse(readFileSync('data/defi-coverage/workflow-baseline.json', 'utf8'));
const manifest: CoverageManifestCapability[] = PRODUCTION_DEFI_MANIFEST.capabilities.map((capability) => ({
  capabilityId: capability.capabilityId,
  status: capability.status,
  type: capability.type,
  chainId: capability.chainId,
  contract: capability.contract,
  signature: capability.signature,
  abiHash: functionAbiHash(capability),
  provenance: capability.provenance,
}));

function sources(overrides: Partial<{ market: any; classification: any; workflows: any; manifest: CoverageManifestCapability[] }> = {}) {
  return {
    market: overrides.market ?? market,
    classification: overrides.classification ?? classification,
    workflows: overrides.workflows ?? workflows,
    manifest: overrides.manifest ?? manifest,
    manifestHash: PRODUCTION_DEFI_MANIFEST.manifestHash,
    sourceRosterCanonicalSha256: compactJsonPropertyHash(marketText, 'protocolUniverse'),
    sourceFileDigests: {
      'data/defi-coverage/market-snapshot.json': digest(JSON.stringify(overrides.market ?? market)),
      'data/defi-coverage/discovery-classification.json': digest(JSON.stringify(overrides.classification ?? classification)),
      'data/defi-coverage/workflow-baseline.json': digest(JSON.stringify(overrides.workflows ?? workflows)),
    },
  };
}

describe('frozen M1 baseline adapter', () => {
  it('recomputes the frozen roster digest from the stored source array rather than JS-number serialization', () => {
    expect(compactJsonPropertyHash(marketText, 'protocolUniverse')).toBe('7fc3a4de44a3eebc1354aa57736cb72b48b21321c766d3c9a31e9eeea47c9b24');
  });

  it('preserves the full unknown roster, exact workflow seed bindings, and conservative claim limits', () => {
    const result = adaptFrozenBaseline(sources());
    const report = computeCoverage(result.input, manifest);
    expect(result.input.unresolvedUniverseRecords).toHaveLength(8_476);
    expect(result.evidence.roster.canonicalJsonSha256).toBe('7fc3a4de44a3eebc1354aa57736cb72b48b21321c766d3c9a31e9eeea47c9b24');
    expect(result.evidence.roster.classifications).toMatchObject({ someTargetChainListedOrProviderChainMatched: 3_497, chainIdentityUnknown: 1_281, noTargetChainEvidenceInRosterFields: 3_698 });
    expect(result.evidence.metrics).toMatchObject({ sourceRows: 1_324, unmatchedMetricIds: 7, positive30DayMetricRows: 2_159, zero30DayMetricRows: 872 });
    expect(result.evidence.workflowProjection).toMatchObject({ sourceProductSeeds: 16, sourceWorkflowDefinitions: 35, exactAddressTargets: 44, unknownTargetRows: 7, exactCatalogFunctionBindingsInSeed: 172, unassignedTargetCount: 1, unassignedExactFunctionBindings: 7 });
    expect(report.products).toMatchObject({ activeProducts: 0, unresolvedProducts: 8_476, conservativeDenominator: 8_476, observedActiveCoverageBps: null, conservativeCoverageBps: 0 });
    expect(report.unattributedUnresolvedUniverseRecords).toBe(8_476);
    expect(report.byChain.every((row) => row.conservativeCoverageBps === null)).toBe(true);
    expect(report.captureTimeStatus).toBe('unknown');
    expect(report.observedAt).toBeNull();
    expect(report.objectiveEstablished).toBe(false);
    expect(result.input.products.every((product) => product.countingRole === 'lineage_only')).toBe(true);
    expect(result.evidence.workflowProjection.sourceWorkflowSeedInventory.filter((row: any) => [1799, 3302, 4249].includes(row.productSeedId)).map((row: any) => row.rawMarketSlug)).toEqual(['velodrome-v1', 'velodrome-v2', 'velodrome-v3']);
    expect(result.evidence.workflowProjection.sourceWorkflowSeedInventory.some((row: any) => row.rawMarketSlug === 'morpho-vault-v2' && row.productSeedId === null)).toBe(true);
  });

  it('rejects roster record loss rather than silently shrinking the global unknown proxy denominator', () => {
    const altered = { ...market, protocolUniverse: market.protocolUniverse.slice(0, -1) };
    expect(() => adaptFrozenBaseline(sources({ market: altered } )).input).toThrow(/roster count/);
  });

  it('rejects a same-size source roster mutation against the frozen canonical roster digest', () => {
    const mutatedText = marketText.replace('"slug": "', '"slug": "changed-');
    expect(mutatedText).not.toBe(marketText);
    expect(() => adaptFrozenBaseline({
      ...sources(),
      market: JSON.parse(mutatedText),
      sourceRosterCanonicalSha256: compactJsonPropertyHash(mutatedText, 'protocolUniverse'),
    })).toThrow(/provider-response hash/);
  });

  it('refuses a workflow source pinned to a different production manifest identity', () => {
    expect(() => adaptFrozenBaseline({ ...sources(), manifestHash: `0x${'0'.repeat(64)}` })).toThrow(/identity.*mismatched/);
  });

  it('turns a mutated workflow ABI binding into an explicit unresolved definition', () => {
    const mutated = structuredClone(workflows);
    const instance = mutated.products.flatMap((product: any) => product.targetInstances).find((row: any) => row.workflowFunctionCoverage && Object.keys(row.workflowFunctionCoverage).length > 0);
    const coverage = Object.values(instance.workflowFunctionCoverage)[0] as any;
    coverage.presentFunctionBindings[0].abiHash = `0x${'0'.repeat(64)}`;
    const result = adaptFrozenBaseline(sources({ workflows: mutated }));
    const report = computeCoverage(result.input, manifest);
    expect(result.evidence.workflowProjection.unresolvedRequirementRows).toBeGreaterThan(0);
    expect(report.workflowInventory.some((row) => row.requirementStatus === 'unresolved')).toBe(true);
    expect(report.objectiveEstablished).toBe(false);
  });
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

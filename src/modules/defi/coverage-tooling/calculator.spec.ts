import { computeCoverage, coverageInputFingerprint, validateCoverageInput } from './calculator';
import type { CoverageInput, CoverageManifestCapability } from './types';

const CAP_ID = 'fixture:capability:one';
const ADDRESS = '0x0000000000000000000000000000000000000001';
const ABI_HASH = `0x${'1'.repeat(64)}`;
const capability: CoverageManifestCapability = { capabilityId: CAP_ID, status: 'active', type: 'contract_call', chainId: 1, contract: ADDRESS, signature: 'deposit()', abiHash: ABI_HASH, provenance: { status: 'verified', sourceRef: 'source:admitted-function', verifiedAt: '2026-10-04' } };

function fixture(productCount = 1): { input: CoverageInput; capabilities: CoverageManifestCapability[] } {
  const products = Array.from({ length: productCount }, (_, i) => ({ productId: `product:${i}`, label: `Product ${i}`, categoryId: 'lending', countingRole: 'coverage_unit' as const, expectedScopeChainIds: [1], chainInventoryCompleteness: 'complete' as const, chainInventorySourceRef: 'source:product-chain-inventory' }));
  const workflowDefinitions = products.map((product) => ({ workflowId: `${product.productId}:core`, productId: product.productId, chainId: 1, sourceRef: 'source:workflow', requiredCapabilities: [{ capabilityId: CAP_ID, chainId: 1, contract: ADDRESS, signature: 'deposit()', abiHash: ABI_HASH }] }));
  const observations = products.map((product) => ({
    productId: product.productId, chainId: 1, status: 'observed_active' as const, observationRef: `source:${product.productId}`,
    instanceEnumeration: 'complete' as const,
    instances: [{ instanceId: `${product.productId}:deployment`, workflowClaims: [{ workflowId: `${product.productId}:core`, status: 'supported' as const, sourceRef: 'source:claim', admittedCapabilityIds: [CAP_ID] }] }],
    workflowSet: { status: 'complete' as const, sourceRef: 'source:workflow-list', workflowIds: [`${product.productId}:core`] },
  }));
  return {
    capabilities: [capability],
    input: {
      schemaVersion: 1,
      snapshot: { snapshotId: 'fixture:v1', observedAt: '2026-10-04T00:00:00.000Z', captureTimeStatus: 'known', sourceRefs: ['source:universe'], eligibilityRule: { ruleId: 'fixture-rule', description: 'synthetic fixtures only', sourceRefs: ['source:rule'] }, scopeChains: [{ chainId: 1, enumeration: 'complete', sourceRefs: ['source:chain'] }] },
      products, workflowDefinitions, activityMetricDefinitions: [], observations, unresolvedUniverseRecords: [],
    },
  };
}

describe('DeFi market coverage calculator', () => {
  it('computes the 90% observed and conservative target exactly and preserves an unknown workflow in the denominator', () => {
    const state = fixture(10);
    const input: CoverageInput = { ...state.input, observations: state.input.observations.map((row, i) => i === 9 ? { ...row, instances: [{ instanceId: 'missing-coverage', workflowClaims: [{ workflowId: 'product:9:core', status: 'unknown' as const, sourceRef: 'source:unknown', admittedCapabilityIds: [] }] }] } : row) };
    const report = computeCoverage(input, state.capabilities);
    expect(report.products.observedActiveCoverageBps).toBe(9_000);
    expect(report.products.conservativeCoverageBps).toBe(9_000);
    expect(report.objectiveEstablished).toBe(true);
    expect(report.workflowCoverage.completeWorkflows).toBe(9);
  });

  it('uses integer-floor basis points for the 89.99% boundary', () => {
    const state = fixture(10_000);
    const observations = state.input.observations.map((row, i) => i < 8_999 ? row : { ...row, instances: [{ instanceId: `unknown:${i}`, workflowClaims: [{ workflowId: `product:${i}:core`, status: 'unknown' as const, sourceRef: 'source:unknown', admittedCapabilityIds: [] }] }] });
    const report = computeCoverage({ ...state.input, observations }, state.capabilities);
    expect(report.products.observedActiveCoverageBps).toBe(8_999);
    expect(report.products.observedTargetMet).toBe(false);
  });

  it('returns N/A rather than 100% for an empty active denominator', () => {
    const state = fixture();
    const observations: CoverageInput['observations'] = [{ ...state.input.observations[0], status: 'observed_inactive', workflowSet: { status: 'complete', sourceRef: 'source:inactive', workflowIds: ['product:0:core'] }, instances: [] }];
    const report = computeCoverage({ ...state.input, observations }, state.capabilities);
    expect(report.products.observedActiveCoverageBps).toBeNull();
    expect(report.products.conservativeCoverageBps).toBeNull();
    expect(report.objectiveEstablished).toBe(false);
  });

  it('retains unresolved products in conservative coverage and blocks an objective when enumeration is incomplete', () => {
    const state = fixture(2);
    const input: CoverageInput = { ...state.input, snapshot: { ...state.input.snapshot, scopeChains: [{ chainId: 1, enumeration: 'incomplete', sourceRefs: ['source:chain'] }] }, observations: state.input.observations.map((row, i) => i === 1 ? { ...row, status: 'unresolved' as const } : row) };
    const report = computeCoverage(input, state.capabilities);
    expect(report.products.observedActiveCoverageBps).toBe(10_000);
    expect(report.products.conservativeCoverageBps).toBe(5_000);
    expect(report.objectiveEstablished).toBe(false);
  });

  it.each([1, null])('does not treat a source proxy with chain attribution %s as complete identity enumeration', (chainId) => {
    const state = fixture(10);
    const unresolvedUniverseRecords: CoverageInput['unresolvedUniverseRecords'] = [{ sourceRecordRef: `raw:identity:${chainId}`, chainId, reason: 'Unresolved source identity is a proxy, not a verified product' }];
    const report = computeCoverage({ ...state.input, unresolvedUniverseRecords }, state.capabilities);
    expect(report.products.observedActiveCoverageBps).toBe(10_000);
    expect(report.products.conservativeCoverageBps).toBe(9_090);
    expect(report.identityEnumerationComplete).toBe(false);
    expect(report.enumerationComplete).toBe(false);
    expect(report.objectiveEstablished).toBe(false);
  });

  it('allows 90.90% conservative coverage for ten fully supported known products plus one known unresolved canonical product', () => {
    const state = fixture(11);
    const observations = state.input.observations.map((row, index) => index === 10 ? { ...row, status: 'unresolved' as const } : row);
    const report = computeCoverage({ ...state.input, observations }, state.capabilities);
    expect(report.products.activeProducts).toBe(10);
    expect(report.products.unresolvedProducts).toBe(1);
    expect(report.products.conservativeDenominator).toBe(11);
    expect(report.products.observedActiveCoverageBps).toBe(10_000);
    expect(report.products.conservativeCoverageBps).toBe(9_090);
    expect(report.identityEnumerationComplete).toBe(true);
    expect(report.enumerationComplete).toBe(true);
    expect(report.objectiveEstablished).toBe(true);
  });

  it('includes unresolved universe source records in the global conservative denominator', () => {
    const state = fixture(10);
    const unresolvedUniverseRecords = Array.from({ length: 100 }, (_, i) => ({ sourceRecordRef: `raw:unknown:${i}`, chainId: 1, categoryId: 'lending', reason: 'Identity not classified' }));
    const observations = state.input.observations.map((row, i) => i === 9 ? { ...row, instances: [{ instanceId: 'unknown:9', workflowClaims: [{ workflowId: 'product:9:core', status: 'unknown' as const, sourceRef: 'source:unknown', admittedCapabilityIds: [] }] }] } : row);
    const report = computeCoverage({ ...state.input, observations, unresolvedUniverseRecords }, state.capabilities);
    expect(report.products.conservativeDenominator).toBe(110);
    expect(report.products.conservativeCoverageBps).toBe(818);
    expect(report.products.unresolvedUniverseRecords).toBe(100);
    expect(report.objectiveEstablished).toBe(false);
  });

  it('reports 4,778 unattributed unknown records with no active products as N/A observed and 0% conservative', () => {
    const state = fixture();
    const unresolvedUniverseRecords = Array.from({ length: 4_778 }, (_, i) => ({ sourceRecordRef: `raw:unknown:${i}`, chainId: null, reason: 'No canonical product or chain identity' }));
    const input: CoverageInput = { ...state.input, products: [], workflowDefinitions: [], observations: [], unresolvedUniverseRecords };
    const report = computeCoverage(input, []);
    expect(report.products.observedActiveCoverageBps).toBeNull();
    expect(report.products.conservativeCoverageBps).toBe(0);
    expect(report.products.conservativeDenominator).toBe(4_778);
    expect(report.byChain[0].conservativeCoverageBps).toBeNull();
    expect(report.unattributedUnresolvedUniverseRecords).toBe(4_778);
    expect(report.enumerationComplete).toBe(false);
    expect(report.objectiveEstablished).toBe(false);
  });

  it('deduplicates a shared unresolved source record globally while retaining its per-chain attribution', () => {
    const state = fixture();
    const input: CoverageInput = {
      ...state.input,
      products: [], workflowDefinitions: [], observations: [],
      snapshot: { ...state.input.snapshot, scopeChains: [...state.input.snapshot.scopeChains, { chainId: 10, enumeration: 'complete', sourceRefs: ['source:chain10'] }] },
      unresolvedUniverseRecords: [
        { sourceRecordRef: 'raw:shared', chainId: 1, reason: 'Same provider row, chain 1' },
        { sourceRecordRef: 'raw:shared', chainId: 10, reason: 'Same provider row, chain 10' },
      ],
    };
    const report = computeCoverage(input, []);
    expect(report.products.conservativeDenominator).toBe(1);
    expect(report.products.unresolvedUniverseRecords).toBe(1);
    expect(report.unresolvedUniverseRecordRows).toBe(2);
    expect(report.byChain.map((row) => row.unresolvedUniverseRecords)).toEqual([1, 1]);
  });

  it('suppresses category and chain/category conservative ratios when unresolved records lack attribution', () => {
    const state = fixture();
    const report = computeCoverage({ ...state.input, unresolvedUniverseRecords: [{ sourceRecordRef: 'raw:unknown-category', chainId: 1, reason: 'No category classification' }] }, state.capabilities);
    expect(report.byChain[0].conservativeCoverageBps).toBe(5_000);
    expect(report.byCategory[0]).toMatchObject({ conservativeCoverageBps: null, unattributedUnresolvedUniverseRecords: 1 });
    expect(report.byChainCategory[0]).toMatchObject({ conservativeCoverageBps: null, conservativeTargetMet: false });
  });

  it('requires a canonical product to be complete across each observed active or unresolved chain instance', () => {
    const state = fixture();
    const address2 = '0x0000000000000000000000000000000000000002';
    const capability2: CoverageManifestCapability = { ...capability, capabilityId: 'fixture:capability:two', chainId: 10, contract: address2 };
    const secondWorkflow = { ...state.input.workflowDefinitions[0], workflowId: 'product:0:op-core', chainId: 10, requiredCapabilities: [{ capabilityId: capability2.capabilityId, chainId: 10, contract: address2, signature: 'deposit()', abiHash: ABI_HASH }] };
    const secondObservation: CoverageInput['observations'][number] = { ...state.input.observations[0], chainId: 10, status: 'unresolved', observationRef: 'source:op', workflowSet: { status: 'complete', sourceRef: 'source:op-workflows', workflowIds: [secondWorkflow.workflowId] }, instances: [{ instanceId: 'op-deployment', workflowClaims: [{ workflowId: secondWorkflow.workflowId, status: 'supported', sourceRef: 'source:claim', admittedCapabilityIds: [capability2.capabilityId] }] }] };
    const input: CoverageInput = { ...state.input, snapshot: { ...state.input.snapshot, scopeChains: [...state.input.snapshot.scopeChains, { chainId: 10, enumeration: 'complete', sourceRefs: ['source:op-chain'] }] }, products: [{ ...state.input.products[0], expectedScopeChainIds: [1, 10] }], workflowDefinitions: [...state.input.workflowDefinitions, secondWorkflow], observations: [...state.input.observations, secondObservation] };
    const report = computeCoverage(input, [capability, capability2]);
    expect(report.products.activeProducts).toBe(1);
    expect(report.products.unresolvedProducts).toBe(1);
    expect(report.products.conservativeDenominator).toBe(1);
    expect(report.products.fullySupportedActiveProducts).toBe(0);
    expect(report.products.conservativeCoverageBps).toBe(0);
  });

  it('does not mark an observed workflow fully supported when the product-chain inventory is incomplete', () => {
    const state = fixture();
    const input: CoverageInput = { ...state.input, products: [{ ...state.input.products[0], chainInventoryCompleteness: 'incomplete' }] };
    const report = computeCoverage(input, state.capabilities);
    expect(report.products.fullySupportedActiveProducts).toBe(0);
    expect(report.productInventoryCoverage[0].complete).toBe(false);
    expect(report.enumerationComplete).toBe(false);
    expect(report.objectiveEstablished).toBe(false);
  });

  it('rejects an omitted expected chain and an unobserved countable product', () => {
    const state = fixture();
    const omitted: CoverageInput = { ...state.input, snapshot: { ...state.input.snapshot, scopeChains: [...state.input.snapshot.scopeChains, { chainId: 10, enumeration: 'complete', sourceRefs: ['source:chain10'] }] }, products: [{ ...state.input.products[0], expectedScopeChainIds: [1, 10] }] };
    expect(validateCoverageInput(omitted, state.capabilities).some((error) => error.message.includes('has no explicit'))).toBe(true);
    const missing: CoverageInput = { ...state.input, observations: [] };
    expect(validateCoverageInput(missing, state.capabilities).some((error) => error.message.includes('without observations'))).toBe(true);
  });

  it('records unresolved missing-core-workflow definitions and never accepts an empty unresolved workflow as complete', () => {
    const state = fixture();
    const unresolved: CoverageInput['workflowDefinitions'][number] = {
      workflowId: 'product:0:unknown-core', productId: 'product:0', chainId: 1, sourceRef: 'source:workflow-unknown',
      requirementStatus: 'unresolved', unresolvedReason: 'Core workflow target/interface not established', requiredCapabilities: [],
    };
    const observation = { ...state.input.observations[0], workflowSet: { status: 'complete' as const, sourceRef: 'source:workflow-list', workflowIds: [unresolved.workflowId] }, instances: [{ instanceId: 'unknown-target', workflowClaims: [{ workflowId: unresolved.workflowId, status: 'supported' as const, sourceRef: 'source:claim', admittedCapabilityIds: [] }] }] };
    const input: CoverageInput = { ...state.input, workflowDefinitions: [unresolved], observations: [observation] };
    const report = computeCoverage(input, state.capabilities);
    expect(report.products.fullySupportedActiveProducts).toBe(0);
    expect(report.workflowCoverage.rows[0]).toMatchObject({ requirementStatus: 'unresolved', complete: false, unresolvedReason: unresolved.unresolvedReason });
    expect(report.workflowInventory[0]).toMatchObject({ requirementStatus: 'unresolved', requiredCapabilityIds: [], unresolvedReason: unresolved.unresolvedReason });
    const unmarkedEmpty: CoverageInput = { ...input, workflowDefinitions: [{ ...unresolved, requirementStatus: undefined, unresolvedReason: undefined }] };
    expect(validateCoverageInput(unmarkedEmpty, state.capabilities).some((error) => error.message.includes('vacuously complete'))).toBe(true);
  });

  it('keeps unknown capture time null and blocks a current coverage-objective claim', () => {
    const state = fixture();
    const input: CoverageInput = { ...state.input, snapshot: { ...state.input.snapshot, observedAt: null, captureTimeStatus: 'unknown', captureTimeNote: 'Provider supplies no capture timestamp; artifact time is not used.' } };
    const report = computeCoverage(input, state.capabilities);
    expect(report.observedAt).toBeNull();
    expect(report.captureTimeKnown).toBe(false);
    expect(report.captureTimeNote).toContain('artifact time is not used');
    expect(report.observedCohortTargetMet).toBe(true);
    expect(report.objectiveEstablished).toBe(false);
  });

  it('does not trust a supported label when a manifest capability is bound to another target', () => {
    const state = fixture();
    const staleManifest = [{ ...capability, contract: '0x0000000000000000000000000000000000000002' }];
    const report = computeCoverage(state.input, staleManifest);
    expect(report.products.fullySupportedActiveProducts).toBe(0);
    expect(report.workflowCoverage.rows[0].invalidCapabilityIds).toEqual([CAP_ID]);
  });

  it('rejects empty requirements, duplicate product IDs, and counted lineage parents', () => {
    const state = fixture();
    const emptyWorkflow: CoverageInput = { ...state.input, workflowDefinitions: [{ ...state.input.workflowDefinitions[0], requiredCapabilities: [] }] };
    expect(validateCoverageInput(emptyWorkflow, state.capabilities)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'workflowDefinitions[0].requiredCapabilities' })]));
    const duplicate: CoverageInput = { ...state.input, products: [...state.input.products, state.input.products[0]] };
    expect(validateCoverageInput(duplicate, state.capabilities).some((error) => error.message.includes('Duplicate'))).toBe(true);
    const lineage: CoverageInput = { ...state.input, products: [{ ...state.input.products[0], countingRole: 'lineage_only' }] };
    expect(validateCoverageInput(lineage, state.capabilities).some((error) => error.message.includes('cannot be counted'))).toBe(true);
  });

  it('reports chain/category coverage and keeps incompatible weights in separate groups', () => {
    const state = fixture(2);
    const observations: CoverageInput['observations'] = state.input.observations.map((row, i) => ({
      ...row,
      activityMetrics: [i === 0 ? { definitionId: 'dex-volume', value: '1.25', unit: 'USD', window: '30d', sourceRef: 'provider:A' } : { definitionId: 'dex-volume', value: '100', unit: 'USD', window: '7d', sourceRef: 'provider:B' }],
    }));
    const activityMetricDefinitions: CoverageInput['activityMetricDefinitions'] = [
      { chainId: 1, categoryId: 'lending', definitionId: 'dex-volume', unit: 'USD', window: '30d', sourceRef: 'provider:A' },
      { chainId: 1, categoryId: 'lending', definitionId: 'dex-volume', unit: 'USD', window: '7d', sourceRef: 'provider:B' },
    ];
    const report = computeCoverage({ ...state.input, observations, activityMetricDefinitions }, state.capabilities);
    expect(report.byChain[0].activeProducts).toBe(2);
    expect(report.byCategory[0].activeProducts).toBe(2);
    expect(report.byChainCategory[0].activeProducts).toBe(2);
    expect(report.weightedCoverage).toHaveLength(2);
    expect(report.weightedCoverage.map((row) => row.weightedActive)).toEqual(['1.25', '100']);
  });

  it('reports absent activity weights rather than treating them as numeric zero', () => {
    const state = fixture(2);
    const observations = state.input.observations.map((row, i) => i === 0 ? { ...row, activityMetrics: [{ definitionId: 'dex-volume', value: '0', unit: 'USD', window: '30d', sourceRef: 'provider:A' }] } : row);
    const activityMetricDefinitions: CoverageInput['activityMetricDefinitions'] = [{ chainId: 1, categoryId: 'lending', definitionId: 'dex-volume', unit: 'USD', window: '30d', sourceRef: 'provider:A' }];
    const report = computeCoverage({ ...state.input, observations, activityMetricDefinitions }, state.capabilities);
    expect(report.weightedCoverage[0]).toMatchObject({ weightedActive: '0', activeProductsWithoutWeight: 1 });
    expect(report.weightedCoverage[0].observedActiveCoverageBps).toBeNull();
    expect(report.weightedCoverage[0].conservativeCoverageBps).toBeNull();
    expect(report.weightedCoverage[0].targetMet).toBe(false);
  });

  it('keeps different metric families and units separate on the same product and chain', () => {
    const state = fixture();
    const activityMetricDefinitions: CoverageInput['activityMetricDefinitions'] = [
      { chainId: 1, categoryId: 'lending', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
      { chainId: 1, categoryId: 'lending', definitionId: 'fees', unit: 'USD', window: '30d', sourceRef: 'provider' },
      { chainId: 1, categoryId: 'lending', definitionId: 'count', unit: 'transactions', window: '30d', sourceRef: 'provider' },
    ];
    const observations: CoverageInput['observations'] = [{
      ...state.input.observations[0],
      activityMetrics: [
        { definitionId: 'volume', value: '10', unit: 'USD', window: '30d', sourceRef: 'provider' },
        { definitionId: 'fees', value: '2', unit: 'USD', window: '30d', sourceRef: 'provider' },
        { definitionId: 'count', value: '4', unit: 'transactions', window: '30d', sourceRef: 'provider' },
      ],
    }];
    const report = computeCoverage({ ...state.input, observations, activityMetricDefinitions }, state.capabilities);
    expect(report.weightedCoverage.map((row) => [row.definitionId, row.unit, row.weightedActive])).toEqual([['count', 'transactions', '4'], ['fees', 'USD', '2'], ['volume', 'USD', '10']]);
  });

  it('keeps observed weighted coverage but suppresses its conservative claim for an applicable unresolved source proxy', () => {
    const state = fixture();
    const input: CoverageInput = {
      ...state.input,
      activityMetricDefinitions: [{ chainId: 1, categoryId: 'lending', definitionId: 'dex-volume', unit: 'USD', window: '30d', sourceRef: 'provider:A' }],
      observations: [{ ...state.input.observations[0], activityMetrics: [{ definitionId: 'dex-volume', value: '100', unit: 'USD', window: '30d', sourceRef: 'provider:A' }] }],
      unresolvedUniverseRecords: [{ sourceRecordRef: 'raw:proxy', chainId: 1, categoryId: 'lending', reason: 'Unknown identity and unknown metric weight' }],
    };
    const report = computeCoverage(input, state.capabilities);
    expect(report.weightedCoverage[0]).toMatchObject({
      observedActiveCoverageBps: 10_000,
      conservativeCoverageBps: null,
      targetMet: false,
      activeProductsWithWeight: 1,
      eligibleUnresolvedProducts: 0,
      unresolvedProductsWithoutWeight: 0,
      applicableUnresolvedUniverseSourceRecords: 1,
      applicableUnresolvedUniverseSourceRecordRows: 1,
    });
  });

  it('applies source proxies only to attributable chain/category groups and deduplicates a shared source per group', () => {
    const state = fixture();
    const input: CoverageInput = {
      ...state.input,
      snapshot: { ...state.input.snapshot, scopeChains: [...state.input.snapshot.scopeChains, { chainId: 10, enumeration: 'complete', sourceRefs: ['source:chain10'] }] },
      products: [...state.input.products, { ...state.input.products[0], productId: 'lineage:dex', label: 'DEX cohort label', categoryId: 'dex', countingRole: 'lineage_only' as const, expectedScopeChainIds: [] }],
      activityMetricDefinitions: [
        { chainId: 1, categoryId: 'lending', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
        { chainId: 1, categoryId: 'dex', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
        { chainId: 10, categoryId: 'lending', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
      ],
      observations: [{ ...state.input.observations[0], activityMetrics: [{ definitionId: 'volume', value: '100', unit: 'USD', window: '30d', sourceRef: 'provider' }] }],
      unresolvedUniverseRecords: [
        { sourceRecordRef: 'raw:shared', chainId: 1, categoryId: 'lending', reason: 'Known chain and category' },
        { sourceRecordRef: 'raw:shared', chainId: 10, categoryId: 'lending', reason: 'Same source identity also attributed to another chain' },
        { sourceRecordRef: 'raw:distinct', chainId: 1, categoryId: 'lending', reason: 'A second distinct unresolved source row' },
      ],
    };
    const report = computeCoverage(input, state.capabilities);
    const buckets = new Map(report.weightedCoverage.map((row) => [`${row.chainId}:${row.categoryId}`, row]));
    expect(buckets.get('1:lending')?.applicableUnresolvedUniverseSourceRecords).toBe(2);
    expect(buckets.get('1:lending')?.applicableUnresolvedUniverseSourceRecordRows).toBe(2);
    expect(buckets.get('10:lending')?.applicableUnresolvedUniverseSourceRecords).toBe(1);
    expect(buckets.get('1:dex')?.applicableUnresolvedUniverseSourceRecords).toBe(0);
    expect(buckets.get('10:lending')?.applicableUnresolvedUniverseSourceRecordRows).toBe(1);
  });

  it.each([
    [{ sourceRecordRef: 'raw:chain-unknown', chainId: null, categoryId: 'lending', reason: 'Unknown chain only' }, ['1:lending', '10:lending']],
    [{ sourceRecordRef: 'raw:category-unknown', chainId: 1, reason: 'Unknown category only' }, ['1:lending', '1:dex']],
    [{ sourceRecordRef: 'raw:both-unknown', chainId: null, reason: 'Unknown chain and category' }, ['1:lending', '1:dex', '10:lending']],
  ])('applies unattributed proxy dimensions conservatively: %j', (record, applicableGroups) => {
    const state = fixture();
    const input: CoverageInput = {
      ...state.input,
      snapshot: { ...state.input.snapshot, scopeChains: [...state.input.snapshot.scopeChains, { chainId: 10, enumeration: 'complete', sourceRefs: ['source:chain10'] }] },
      products: [...state.input.products, { ...state.input.products[0], productId: 'lineage:dex', label: 'DEX cohort label', categoryId: 'dex', countingRole: 'lineage_only' as const, expectedScopeChainIds: [] }],
      activityMetricDefinitions: [
        { chainId: 1, categoryId: 'lending', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
        { chainId: 1, categoryId: 'dex', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
        { chainId: 10, categoryId: 'lending', definitionId: 'volume', unit: 'USD', window: '30d', sourceRef: 'provider' },
      ],
      observations: [{ ...state.input.observations[0], activityMetrics: [{ definitionId: 'volume', value: '100', unit: 'USD', window: '30d', sourceRef: 'provider' }] }],
      unresolvedUniverseRecords: [record],
    };
    const report = computeCoverage(input, state.capabilities);
    for (const group of applicableGroups as string[]) expect(new Map(report.weightedCoverage.map((row) => [`${row.chainId}:${row.categoryId}`, row])).get(group)?.applicableUnresolvedUniverseSourceRecords).toBe(1);
    for (const group of ['1:lending', '1:dex', '10:lending']) if (!(applicableGroups as string[]).includes(group)) {
      expect(new Map(report.weightedCoverage.map((row) => [`${row.chainId}:${row.categoryId}`, row])).get(group)?.applicableUnresolvedUniverseSourceRecords).toBe(0);
    }
  });

  it('fingerprints normalized evidence and relevant manifest identity deterministically', () => {
    const state = fixture();
    const original = coverageInputFingerprint(state.input, state.capabilities);
    expect(coverageInputFingerprint(state.input, state.capabilities)).toBe(original);
    expect(coverageInputFingerprint({ ...state.input, snapshot: { ...state.input.snapshot, snapshotId: 'fixture:changed' } }, state.capabilities)).not.toBe(original);
    expect(coverageInputFingerprint(state.input, [{ ...capability, abiHash: `0x${'2'.repeat(64)}` }])).not.toBe(original);
  });
});

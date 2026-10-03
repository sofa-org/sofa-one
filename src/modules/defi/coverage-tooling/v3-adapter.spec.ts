import { readFileSync } from 'node:fs';
import { adaptV3Coverage, V3Sources } from './v3-adapter';

const inputs = {
  m1Catalog: 'data/defi-catalog/v1/catalog.json', m2Catalog: 'data/defi-catalog/v2/catalog.json', m2DexSource: 'data/defi-catalog/v2/sources/dex.json',
  v3Catalog: 'data/defi-catalog/v3/catalog.json', workflowExtensions: 'data/defi-catalog/v3/sources/workflow-extensions.json',
  baseInput: 'data/defi-coverage/v2/normalized-input.json', m2CoverageReport: 'data/defi-coverage/v2/coverage-report.json',
  m2NormalizationEvidence: 'data/defi-coverage/v2/normalization-evidence.json', m2IdentityCrosswalk: 'data/defi-coverage/v2/identity-crosswalk.json',
  m2ActivityMethods: 'data/defi-coverage/v2/activity-methods.json', m2WorkflowInventory: 'data/defi-coverage/v2/workflow-inventory.json',
  m2ActivitySnapshot: 'data/defi-coverage/v2/activity-snapshot.json',
} as const;
const loadSources = (): V3Sources => {
  const parsed = Object.fromEntries(Object.entries(inputs).map(([key, path]) => [key, JSON.parse(readFileSync(path, 'utf8'))])) as Record<string, any>;
  return { ...parsed, sourceDigests: Object.fromEntries(Object.values(inputs).map((path) => [path, `sha256:${path}`])), frozenEvidence: {
    m2CoverageReport: parsed.m2CoverageReport, m2NormalizationEvidence: parsed.m2NormalizationEvidence,
    m2IdentityCrosswalk: parsed.m2IdentityCrosswalk, m2ActivityMethods: parsed.m2ActivityMethods,
    workflowInventory: parsed.m2WorkflowInventory, activitySnapshot: parsed.m2ActivitySnapshot,
  } } as unknown as V3Sources;
};

describe('v3 workflow-scope coverage projection', () => {
  it('binds nine target-specific bundles without changing M2 authority or the frozen market denominator', () => {
    const sources = loadSources();
    const original = JSON.stringify(sources.baseInput);
    const result = adaptV3Coverage(sources);
    expect(result.workflowInventory.m2Authority).toMatchObject({ capabilityCount: 315, preservedCapabilities: 315, addedCapabilityCount: 34 });
    expect(result.workflowInventory.summary).toMatchObject({ npmBundles: 7, morphoLineageOnlyBundles: 2, targetScopedWorkflowBundles: 9, distinctNewFunctionBindings: 34, newNpmFunctionBindings: 28, newMorphoFunctionBindings: 6, scopeBindings: 13, requiredCapabilityReferences: 69, duplicateNpmSourceRowsPreserved: 35, rawRosterRowsPreserved: 8476, unresolvedRawRosterRowsPreserved: 8472, morphoRaw4025PromotedToCanonicalProduct: false, wholeProductCompletenessEstablished: false, marketActivityChanged: false });
    expect(result.input.workflowDefinitions).toHaveLength(sources.baseInput.workflowDefinitions.length + 9);
    expect(result.input.unresolvedUniverseRecords).toEqual(sources.baseInput.unresolvedUniverseRecords);
    expect(result.input.snapshot.observedAt).toBe('2026-10-03T19:11:22Z');
    expect(result.input.snapshot.captureTimeStatus).toBe('known');
    expect(sources.baseInput.unresolvedUniverseRecords).toHaveLength(8472);
    expect(JSON.stringify(sources.baseInput)).toBe(original);
    expect(result.workflowInventory.scopedWorkflowBundles.filter((row: any) => row.family === 'uniswap-v3-position-manager')).toHaveLength(7);
    expect(result.workflowInventory.scopedWorkflowBundles.filter((row: any) => row.identityMapping.status === 'lineage-only-unverified-market-crosswalk')).toHaveLength(2);
    expect(result.workflowInventory.scopedWorkflowBundles.every((row: any) => row.completionScope.includes('not') || row.family === 'morpho-blue')).toBe(true);
  });

  it('rejects missing, changed, nonempty, or wrong-index scope before coverage projection', () => {
    const source = loadSources();
    const catalog = structuredClone(source.v3Catalog);
    const scoped = catalog.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions.map((fn: any) => ({ chain, contract, fn })))).find((row: any) => row.fn.executionScope?.kind === 'same-target-multicall-v1');
    expect(scoped).toBeDefined();
    const missingChild = structuredClone(catalog);
    const childScope = missingChild.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions)).find((fn: any) => fn.executionScope?.kind === 'same-target-multicall-v1');
    childScope.executionScope.allowedChildren.pop();
    expect(() => adaptV3Coverage({ ...source, v3Catalog: missingChild })).toThrow();
    const changedHash = structuredClone(catalog);
    const changedWrapper = changedHash.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions)).find((fn: any) => fn.executionScope?.kind === 'same-target-multicall-v1');
    changedWrapper.executionScope.allowedChildren[0].abiHash = `0x${'0'.repeat(64)}`;
    expect(() => adaptV3Coverage({ ...source, v3Catalog: changedHash })).toThrow();
    const missingScope = structuredClone(catalog);
    const callback = missingScope.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions)).find((fn: any) => fn.executionScope?.kind === 'empty-callback-data-v1');
    delete callback.executionScope;
    expect(() => adaptV3Coverage({ ...source, v3Catalog: missingScope })).toThrow();
    const wrongCallbackIndex = structuredClone(catalog);
    const callback2 = wrongCallbackIndex.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions)).find((fn: any) => fn.executionScope?.kind === 'empty-callback-data-v1' && fn.functionName === 'supplyCollateral');
    callback2.executionScope.bytesArgIndex = 4;
    expect(() => adaptV3Coverage({ ...source, v3Catalog: wrongCallbackIndex })).toThrow();
  });

  it('rejects target drift, empty function requirements, and attempts to infer the Compound V2 fee method as activity', () => {
    const source = loadSources();
    const targetDrift = structuredClone(source.v3Catalog);
    const wrapper = targetDrift.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions.map((fn: any) => ({ contract, fn })))).find((row: any) => row.fn.executionScope?.kind === 'same-target-multicall-v1');
    wrapper.contract.address = '0x9999999999999999999999999999999999999999';
    expect(() => adaptV3Coverage({ ...source, v3Catalog: targetDrift })).toThrow();
    expect((source.frozenEvidence.m2ActivityMethods as any).methods.find((method: any) => method.sourceIds.includes('114'))).toMatchObject({ methodId: 'compound-v2-borrow-interest-fees-unqualified-v1', qualifiesAsUserActivity: false });
    expect(() => adaptV3Coverage({ ...source, frozenEvidence: { ...source.frozenEvidence, m2ActivityMethods: { methods: [] } } })).toThrow();
  });
});

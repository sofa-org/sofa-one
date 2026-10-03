import type { CoverageInput, CoverageManifestCapability } from './types';
import { createHash } from 'node:crypto';

const CHAINS = [
  { id: 1, key: 'ethereum', name: 'Ethereum' },
  { id: 8453, key: 'base', name: 'Base' },
  { id: 42161, key: 'arbitrum', name: 'Arbitrum' },
  { id: 10, key: 'optimism', name: 'OP Mainnet' },
  { id: 137, key: 'polygon', name: 'Polygon' },
  { id: 56, key: 'bsc', name: 'BSC' },
  { id: 143, key: 'monad', name: 'Monad' },
] as const;

type JsonObject = Record<string, any>;

export type BaselineSources = Readonly<{
  market: JsonObject;
  classification: JsonObject;
  workflows: JsonObject;
  manifest: readonly CoverageManifestCapability[];
  manifestHash: string;
  sourceRosterCanonicalSha256: string;
  sourceFileDigests: Readonly<Record<string, string>>;
}>;

export function adaptFrozenBaseline(source: BaselineSources): { input: CoverageInput; evidence: JsonObject } {
  const { market, classification, workflows, manifest, manifestHash, sourceRosterCanonicalSha256, sourceFileDigests } = source;
  const roster = market.protocolUniverse as JsonObject[];
  const rawMetricRows = market.observedMetricRows as JsonObject[];
  const frozen = classification.frozenRoster;
  if (!Array.isArray(roster) || roster.length !== 8_476 || frozen.sourceResponseRecordCount !== roster.length
    || market.sourceReferences?.protocols?.sha256 !== frozen.sourceResponseCanonicalJsonSha256
    || frozen.protocolUniverseCanonicalJsonSha256 !== '7fc3a4de44a3eebc1354aa57736cb72b48b21321c766d3c9a31e9eeea47c9b24'
    || sourceRosterCanonicalSha256 !== frozen.protocolUniverseCanonicalJsonSha256) {
    throw new Error('Frozen market roster count or provider-response hash does not match discovery classification');
  }
  if (workflows.products?.length !== 16 || manifest.length === 0 || workflows.snapshot?.baselineManifestHash !== manifestHash) throw new Error('Workflow seed or reviewed manifest identity is incomplete or mismatched');

  const definitions: any[] = [];
  const products: any[] = [];
  const observations: any[] = [];
  const unmatchedRequirements: JsonObject[] = [];
  let unknownChainWorkflowInstances = 0;
  let assignedWorkflowInstances = 0;
  let exactManifestBindings = 0;
  const sourceTargetInstances = (workflows.products as JsonObject[]).flatMap((product) => product.targetInstances as JsonObject[]);
  const unassignedTargetRows = workflows.unassignedObservedCatalogTargets as JsonObject[];

  for (const seed of workflows.products as JsonObject[]) {
    const productId = `workflow-seed:${seed.productSeedId ?? seed.rawMarketSlug}`;
    const inventoryRef = `workflow-baseline:${seed.productSeedId ?? seed.rawMarketSlug}`;
    const knownInstances = (seed.targetInstances as JsonObject[]).filter((instance) => Number.isSafeInteger(instance.chainId) && instance.chainId > 0);
    unknownChainWorkflowInstances += (seed.targetInstances as JsonObject[]).length - knownInstances.length;
    const chainIds = [...new Set(knownInstances.map((instance) => instance.chainId as number))].sort((a, b) => a - b);
    products.push({
      productId,
      label: `${seed.parentFamily ?? seed.rawMarketSlug} ${seed.productVersion ?? ''}`.trim(),
      categoryId: 'workflow-seed-candidate',
      countingRole: 'lineage_only',
      expectedScopeChainIds: chainIds,
      chainInventoryCompleteness: 'incomplete',
      chainInventorySourceRef: inventoryRef,
    });

    for (const chainId of chainIds) {
      const chainInstances = knownInstances.filter((instance) => instance.chainId === chainId);
      const sourceWorkflowIds = [...new Set(chainInstances.flatMap((instance) => instance.workflowIds ?? []))].sort();
      const claims: any[] = [];
      for (const sourceWorkflowId of sourceWorkflowIds) {
        const workflow = (seed.ordinaryCoreWorkflows as JsonObject[]).find((candidate) => candidate.workflowId === sourceWorkflowId);
        if (!workflow) continue;
        const workflowId = `wf:${stablePart(`${productId}:${chainId}:${sourceWorkflowId}`)}:${sourceWorkflowId.replace(/[^A-Za-z0-9:._/-]/g, '-')}`;
        const requiredFunctions = Array.isArray(workflow.requiredFunctions) ? workflow.requiredFunctions as JsonObject[] : [];
        const requiredById = new Map<string, any>();
        let requirementsResolved = workflow.requirementStatus !== 'unknown' && requiredFunctions.length > 0;
        for (const instance of chainInstances.filter((row) => (row.workflowIds ?? []).includes(sourceWorkflowId))) {
          const target = typeof instance.targetAddress === 'string' ? instance.targetAddress.toLowerCase() : null;
          const bindings = Object.values(instance.workflowFunctionCoverage?.[sourceWorkflowId]?.presentFunctionBindings ?? {}) as JsonObject[];
          for (const fn of requiredFunctions) {
            const signature = typeof fn.signature === 'string' ? fn.signature : null;
            const binding = signature && bindings.find((candidate) => candidate.signature === signature && candidate.chainId === chainId && candidate.targetAddress?.toLowerCase() === target);
            const exact = binding && target && manifest.find((capability) => capability.status === 'active' && capability.type === 'contract_call'
              && capability.capabilityId === binding.capabilityId && capability.chainId === chainId
              && capability.contract.toLowerCase() === target && capability.signature === binding.signature
              && capability.abiHash === binding.abiHash && capability.provenance.status === 'verified');
            if (exact) requiredById.set(exact.capabilityId, { capabilityId: exact.capabilityId, chainId, contract: exact.contract.toLowerCase(), signature: exact.signature, abiHash: exact.abiHash });
            else {
              requirementsResolved = false;
              unmatchedRequirements.push({ productId, instanceId: instance.instanceId, workflowId, functionName: fn.name ?? null, signature, reason: signature ? 'No exact active verified manifest binding at the independently recorded target' : 'Source seed records no fixed signature' });
            }
          }
        }
        exactManifestBindings += requiredById.size;
        const required = [...requiredById.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
        const sourceRefs = Array.isArray(workflow.sourceRefs) ? workflow.sourceRefs : [];
        definitions.push({
          workflowId, productId, chainId,
          sourceRef: sourceRefs.join(' | ') || `workflow-baseline:${sourceWorkflowId}`,
          requirementStatus: requirementsResolved ? 'resolved' : 'unresolved',
          ...(!requirementsResolved ? { unresolvedReason: workflow.unresolvedRequirementNote ?? 'One or more exact target/signature/manifest bindings remain unresolved' } : {}),
          requiredCapabilities: required,
        });
        claims.push({ workflowId, status: requirementsResolved && required.length ? 'supported' : 'source_blocked', sourceRef: `workflow-baseline:${productId}:${chainId}:${sourceWorkflowId}`, admittedCapabilityIds: required.map((row) => row.capabilityId) });
        assignedWorkflowInstances += chainInstances.filter((instance) => (instance.workflowIds ?? []).includes(sourceWorkflowId)).length;
      }
      const observationRef = `workflow-baseline:${productId}:${chainId}`;
      const chainWorkflowIds = definitions.filter((row) => row.productId === productId && row.chainId === chainId).map((row) => row.workflowId);
      if (chainWorkflowIds.length) observations.push({ productId, chainId, status: 'unresolved', observationRef, instanceEnumeration: 'incomplete', instances: [{ instanceId: `chain-${chainId}-workflow-seed`, workflowClaims: claims }], workflowSet: { status: 'incomplete', sourceRef: observationRef, workflowIds: chainWorkflowIds } });
    }
  }

  const metricCategoryCounts: JsonObject = {};
  for (const row of rawMetricRows) {
    for (const [chainKey, metrics] of Object.entries(row.byChain ?? {})) {
      for (const [category, values] of Object.entries(metrics as JsonObject)) {
        const key = `${chainKey}:${category}`;
        metricCategoryCounts[key] = (metricCategoryCounts[key] ?? 0) + 1;
      }
    }
  }
  const marketRef = `market-snapshot.json#sha256=${sourceFileDigests['data/defi-coverage/market-snapshot.json']}`;
  const workflowRef = `workflow-baseline.json#sha256=${sourceFileDigests['data/defi-coverage/workflow-baseline.json']}`;
  const classificationRef = `discovery-classification.json#sha256=${sourceFileDigests['data/defi-coverage/discovery-classification.json']}`;
  const input: CoverageInput = {
    schemaVersion: 1,
    snapshot: {
      snapshotId: classification.classificationId,
      observedAt: null,
      captureTimeStatus: 'unknown',
      captureTimeNote: market.snapshotCaptureTimeEvidence,
      sourceRefs: [marketRef, classificationRef, workflowRef],
      eligibilityRule: {
        ruleId: 'frozen-seven-chain-90-day-evidence-reconciliation-v1',
        description: 'Only positively evidenced canonical product and chain activity with category-compatible dated evidence may be observed active; unavailable identity, chain, category, window, or capture time remains unresolved.',
        sourceRefs: [classificationRef, marketRef],
      },
      scopeChains: CHAINS.map((chain) => ({ chainId: chain.id, enumeration: 'incomplete' as const, sourceRefs: [marketRef, classificationRef] })),
    },
    products,
    workflowDefinitions: definitions,
    activityMetricDefinitions: [],
    observations,
    // Each immutable raw roster record is one countable source row only for the conservative proxy denominator.
    // Null chain attribution prevents optimistic per-chain ratios; this does not assert 8,476 unique products.
    unresolvedUniverseRecords: roster.map((record) => ({
      sourceRecordRef: `protocol-roster:${String(record.id)}:${String(record.slug)}`,
      chainId: null,
      reason: 'Raw DeFiLlama roster row has no reconciled canonical product identity, complete in-scope chain attribution, category-compatible 90-day activity, and capture-time evidence.',
    })),
  };
  const evidence = {
    schemaVersion: 1,
    classificationId: classification.classificationId,
    sourceFileDigests,
    marketSnapshotLimitations: market.limitations,
    marketFetchErrors: market.fetchErrors,
    classificationRules: classification.classificationRules,
    roster: {
      sourceRecordCount: roster.length,
      canonicalJsonSha256: frozen.protocolUniverseCanonicalJsonSha256,
      providerResponseSha256: frozen.sourceResponseCanonicalJsonSha256,
      sourceRosterRecords: roster,
      distinctSourceRecordReferences: input.unresolvedUniverseRecords.length,
      unresolvedConservativeProxyCount: input.unresolvedUniverseRecords.length,
      claimLimit: 'These are unresolved source rows, not verified unique protocol/product count. They are counted once per frozen roster row globally; null chain attribution prevents per-chain conservative ratios.',
      classifications: classification.observations.scopeChainClassificationOfRosterRows,
      explicitOutsideScopeExclusions: 0,
      note: 'No rows were excluded merely because a target chain was not listed. 3,698 rows with no target-chain evidence and 1,281 with unknown chain identity remain in the unresolved roster proxy.',
    },
    metrics: {
      sourceRows: rawMetricRows.length,
      sourceMetricRows: rawMetricRows,
      distinctSourceMetricIds: classification.observations.distinctSourceMetricIds,
      metricIdsMatchingRosterByStringId: classification.observations.metricIdsMatchingRosterByStringId,
      unmatchedMetricIds: classification.observations.metricIdsNotMatchedToRoster,
      positive30DayMetricRows: classification.observations.positiveObserved30DayMetricRows,
      zero30DayMetricRows: classification.observations.numericZeroObserved30DayMetricRows,
      categoriesByChainRowCounts: metricCategoryCounts,
      projection: 'No market metric is attached to a canonical product or used as an activity weight: exact source product attribution/category-compatible 90-day basis and capture time are not available. Values remain preserved in the frozen market snapshot.',
    },
    workflowProjection: {
      reviewedManifestHash: manifestHash,
      sourceProductSeeds: workflows.products.length,
      sourceWorkflowDefinitions: workflows.products.reduce((count: number, product: JsonObject) => count + product.ordinaryCoreWorkflows.length, 0),
      sourceTargetInstanceRows: sourceTargetInstances.length,
      exactAddressTargets: sourceTargetInstances.filter((instance) => typeof instance.targetAddress === 'string').length,
      unknownTargetRows: sourceTargetInstances.filter((instance) => typeof instance.targetAddress !== 'string').length,
      projectedWorkflowInstanceRows: assignedWorkflowInstances,
      exactCatalogFunctionBindingsInSeed: countBindings(sourceTargetInstances),
      exactManifestBindingsProjected: exactManifestBindings,
      unassignedTargetCount: unassignedTargetRows.length,
      unassignedExactFunctionBindings: countBindings(unassignedTargetRows),
      unknownChainTargetInstances: unknownChainWorkflowInstances,
      projectedWorkflowDefinitions: definitions.length,
      unresolvedRequirementRows: unmatchedRequirements.length,
      unmatchedRequirements,
      unassignedObservedTargets: workflows.unassignedObservedCatalogTargets,
      sourceWorkflowSeedInventory: (workflows.products as JsonObject[]).map((seed) => ({
        productSeedId: seed.productSeedId ?? null,
        rawMarketSlug: seed.rawMarketSlug,
        rawMarketMappingStatus: seed.rawMarketMappingStatus,
        rawMarketCandidateRefs: seed.rawMarketCandidateRefs,
        parentFamily: seed.parentFamily ?? null,
        productVersion: seed.productVersion ?? null,
        ordinaryCoreWorkflows: seed.ordinaryCoreWorkflows,
        targetInstances: seed.targetInstances,
      })),
      catalogBindingMethod: 'Only the workflow seed presentFunctionBindings exact capability ID + chain + lowercase target + signature + ABI hash were compared against active verified capabilities in the reviewed manifest. No name-only inference or cross-version target association is performed.',
      denominatorRole: 'Workflow seeds are lineage-only and do not add to the raw market denominator; ambiguous and unresolved market identity mappings are not canonicalized.',
    },
    captureTime: {
      observedAt: null,
      status: 'unknown',
      marketSnapshotLocalDate: market.snapshotLocalReportedDate,
      workflowSeedLocalDate: workflows.snapshot?.localReportedDate ?? null,
      artifactExistenceUpperBound: '2026-10-03T16:59:58Z (not capture time)',
      limitation: market.snapshotCaptureTimeEvidence,
    },
    objective: { established: false, reason: 'Frozen roster identity/chain/activity population and snapshot capture time are unresolved; no percentage can establish the requested live-population objective.' },
  };
  return { input, evidence };
}

function stablePart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

/** Hashes the frozen array's compact JSON lexemes without lossy JS number reformatting. */
export function compactJsonPropertyHash(sourceText: string, property: string): string {
  const keyIndex = sourceText.indexOf(`"${property}"`);
  if (keyIndex < 0) throw new Error(`Missing JSON property ${property}`);
  const colon = sourceText.indexOf(':', keyIndex + property.length + 2);
  let start = colon + 1;
  while (/\s/.test(sourceText[start] ?? '')) start++;
  if (sourceText[start] !== '[') throw new Error(`JSON property ${property} is not an array`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < sourceText.length; index++) {
    const char = sourceText[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0) throw new Error(`Unterminated JSON array ${property}`);
  const value = sourceText.slice(start, end);
  let compact = '';
  inString = false;
  escaped = false;
  for (const char of value) {
    if (inString) {
      compact += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') { compact += char; inString = true; }
    else if (!/\s/.test(char)) compact += char;
  }
  return createHash('sha256').update(compact, 'utf8').digest('hex');
}

function countBindings(instances: readonly JsonObject[]): number {
  return instances.reduce((total, instance) => total + (Object.values(instance.workflowFunctionCoverage ?? {}) as JsonObject[])
    .reduce((perInstance, coverage) => perInstance + (coverage.presentFunctionBindings?.length ?? 0), 0), 0);
}

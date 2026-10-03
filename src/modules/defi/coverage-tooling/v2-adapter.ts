import { createHash } from 'node:crypto';
import type { CoverageInput, CoverageManifestCapability } from './types';
import { functionAbiHash } from '../registry/defi-manifest';

type Json = Record<string, any>;
const CHAINS = [{ id: 1, key: 'ethereum' }, { id: 8453, key: 'base' }, { id: 42161, key: 'arbitrum' }, { id: 10, key: 'optimism' }, { id: 137, key: 'polygon' }, { id: 56, key: 'bsc' }, { id: 143, key: 'monad' }] as const;
const HASH = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

export type V2AdapterSources = Readonly<{ market: Json; activity: Json; crosswalk: Json; methods: Json; workflows: Json; catalog: Json; catalogSource: Json }>;
export type V2Projection = Readonly<{ input: CoverageInput; evidence: Json }>;

/** Offline projection only. Raw provider IDs are not canonicalized by name/slug/parent/linked labels. */
export function adaptV2Sources(source: V2AdapterSources): V2Projection {
  const { market, activity, crosswalk, methods, workflows, catalog, catalogSource } = source;
  const raw = market.protocolUniverse as Json[];
  if (raw.length !== 8476 || activity.sourceUniverse?.m1ProtocolUniverseCanonicalJsonSha256 !== crosswalk.m1UniverseCanonicalJsonSha256) throw new Error('V2 source universe identity mismatch');
  if (activity.captureTimestampUtc !== '2026-10-03T19:11:22Z') throw new Error('Unexpected v2 activity capture timestamp');
  const refs = new Map(raw.map((row) => [String(row.id), row]));
  const ledger = crosswalk.ledger as Json[];
  if (!Array.isArray(ledger) || ledger.length !== raw.length || crosswalk.ledgerRecordCount !== raw.length) throw new Error('V2 identity ledger must preserve every frozen M1 roster row');
  ledger.forEach((row, index) => {
    if (String(row.sourceId) !== String(raw[index].id)) throw new Error(`Identity ledger order/ID mismatch at frozen roster row ${index}`);
  });
  const rows = new Map((activity.sourceIdMetricRows as Json[]).map((row) => [String(row.sourceId), row]));
  const mappings = crosswalk.mappings as Json[];
  if (new Set(mappings.map((row) => String(row.sourceId))).size !== mappings.length) throw new Error('Duplicate raw source ID in identity crosswalk');
  for (const mapping of mappings) if (!refs.has(String(mapping.sourceId))) throw new Error(`Crosswalk source ID is not in frozen M1 roster: ${mapping.sourceId}`);
  const bySourceId = new Map(mappings.map((m) => [String(m.sourceId), m]));
  const sourceRefs = [
    'data/defi-coverage/market-snapshot.json#protocolUniverse sha256=7fc3a4de44a3eebc1354aa57736cb72b48b21321c766d3c9a31e9eeea47c9b24',
    'data/defi-coverage/v2/activity-snapshot.json#sha256=' + HASH(activity),
    'data/defi-coverage/v2/identity-crosswalk.json#sha256=' + HASH(crosswalk),
    'data/defi-coverage/v2/activity-methods.json#sha256=' + HASH(methods),
    'data/defi-coverage/v2/workflow-inventory.json#sha256=' + HASH(workflows),
    'data/defi-catalog/v2/catalog.json#sha256=' + HASH(catalog),
    'data/defi-catalog/v2/sources/dex.json#sha256=' + HASH(catalogSource),
  ];
  const capabilities = buildV2Manifest(catalog, catalogSource);
  const sourceAbis = new Map<string, any>();
  for (const family of catalogSource.families ?? []) for (const contract of family.contracts ?? []) for (const abi of contract.abiFunctions ?? []) {
    const key = `${family.familyId}:${abi.name}`;
    const hash = functionAbiHash({ abi } as any);
    const prior = sourceAbis.get(key);
    if (prior && prior !== hash) throw new Error(`Source ABI differs across ${family.familyId} deployment records for ${abi.name}`);
    sourceAbis.set(key, hash);
  }
  const products: any[] = [], observations: any[] = [], workflowDefinitions: any[] = [], activityMetricDefinitions: any[] = [], unresolvedUniverseRecords: any[] = [];
  const productIds = new Set<string>();
  const workflowRows = workflows.products as Json[];
  const workflowBySource = new Map(workflowRows.map((w) => [String(w.sourceId), w]));
  const metricDefinitionsSeen = new Set<string>();
  const chainEvidence = sourceRefs;
  for (const mapping of mappings) {
    const sourceId = String(mapping.sourceId);
    const sourceRow = refs.get(sourceId);
    if (!sourceRow) throw new Error(`Crosswalk source ID is not in frozen M1 roster: ${sourceId}`);
    if (!['canonical', 'partial'].includes(mapping.identityStatus)) throw new Error(`Unsupported identity disposition ${mapping.identityStatus}`);
    const canonicalProduct = mapping.identityStatus === 'canonical';
    if (!canonicalProduct) continue;
    const productId = `raw-provider:${sourceId}`;
    if (canonicalProduct && productIds.has(productId)) throw new Error(`Duplicate canonical provider identity ${sourceId}`);
    productIds.add(productId);
    const inventory = mapping.expectedChains as number[];
    products.push({ productId, label: mapping.productLabel, categoryId: mapping.categoryId, countingRole: 'coverage_unit', expectedScopeChainIds: inventory, chainInventoryCompleteness: mapping.chainInventoryCompleteness, chainInventorySourceRef: mapping.identityEvidenceRef });
    const sourceMetric = rows.get(sourceId);
    const productWorkflows = workflowBySource.get(sourceId);
    const sourceFamily = sourceId === '2198' ? 'uniswap-v3-position-manager' : sourceId === '2611' ? 'balancer-v2-vault' : null;
    if (sourceFamily) {
      const family = (catalogSource.families as Json[]).find((candidate) => candidate.familyId === sourceFamily);
      if (!family) throw new Error(`Required reviewed source family is absent: ${sourceFamily}`);
      for (const [chainText, target] of Object.entries(mapping.targets ?? {})) {
        const targetRow = (family.contracts as Json[]).find((contract) => contract.chainId === Number(chainText));
        if (!targetRow || targetRow.address.toLowerCase() !== String(target).toLowerCase()) throw new Error(`Crosswalk target mismatch for ${sourceFamily} chain ${chainText}`);
      }
    }
    for (const chainId of inventory) {
      const chain = CHAINS.find((candidate) => candidate.id === chainId)!;
      const metric = sourceMetric?.metricsByChain?.[chain.key]?.dexs;
      const method = methods.methods.find((candidate: Json) => candidate.sourceIds?.includes(sourceId) && candidate.chainIds?.includes(chainId));
      const methodObservation = sourceMetric?.metricsByChain?.[chain.key]?.[method?.providerMetric];
      const selectedActivity = method?.providerMetric === 'dexs' ? metric : methodObservation;
      const methodQualified = method?.qualifiesAsUserActivity === true
        && method.methodId === 'dex-volume-30d-positive-occurrence-v1'
        && method.providerMetric === 'dexs'
        && selectedActivity?.activityEvidenceStatus === 'positive_observation_within_90d_window';
      const observedPositive = selectedActivity && Number(selectedActivity.valueUsd) > 0 && methodQualified;
      const status = canonicalProduct && observedPositive ? 'observed_active' : 'unresolved';
      const workflowsOnChain = (productWorkflows?.workflows ?? []).filter((wf: Json) => wf.chainIds.includes(chainId));
      const workflowIds: string[] = [];
      const claims: any[] = [];
      for (const wf of workflowsOnChain) {
        const workflowId = `${productId}:chain-${chainId}:${wf.workflowId}`;
        workflowIds.push(workflowId);
        // Incomplete/missing exact source-to-catalog binding remains unresolved, never vacuously complete.
        const matched = resolveRequired(wf, chainId, mapping.targets?.[String(chainId)], capabilities, sourceFamily ? (signature: string) => sourceAbis.get(`${sourceFamily}:${signature.slice(0, signature.indexOf('('))}`) : null);
        workflowDefinitions.push({ workflowId, productId, chainId, sourceRef: wf.sourceRef, requirementStatus: matched.length && wf.status === 'resolved' ? 'resolved' : 'unresolved', ...(matched.length && wf.status === 'resolved' ? {} : { unresolvedReason: wf.unresolvedReason ?? 'Exact fixed source requirement is not bound to an active, verified catalog capability at the independently recorded target.' }), requiredCapabilities: matched });
        claims.push({ workflowId, status: matched.length && wf.status === 'resolved' ? 'supported' : 'source_blocked', sourceRef: wf.sourceRef, admittedCapabilityIds: matched.map((required: any) => required.capabilityId) });
      }
      const metricDefinition = selectedActivity && observedPositive ? { chainId, categoryId: mapping.categoryId, definitionId: method.methodId, unit: method.unit, window: method.window, sourceRef: `activity:${sourceId}:${chain.key}:${method.providerMetric}` } : null;
      const activityMetrics: any[] = [];
      if (metricDefinition && metricDefinition) {
        const key = JSON.stringify(metricDefinition);
        if (!metricDefinitionsSeen.has(key)) { activityMetricDefinitions.push(metricDefinition); metricDefinitionsSeen.add(key); }
        activityMetrics.push({ definitionId: metricDefinition.definitionId, value: String(selectedActivity.valueUsd), unit: metricDefinition.unit, window: metricDefinition.window, sourceRef: metricDefinition.sourceRef });
      }
      observations.push({ productId, chainId, status, observationRef: mapping.identityEvidenceRef, instanceEnumeration: 'incomplete', instances: [{ instanceId: `${productId}:${chainId}:population-unknown`, workflowClaims: claims }], workflowSet: { status: 'incomplete', sourceRef: productWorkflows?.sourceRef ?? mapping.identityEvidenceRef, workflowIds }, ...(activityMetrics.length ? { activityMetrics } : {}) });
    }
  }
  const mapped = new Set(mappings.filter((m) => m.identityStatus === 'canonical').map((m) => String(m.sourceId)));
  for (const row of raw) if (!mapped.has(String(row.id))) unresolvedUniverseRecords.push({ sourceRecordRef: `protocol-roster:${String(row.id)}`, chainId: null, reason: bySourceId.has(String(row.id)) ? 'Identity is only partially bridged or retained as a source alias; source-row proxy remains.' : 'No independent exact provider-ID, adapter/version, and product correspondence; retained as an unresolved source-row proxy.' });
  const chains = CHAINS.map(({ id }) => ({ chainId: id, enumeration: 'incomplete' as const, sourceRefs: chainEvidence }));
  const input: CoverageInput = { schemaVersion: 1, snapshot: { snapshotId: activity.snapshotId, observedAt: activity.captureTimestampUtc, captureTimeStatus: 'known', sourceRefs, eligibilityRule: { ruleId: 'm2-exact-provider-row-30d-occurrence-v1', description: 'A positive category-compatible 30-day DEX volume observation proves an occurrence within its enclosing 90-day activity window, not a 90-day total. Zero, missing, fees-only, and unknown identity rows are not inactive.', sourceRefs }, scopeChains: chains }, products, workflowDefinitions, activityMetricDefinitions, observations, unresolvedUniverseRecords };
  return { input, evidence: { schemaVersion: 1, snapshotId: activity.snapshotId, captureTimestampUtc: activity.captureTimestampUtc, m1UniverseSha256: crosswalk.m1UniverseCanonicalJsonSha256, rawRosterRecords: raw.length, sourceMetricRows: activity.sourceIdMetricRows.length, unmatchedMetricIds: activity.metricSourceIdsUnmatchedM1Universe, sourceFileDigests: { market: HASH(market), activity: HASH(activity), identityCrosswalk: HASH(crosswalk), activityMethods: HASH(methods), workflowInventory: HASH(workflows), catalog: HASH(catalog), catalogSource: HASH(catalogSource) }, identityLedger: crosswalk.ledger, activityMethods: methods, catalogFunctionCount: capabilities.length, projectionLimits: ['Source IDs/names/slugs/parent/linked labels alone do not establish product identity.', 'Source-universe unknown rows remain conservative proxies; partial identities are not removed.', 'No runtime, liquidity, funded execution, or complete instance enumeration is established.'] } };
}

export function buildV2Manifest(catalog: Json, sources: Json): CoverageManifestCapability[] {
  const sourceIds = new Set((sources.sources as Json[]).map((row) => row.sourceId));
  const result: CoverageManifestCapability[] = [];
  for (const chain of catalog.chains ?? []) for (const contract of chain.contracts ?? []) for (const fn of contract.functions ?? []) {
    if (fn.status !== 'active' || contract.status !== 'active' || chain.status !== 'active' || fn.type !== 'contract_call') continue;
    const refs = [fn.provenance?.sourceRef, ...(fn.sourceRefs ?? [])].filter((v): v is string => typeof v === 'string');
    const id = refs.find((ref) => [...sourceIds].some((sourceId) => ref.includes(sourceId))) ?? refs[0];
    if (!id) continue;
    // Catalog source admission remains distinct from the v2 protocol/workflow crosswalk.
    result.push({ capabilityId: fn.capabilityId, status: 'active', type: 'contract_call', chainId: fn.chainId, contract: fn.contract, signature: fn.signature, abiHash: functionAbiHash({ abi: fn.abi }), provenance: { status: 'verified', sourceRef: id, verifiedAt: fn.provenance?.verifiedAt ?? '2026-10-03' } });
  }
  return result;
}

function resolveRequired(workflow: Json, chainId: number, target: string | undefined, capabilities: readonly CoverageManifestCapability[], expectedHash: ((signature: string) => string | null) | null): any[] {
  if (!target || !Array.isArray(workflow.signatures) || !workflow.signatures.length) return [];
  const selected = workflow.signatures.map((signature: string) => {
    const abiHash = expectedHash?.(signature);
    if (!abiHash) return undefined;
    return capabilities.find((cap) => cap.status === 'active' && cap.provenance.status === 'verified' && cap.chainId === chainId
      && cap.contract.toLowerCase() === target.toLowerCase() && cap.signature === signature && cap.abiHash.toLowerCase() === abiHash.toLowerCase());
  });
  if (selected.some((cap) => !cap)) return [];
  return selected.map((cap) => ({ capabilityId: cap!.capabilityId, chainId, contract: cap!.contract.toLowerCase(), signature: cap!.signature, abiHash: cap!.abiHash }));
}

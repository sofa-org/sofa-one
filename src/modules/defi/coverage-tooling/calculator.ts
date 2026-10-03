import { createHash } from 'node:crypto';
import type { ActivityMetric, ActivityMetricDefinition, Completeness, CoverageInput, CoverageInputError, CoverageManifestCapability, CoreWorkflowDefinition, ProductChainObservation } from './types';

const TARGET_BPS = 9_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/;

export type CoverageCount = Readonly<{
  activeProducts: number;
  unresolvedProducts: number;
  conservativeDenominator: number;
  fullySupportedActiveProducts: number;
  observedActiveCoverageBps: number | null;
  conservativeCoverageBps: number | null;
  observedTargetMet: boolean;
  conservativeTargetMet: boolean;
}>;

export type WorkflowCoverage = Readonly<{
  productId: string;
  chainId: number;
  instanceId: string;
  workflowId: string;
  observationRef: string;
  requirementSourceRef: string;
  requirementStatus: 'resolved' | 'unresolved';
  unresolvedReason?: string;
  claimSourceRef: string | null;
  claimedStatus: 'supported' | 'partial' | 'source_blocked' | 'unknown' | 'missing';
  complete: boolean;
  missingCapabilityIds: readonly string[];
  invalidCapabilityIds: readonly string[];
}>;

export type ObservationCoverage = Readonly<{
  productId: string;
  categoryId: string;
  chainId: number;
  marketStatus: ProductChainObservation['status'];
  productChainInventoryComplete: boolean;
  observationRef: string;
  instanceEnumeration: Completeness;
  workflowSetStatus: ProductChainObservation['workflowSet']['status'];
  workflowSetSourceRef: string;
  workflowIds: readonly string[];
  instanceIds: readonly string[];
  complete: boolean;
}>;

export type ProductInventoryCoverage = Readonly<{
  productId: string;
  inventoryCompleteness: Completeness;
  inventorySourceRef: string;
  expectedScopeChainIds: readonly number[];
  observedChainIds: readonly number[];
  complete: boolean;
}>;

export type WorkflowDefinitionCoverage = Readonly<{
  workflowId: string;
  productId: string;
  chainId: number;
  sourceRef: string;
  requirementStatus: 'resolved' | 'unresolved';
  unresolvedReason?: string;
  requiredCapabilityIds: readonly string[];
}>;

export type WeightedCoverage = Readonly<{
  chainId: number;
  categoryId: string;
  definitionId: string;
  unit: string;
  window: string;
  sourceRef: string;
  eligibleActiveProducts: number;
  eligibleUnresolvedProducts: number;
  activeProductsWithWeight: number;
  unresolvedProductsWithWeight: number;
  applicableUnresolvedUniverseSourceRecords: number;
  applicableUnresolvedUniverseSourceRecordRows: number;
  weightedActive: string;
  weightedSupported: string;
  observedActiveCoverageBps: number | null;
  conservativeCoverageBps: number | null;
  activeProductsWithoutWeight: number;
  unresolvedProductsWithoutWeight: number;
  targetMet: boolean;
}>;

export type CoverageReport = Readonly<{
  schemaVersion: 1;
  snapshotId: string;
  observedAt: string | null;
  captureTimeStatus: 'known' | 'unknown';
  captureTimeKnown: boolean;
  captureTimeNote?: string;
  inputFingerprint: string;
  universeEvidence: Readonly<{
    sourceRefs: readonly string[];
    eligibilityRuleId: string;
    eligibilityRuleDescription: string;
    eligibilityRuleSourceRefs: readonly string[];
    scopeChainEvidence: readonly Readonly<{ chainId: number; enumeration: Completeness; sourceRefs: readonly string[] }>[];
  }>;
  targetBasisPoints: number;
  scopeChainIds: readonly number[];
  products: CoverageCount & Readonly<{ excludedProducts: number; unresolvedUniverseRecords: number; unresolvedUniverseRecordRows: number }>;
  byChain: readonly (CoverageCount & Readonly<{ chainId: number; unresolvedUniverseRecords: number; unattributedUnresolvedUniverseRecords: number; enumeration: Completeness }>)[];
  byCategory: readonly (CoverageCount & Readonly<{ categoryId: string; unattributedUnresolvedUniverseRecords: number }>)[];
  byChainCategory: readonly (CoverageCount & Readonly<{ chainId: number; categoryId: string; unattributedUnresolvedUniverseRecords: number }>)[];
  workflowCoverage: Readonly<{ requiredWorkflows: number; completeWorkflows: number; rows: readonly WorkflowCoverage[] }>;
  workflowInventory: readonly WorkflowDefinitionCoverage[];
  observationCoverage: readonly ObservationCoverage[];
  productInventoryCoverage: readonly ProductInventoryCoverage[];
  weightedCoverage: readonly WeightedCoverage[];
  activityMetricDefinitions: CoverageInput['activityMetricDefinitions'];
  unresolvedUniverseRecords: readonly Readonly<{ sourceRecordRef: string; chainId: number | null; categoryId?: string; reason: string }>[];
  unresolvedUniverseRecordRows: number;
  unattributedUnresolvedUniverseRecords: number;
  identityEnumerationComplete: boolean;
  enumerationComplete: boolean;
  observedCohortTargetMet: boolean;
  conservativeTargetMet: boolean;
  objectiveEstablished: boolean;
  limitations: readonly string[];
}>;

type ObservationEval = { observation: ProductChainObservation; categoryId: string; complete: boolean; productInventoryComplete: boolean; workflowRows: WorkflowCoverage[] };

export function validateCoverageInput(input: CoverageInput, capabilities: readonly CoverageManifestCapability[]): readonly CoverageInputError[] {
  const errors: CoverageInputError[] = [];
  const error = (path: string, message: string) => errors.push({ path, message });
  const candidate: unknown = input;
  const candidateManifest: unknown = capabilities;
  if (!isRecord(candidate) || candidate.schemaVersion !== 1) return [{ path: 'schemaVersion', message: 'Expected normalized coverage schema version 1' }];
  const raw = candidate;
  const rawSnapshot = raw.snapshot;
  if (!isRecord(rawSnapshot) || !Array.isArray(rawSnapshot.scopeChains) || !Array.isArray(rawSnapshot.sourceRefs)
    || !isRecord(rawSnapshot.eligibilityRule) || !Array.isArray(raw.products) || !Array.isArray(raw.workflowDefinitions)
    || !Array.isArray(raw.activityMetricDefinitions) || !Array.isArray(raw.observations)
    || !Array.isArray(raw.unresolvedUniverseRecords) || !Array.isArray(candidateManifest)) {
    return [{ path: '$', message: 'Coverage input or manifest has an invalid top-level shape' }];
  }
  const rawRule = rawSnapshot.eligibilityRule;
  const nestedShapeInvalid = !Array.isArray(rawRule.sourceRefs)
    || rawSnapshot.scopeChains.some((row) => !isRecord(row) || !Array.isArray(row.sourceRefs))
    || raw.products.some((row) => !isRecord(row) || !Array.isArray(row.expectedScopeChainIds))
    || raw.workflowDefinitions.some((row) => !isRecord(row) || !Array.isArray(row.requiredCapabilities) || row.requiredCapabilities.some((required) => !isRecord(required)))
    || raw.activityMetricDefinitions.some((row) => !isRecord(row))
    || raw.observations.some((row) => !isRecord(row) || !isRecord(row.workflowSet) || !Array.isArray(row.workflowSet.workflowIds)
      || (row.activityMetrics !== undefined && (!Array.isArray(row.activityMetrics) || row.activityMetrics.some((metric) => !isRecord(metric))))
      || !Array.isArray(row.instances) || row.instances.some((instance) => !isRecord(instance) || !Array.isArray(instance.workflowClaims)
        || instance.workflowClaims.some((claim) => !isRecord(claim) || !Array.isArray(claim.admittedCapabilityIds))))
    || raw.unresolvedUniverseRecords.some((row) => !isRecord(row))
    || candidateManifest.some((row) => !isRecord(row) || !isRecord(row.provenance));
  if (nestedShapeInvalid) return [{ path: '$', message: 'Coverage input or manifest contains an invalid nested shape' }];
  const requiredText = (value: unknown, path: string) => { if (typeof value !== 'string' || !value.trim()) error(path, 'Must be a non-empty string'); };
  const unique = (values: readonly string[], path: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => { if (seen.has(value)) error(`${path}[${index}]`, `Duplicate value: ${value}`); seen.add(value); });
  };
  requiredText(input.snapshot.snapshotId, 'snapshot.snapshotId');
  if (input.snapshot.captureTimeStatus === 'known') {
    if (typeof input.snapshot.observedAt !== 'string' || !isIsoTimestamp(input.snapshot.observedAt)) error('snapshot.observedAt', 'Known capture time requires a timezone-qualified ISO timestamp');
  } else if (input.snapshot.captureTimeStatus === 'unknown') {
    if (input.snapshot.observedAt !== null) error('snapshot.observedAt', 'Unknown capture time must use null, not an artifact or retrieval timestamp');
    requiredText(input.snapshot.captureTimeNote, 'snapshot.captureTimeNote');
  } else error('snapshot.captureTimeStatus', 'Capture time must be explicitly known or unknown');
  if (!input.snapshot.sourceRefs.length) error('snapshot.sourceRefs', 'At least one frozen source reference is required');
  input.snapshot.sourceRefs.forEach((ref, i) => requiredText(ref, `snapshot.sourceRefs[${i}]`));
  requiredText(input.snapshot.eligibilityRule.ruleId, 'snapshot.eligibilityRule.ruleId');
  requiredText(input.snapshot.eligibilityRule.description, 'snapshot.eligibilityRule.description');
  if (!input.snapshot.eligibilityRule.sourceRefs.length) error('snapshot.eligibilityRule.sourceRefs', 'Frozen eligibility rule requires source references');
  input.snapshot.eligibilityRule.sourceRefs.forEach((ref, i) => requiredText(ref, `snapshot.eligibilityRule.sourceRefs[${i}]`));
  const chainIds = input.snapshot.scopeChains.map((row) => row.chainId);
  if (!chainIds.length) error('snapshot.scopeChains', 'At least one in-scope chain is required');
  if (chainIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) error('snapshot.scopeChains', 'Chain IDs must be positive safe integers');
  unique(chainIds.map(String), 'snapshot.scopeChains.chainId');
  input.snapshot.scopeChains.forEach((row, i) => {
    if (!['complete', 'incomplete'].includes(row.enumeration)) error(`snapshot.scopeChains[${i}].enumeration`, 'Invalid completeness status');
    if (!row.sourceRefs.length) error(`snapshot.scopeChains[${i}].sourceRefs`, 'Each chain requires enumeration evidence');
    row.sourceRefs.forEach((ref, j) => requiredText(ref, `snapshot.scopeChains[${i}].sourceRefs[${j}]`));
  });

  const products = new Map(input.products.map((product) => [product.productId, product]));
  unique(input.products.map((p) => p.productId), 'products.productId');
  input.products.forEach((product, i) => {
    if (!ID.test(product.productId)) error(`products[${i}].productId`, 'Invalid stable product ID');
    requiredText(product.label, `products[${i}].label`);
    requiredText(product.categoryId, `products[${i}].categoryId`);
    if (product.countingRole !== 'coverage_unit' && product.countingRole !== 'lineage_only') error(`products[${i}].countingRole`, 'Must explicitly identify a countable unit or lineage-only parent');
    if (!['complete', 'incomplete'].includes(product.chainInventoryCompleteness)) error(`products[${i}].chainInventoryCompleteness`, 'Invalid product chain inventory status');
    requiredText(product.chainInventorySourceRef, `products[${i}].chainInventorySourceRef`);
    unique(product.expectedScopeChainIds.map(String), `products[${i}].expectedScopeChainIds`);
    if (product.expectedScopeChainIds.some((chainId) => !chainIds.includes(chainId))) error(`products[${i}].expectedScopeChainIds`, 'Expected chain is outside frozen snapshot scope');
    if (product.countingRole === 'coverage_unit' && product.expectedScopeChainIds.length === 0) error(`products[${i}].expectedScopeChainIds`, 'Countable product requires an explicit expected-chain inventory');
    if (product.parentProductId && !products.has(product.parentProductId)) error(`products[${i}].parentProductId`, 'Parent product is not in the canonical product inventory');
    if (product.parentProductId === product.productId) error(`products[${i}].parentProductId`, 'A product cannot parent itself');
  });
  for (const product of input.products) {
    let parent = product.parentProductId;
    const seen = new Set([product.productId]);
    while (parent) {
      if (seen.has(parent)) { error(`products.${product.productId}.parentProductId`, 'Product lineage contains a cycle'); break; }
      seen.add(parent);
      parent = products.get(parent)?.parentProductId;
    }
  }

  const capabilityMap = new Map<string, CoverageManifestCapability>();
  capabilities.forEach((cap, i) => {
    if (!ID.test(cap.capabilityId) || !['active', 'inactive'].includes(cap.status) || !['contract_call', 'typed_data_sign'].includes(cap.type)
      || !Number.isSafeInteger(cap.chainId) || cap.chainId <= 0 || !ADDRESS.test(cap.contract)
      || typeof cap.signature !== 'string' || !cap.signature.trim() || !/^0x[0-9a-fA-F]{64}$/.test(cap.abiHash)
      || !cap.provenance || !['verified', 'candidate'].includes(cap.provenance.status)
      || (cap.status === 'active' && cap.provenance.status !== 'verified') || typeof cap.provenance.sourceRef !== 'string' || !cap.provenance.sourceRef.trim()
      || !isIsoDate(cap.provenance.verifiedAt)) {
      error(`manifest.capabilities[${i}]`, 'Manifest capability identity and verified source/date provenance must be complete');
    }
    if (capabilityMap.has(cap.capabilityId)) error(`manifest.capabilities[${i}].capabilityId`, 'Duplicate capability ID');
    capabilityMap.set(cap.capabilityId, cap);
  });
  const workflows = new Map<string, CoreWorkflowDefinition>();
  unique(input.workflowDefinitions.map((w) => w.workflowId), 'workflowDefinitions.workflowId');
  input.workflowDefinitions.forEach((workflow, i) => {
    workflows.set(workflow.workflowId, workflow);
    if (!ID.test(workflow.workflowId)) error(`workflowDefinitions[${i}].workflowId`, 'Invalid stable workflow ID');
    if (!products.has(workflow.productId)) error(`workflowDefinitions[${i}].productId`, 'Unknown canonical product');
    if (!chainIds.includes(workflow.chainId)) error(`workflowDefinitions[${i}].chainId`, 'Workflow chain is outside frozen scope');
    if (!products.get(workflow.productId)?.expectedScopeChainIds.includes(workflow.chainId)) error(`workflowDefinitions[${i}].chainId`, 'Workflow chain is not in the product’s independently enumerated chain inventory');
    requiredText(workflow.sourceRef, `workflowDefinitions[${i}].sourceRef`);
    const requirementStatus = workflow.requirementStatus ?? 'resolved';
    if (!['resolved', 'unresolved'].includes(requirementStatus)) error(`workflowDefinitions[${i}].requirementStatus`, 'Invalid workflow requirement status');
    if (requirementStatus === 'resolved' && workflow.requiredCapabilities.length === 0) error(`workflowDefinitions[${i}].requiredCapabilities`, 'Resolved core workflow cannot be vacuously complete');
    if (requirementStatus === 'unresolved') requiredText(workflow.unresolvedReason, `workflowDefinitions[${i}].unresolvedReason`);
    unique(workflow.requiredCapabilities.map((required) => required.capabilityId), `workflowDefinitions[${i}].requiredCapabilities`);
    workflow.requiredCapabilities.forEach((required, j) => {
      if (required.chainId !== workflow.chainId) error(`workflowDefinitions[${i}].requiredCapabilities[${j}].chainId`, 'Required capability chain must match workflow chain');
      if (!ADDRESS.test(required.contract)) error(`workflowDefinitions[${i}].requiredCapabilities[${j}].contract`, 'Expected a contract address');
      requiredText(required.signature, `workflowDefinitions[${i}].requiredCapabilities[${j}].signature`);
      if (!/^0x[0-9a-fA-F]{64}$/.test(required.abiHash)) error(`workflowDefinitions[${i}].requiredCapabilities[${j}].abiHash`, 'Expected canonical bytes32 ABI identity');
    });
  });

  const categories = new Set(input.products.map((product) => product.categoryId));
  const metricDefinitions = new Set<string>();
  input.activityMetricDefinitions.forEach((definition, i) => {
    const path = `activityMetricDefinitions[${i}]`;
    if (!chainIds.includes(definition.chainId)) error(`${path}.chainId`, 'Activity metric chain is outside frozen scope');
    if (!categories.has(definition.categoryId)) error(`${path}.categoryId`, 'Activity metric category is not in the canonical product inventory');
    validateMetricDefinition(definition, path, requiredText);
    const key = metricKey(definition);
    if (metricDefinitions.has(key)) error(path, 'Duplicate activity metric definition');
    metricDefinitions.add(key);
  });

  const seenObservations = new Set<string>();
  const referencedWorkflowIds = new Set<string>();
  input.observations.forEach((observation, i) => {
    const path = `observations[${i}]`;
    if (!products.has(observation.productId)) error(`${path}.productId`, 'Unknown canonical product');
    if (!chainIds.includes(observation.chainId)) error(`${path}.chainId`, 'Observation chain is outside frozen scope');
    const key = `${observation.productId}:${observation.chainId}`;
    if (seenObservations.has(key)) error(path, 'Duplicate product/chain observation; do not count lineage labels twice');
    seenObservations.add(key);
    requiredText(observation.observationRef, `${path}.observationRef`);
    if (!['observed_active', 'unresolved', 'observed_inactive', 'explicitly_excluded'].includes(observation.status)) error(`${path}.status`, 'Invalid market observation classification');
    if (!['complete', 'incomplete'].includes(observation.instanceEnumeration)) error(`${path}.instanceEnumeration`, 'Invalid instance completeness status');
    if (!['complete', 'incomplete', 'explicitly_excluded'].includes(observation.workflowSet.status)) error(`${path}.workflowSet.status`, 'Invalid workflow inventory status');
    if (products.get(observation.productId)?.countingRole === 'lineage_only' && observation.status === 'observed_active') error(`${path}.status`, 'Lineage-only parent/label cannot be counted as an active coverage unit');
    if (observation.status === 'explicitly_excluded') {
      if (observation.workflowSet.status !== 'explicitly_excluded' || !observation.workflowSet.exclusionReason?.trim()) error(`${path}.workflowSet`, 'Explicit exclusion requires an explicit exclusion status and reason');
    } else if (observation.workflowSet.status === 'explicitly_excluded') error(`${path}.workflowSet`, 'Only explicitly excluded observations may use excluded workflow status');
    requiredText(observation.workflowSet.sourceRef, `${path}.workflowSet.sourceRef`);
    unique(observation.workflowSet.workflowIds, `${path}.workflowSet.workflowIds`);
    if ((observation.status === 'observed_active' || observation.status === 'unresolved') && observation.workflowSet.status === 'complete' && observation.workflowSet.workflowIds.length === 0) error(`${path}.workflowSet.workflowIds`, 'Complete core-workflow inventory cannot be empty for an active or unresolved product');
    observation.workflowSet.workflowIds.forEach((workflowId) => {
      referencedWorkflowIds.add(workflowId);
      if (!ID.test(workflowId)) error(`${path}.workflowSet.workflowIds`, 'Invalid workflow ID');
      const definition = workflows.get(workflowId);
      if (!definition || definition.productId !== observation.productId || definition.chainId !== observation.chainId) error(`${path}.workflowSet.workflowIds`, `Workflow ${workflowId} is undefined or belongs to another product/chain`);
    });
    unique(observation.instances.map((instance) => instance.instanceId), `${path}.instances.instanceId`);
    observation.instances.forEach((instance, j) => {
      requiredText(instance.instanceId, `${path}.instances[${j}].instanceId`);
      unique(instance.workflowClaims.map((claim) => claim.workflowId), `${path}.instances[${j}].workflowClaims.workflowId`);
      instance.workflowClaims.forEach((claim, k) => {
        requiredText(claim.sourceRef, `${path}.instances[${j}].workflowClaims[${k}].sourceRef`);
        if (!['supported', 'partial', 'source_blocked', 'unknown'].includes(claim.status)) error(`${path}.instances[${j}].workflowClaims[${k}].status`, 'Invalid workflow claim status');
        unique(claim.admittedCapabilityIds, `${path}.instances[${j}].workflowClaims[${k}].admittedCapabilityIds`);
      });
    });
    const observationMetricKeys = new Set<string>();
    (observation.activityMetrics ?? []).forEach((activity, j) => {
      const metricPath = `${path}.activityMetrics[${j}]`;
      validateMetric(activity, metricPath, error, requiredText);
      const metric = { chainId: observation.chainId, categoryId: products.get(observation.productId)?.categoryId ?? '', ...activity };
      const key = metricKey(metric);
      if (observationMetricKeys.has(key)) error(metricPath, 'Duplicate activity metric value for the same comparison group');
      observationMetricKeys.add(key);
      if (!metricDefinitions.has(key)) error(metricPath, 'Observed activity weight lacks a matching frozen metric definition');
    });
  });
  const observationsByProduct = new Map<string, Set<number>>();
  for (const observation of input.observations) {
    observationsByProduct.set(observation.productId, observationsByProduct.get(observation.productId) ?? new Set());
    observationsByProduct.get(observation.productId)!.add(observation.chainId);
  }
  input.products.forEach((product, i) => {
    const observedChains = observationsByProduct.get(product.productId) ?? new Set<number>();
    if (product.countingRole === 'coverage_unit' && observedChains.size === 0) error(`products[${i}]`, 'Countable product without observations must be represented as an unresolved universe record');
    for (const chainId of product.expectedScopeChainIds) if (!observedChains.has(chainId)) error(`products[${i}].expectedScopeChainIds`, `Expected chain ${chainId} has no explicit active, inactive, or unresolved observation`);
    for (const chainId of observedChains) if (!product.expectedScopeChainIds.includes(chainId)) error(`products[${i}].expectedScopeChainIds`, `Observed chain ${chainId} is omitted from the product inventory`);
    if (product.chainInventoryCompleteness === 'complete' && product.expectedScopeChainIds.length === 0 && product.countingRole === 'coverage_unit') error(`products[${i}].expectedScopeChainIds`, 'Complete countable inventory cannot be empty');
  });
  input.workflowDefinitions.forEach((workflow, i) => {
    if (!referencedWorkflowIds.has(workflow.workflowId)) error(`workflowDefinitions[${i}].workflowId`, 'Workflow definition is not retained in any product-chain workflow inventory');
  });
  input.unresolvedUniverseRecords.forEach((record, i) => {
    requiredText(record.sourceRecordRef, `unresolvedUniverseRecords[${i}].sourceRecordRef`);
    requiredText(record.reason, `unresolvedUniverseRecords[${i}].reason`);
    if (record.chainId !== null && !chainIds.includes(record.chainId)) error(`unresolvedUniverseRecords[${i}].chainId`, 'Chain is outside frozen scope');
    if (record.categoryId !== undefined && (typeof record.categoryId !== 'string' || !ID.test(record.categoryId))) error(`unresolvedUniverseRecords[${i}].categoryId`, 'Expected a stable source-attributed category ID');
  });
  const unresolvedRecordPairs = input.unresolvedUniverseRecords.map((record) => JSON.stringify([record.sourceRecordRef, record.chainId]));
  unique(unresolvedRecordPairs, 'unresolvedUniverseRecords.sourceRecordRef+chainId');
  return errors;
}

export function computeCoverage(input: CoverageInput, capabilities: readonly CoverageManifestCapability[]): CoverageReport {
  const errors = validateCoverageInput(input, capabilities);
  if (errors.length) throw new CoverageValidationError(errors);
  const products = new Map(input.products.map((product) => [product.productId, product]));
  const definitions = new Map(input.workflowDefinitions.map((workflow) => [workflow.workflowId, workflow]));
  const scope = [...input.snapshot.scopeChains].sort((a, b) => a.chainId - b.chainId);
  const manifest = new Map(capabilities.map((cap) => [cap.capabilityId, cap]));
  const evaluations: ObservationEval[] = [];
  const workflowRows: WorkflowCoverage[] = [];

  for (const observation of [...input.observations].sort(compareObservation)) {
    const categoryId = products.get(observation.productId)!.categoryId;
    if (observation.status === 'explicitly_excluded' || observation.status === 'observed_inactive') continue;
    const workflowIds = observation.workflowSet.workflowIds;
    const localRows: WorkflowCoverage[] = [];
    const productInventoryComplete = products.get(observation.productId)?.chainInventoryCompleteness === 'complete';
    let complete = observation.status === 'observed_active'
      && productInventoryComplete
      && observation.instanceEnumeration === 'complete'
      && observation.instances.length > 0
      && observation.workflowSet.status === 'complete'
      && workflowIds.length > 0;

    for (const instance of [...observation.instances].sort((a, b) => a.instanceId.localeCompare(b.instanceId))) {
      const claims = new Map(instance.workflowClaims.map((claim) => [claim.workflowId, claim]));
      for (const workflowId of workflowIds) {
        const definition = definitions.get(workflowId)!;
        const claim = claims.get(workflowId);
        const admitted = new Set(claim?.admittedCapabilityIds ?? []);
        const missing = definition.requiredCapabilities.filter((required) => !admitted.has(required.capabilityId)).map((required) => required.capabilityId).sort();
        const invalid = definition.requiredCapabilities.filter((required) => {
          if (!admitted.has(required.capabilityId)) return false;
          const cap = manifest.get(required.capabilityId);
          return !cap || cap.status !== 'active' || cap.provenance.status !== 'verified' || cap.type !== 'contract_call' || cap.chainId !== required.chainId
            || cap.chainId !== observation.chainId || lower(cap.contract) !== lower(required.contract)
            || cap.signature !== required.signature || lower(cap.abiHash) !== lower(required.abiHash);
        }).map((required) => required.capabilityId).sort();
        const extra = [...admitted].filter((id) => !definition.requiredCapabilities.some((required) => required.capabilityId === id));
        invalid.push(...extra.sort());
        const requirementStatus = definition.requirementStatus ?? 'resolved';
        const rowComplete = requirementStatus === 'resolved' && !!claim && claim.status === 'supported' && missing.length === 0 && invalid.length === 0;
        const row: WorkflowCoverage = {
          productId: observation.productId, chainId: observation.chainId, instanceId: instance.instanceId, workflowId,
          observationRef: observation.observationRef, requirementSourceRef: definition.sourceRef, claimSourceRef: claim?.sourceRef ?? null,
          requirementStatus, ...(definition.unresolvedReason ? { unresolvedReason: definition.unresolvedReason } : {}),
          claimedStatus: claim?.status ?? 'missing', complete: rowComplete, missingCapabilityIds: missing, invalidCapabilityIds: invalid,
        };
        localRows.push(row);
        if (!rowComplete) complete = false;
      }
      if (instance.workflowClaims.some((claim) => !workflowIds.includes(claim.workflowId))) complete = false;
    }
    if (observation.status === 'unresolved') complete = false;
    workflowRows.push(...localRows);
    evaluations.push({ observation, categoryId, complete, productInventoryComplete, workflowRows: localRows });
  }

  const active = evaluations.filter((entry) => entry.observation.status === 'observed_active' && products.get(entry.observation.productId)?.countingRole === 'coverage_unit');
  const unresolved = evaluations.filter((entry) => entry.observation.status === 'unresolved' && products.get(entry.observation.productId)?.countingRole === 'coverage_unit');
  const globalUnknownRefs = uniqueUnresolvedRefs(input.unresolvedUniverseRecords);
  const unattributedUnknownRefs = new Set(input.unresolvedUniverseRecords.filter((record) => record.chainId === null).map((record) => record.sourceRecordRef));
  const allCount = count(active, unresolved, globalUnknownRefs.size, true);
  const byChain = scope.map(({ chainId, enumeration }) => {
    const a = active.filter((entry) => entry.observation.chainId === chainId);
    const u = unresolved.filter((entry) => entry.observation.chainId === chainId);
    const unknownRefs = new Set(input.unresolvedUniverseRecords.filter((record) => record.chainId === chainId).map((record) => record.sourceRecordRef));
    const base = count(a, u, unknownRefs.size);
    const unattributed = unattributedUnknownRefs.size;
    return {
      ...base,
      ...(unattributed ? { conservativeCoverageBps: null, conservativeTargetMet: false } : {}),
      chainId, enumeration, unresolvedUniverseRecords: unknownRefs.size, unattributedUnresolvedUniverseRecords: unattributed,
    };
  });
  const categories = [...new Set(input.products.map((product) => product.categoryId))].sort();
  const byCategory = categories.map((categoryId) => {
    const a = active.filter((entry) => entry.categoryId === categoryId);
    const u = unresolved.filter((entry) => entry.categoryId === categoryId);
    const unknown = new Set(input.unresolvedUniverseRecords.filter((record) => record.categoryId === categoryId).map((record) => record.sourceRecordRef)).size;
    const unattributed = new Set(input.unresolvedUniverseRecords.filter((record) => !record.categoryId).map((record) => record.sourceRecordRef)).size;
    const base = count(a, u, unknown, true);
    return { ...base, ...(unattributed ? { conservativeCoverageBps: null, conservativeTargetMet: false } : {}), categoryId, unattributedUnresolvedUniverseRecords: unattributed };
  });
  const byChainCategory = scope.flatMap(({ chainId }) => categories.map((categoryId) => {
    const a = active.filter((entry) => entry.observation.chainId === chainId && entry.categoryId === categoryId);
    const u = unresolved.filter((entry) => entry.observation.chainId === chainId && entry.categoryId === categoryId);
    const unknown = new Set(input.unresolvedUniverseRecords.filter((record) => record.chainId === chainId && record.categoryId === categoryId).map((record) => record.sourceRecordRef)).size;
    const unattributed = new Set(input.unresolvedUniverseRecords.filter((record) => record.chainId === null || !record.categoryId).map((record) => record.sourceRecordRef)).size;
    const base = count(a, u, unknown, true);
    return { ...base, ...(unattributed ? { conservativeCoverageBps: null, conservativeTargetMet: false } : {}), chainId, categoryId, unattributedUnresolvedUniverseRecords: unattributed };
  }));
  const weightedCoverage = computeWeighted(input.observations, evaluations, products, input.activityMetricDefinitions, input.unresolvedUniverseRecords);
  const countableProducts = input.products.filter((product) => product.countingRole === 'coverage_unit');
  const productInventoryComplete = countableProducts.every((product) => product.chainInventoryCompleteness === 'complete');
  const identityEnumerationComplete = globalUnknownRefs.size === 0;
  const enumerationComplete = scope.every((chain) => chain.enumeration === 'complete') && productInventoryComplete && identityEnumerationComplete;
  const observedCohortTargetMet = allCount.observedTargetMet && byChain.every((row) => row.observedTargetMet);
  const conservativeTargetMet = allCount.conservativeTargetMet && byChain.every((row) => row.conservativeTargetMet);
  const objectiveEstablished = enumerationComplete && identityEnumerationComplete && input.snapshot.captureTimeStatus === 'known' && unattributedUnknownRefs.size === 0
    && observedCohortTargetMet && conservativeTargetMet;
  return {
    schemaVersion: 1,
    snapshotId: input.snapshot.snapshotId,
    observedAt: input.snapshot.observedAt,
    captureTimeStatus: input.snapshot.captureTimeStatus,
    captureTimeKnown: input.snapshot.captureTimeStatus === 'known',
    ...(input.snapshot.captureTimeNote ? { captureTimeNote: input.snapshot.captureTimeNote } : {}),
    inputFingerprint: coverageInputFingerprint(input, capabilities),
    universeEvidence: {
      sourceRefs: [...input.snapshot.sourceRefs].sort(),
      eligibilityRuleId: input.snapshot.eligibilityRule.ruleId,
      eligibilityRuleDescription: input.snapshot.eligibilityRule.description,
      eligibilityRuleSourceRefs: [...input.snapshot.eligibilityRule.sourceRefs].sort(),
      scopeChainEvidence: scope.map((row) => ({ chainId: row.chainId, enumeration: row.enumeration, sourceRefs: [...row.sourceRefs].sort() })),
    },
    targetBasisPoints: TARGET_BPS,
    scopeChainIds: scope.map((chain) => chain.chainId),
    products: {
      ...allCount,
      excludedProducts: new Set(input.observations.filter((o) => o.status === 'explicitly_excluded').map((o) => o.productId)).size,
      unresolvedUniverseRecords: globalUnknownRefs.size,
      unresolvedUniverseRecordRows: input.unresolvedUniverseRecords.length,
    },
    byChain,
    byCategory,
    byChainCategory,
    workflowCoverage: { requiredWorkflows: workflowRows.length, completeWorkflows: workflowRows.filter((row) => row.complete).length, rows: workflowRows.sort(compareWorkflow) },
    workflowInventory: [...input.workflowDefinitions].map((workflow) => ({
      workflowId: workflow.workflowId,
      productId: workflow.productId,
      chainId: workflow.chainId,
      sourceRef: workflow.sourceRef,
      requirementStatus: workflow.requirementStatus ?? 'resolved',
      ...(workflow.unresolvedReason ? { unresolvedReason: workflow.unresolvedReason } : {}),
      requiredCapabilityIds: workflow.requiredCapabilities.map((required) => required.capabilityId).sort(),
    })).sort((a, b) => a.chainId - b.chainId || a.productId.localeCompare(b.productId) || a.workflowId.localeCompare(b.workflowId)),
    observationCoverage: evaluations.map(({ observation, categoryId, complete, productInventoryComplete }) => ({
      productId: observation.productId, categoryId, chainId: observation.chainId, marketStatus: observation.status,
      productChainInventoryComplete: productInventoryComplete,
      observationRef: observation.observationRef, instanceEnumeration: observation.instanceEnumeration,
      workflowSetStatus: observation.workflowSet.status, workflowSetSourceRef: observation.workflowSet.sourceRef,
      workflowIds: [...observation.workflowSet.workflowIds].sort(), instanceIds: observation.instances.map((instance) => instance.instanceId).sort(), complete,
    })),
    productInventoryCoverage: countableProducts.map((product) => {
      const observedChainIds = [...new Set(input.observations.filter((observation) => observation.productId === product.productId).map((observation) => observation.chainId))].sort((a, b) => a - b);
      return {
        productId: product.productId,
        inventoryCompleteness: product.chainInventoryCompleteness,
        inventorySourceRef: product.chainInventorySourceRef,
        expectedScopeChainIds: [...product.expectedScopeChainIds].sort((a, b) => a - b),
        observedChainIds,
        complete: product.chainInventoryCompleteness === 'complete' && product.expectedScopeChainIds.every((chainId) => observedChainIds.includes(chainId)),
      };
    }).sort((a, b) => a.productId.localeCompare(b.productId)),
    weightedCoverage,
    activityMetricDefinitions: [...input.activityMetricDefinitions].sort(compareMetricDefinition),
    unresolvedUniverseRecords: [...input.unresolvedUniverseRecords].sort((a, b) => a.sourceRecordRef.localeCompare(b.sourceRecordRef) || (a.chainId ?? 0) - (b.chainId ?? 0)),
    unresolvedUniverseRecordRows: input.unresolvedUniverseRecords.length,
    unattributedUnresolvedUniverseRecords: unattributedUnknownRefs.size,
    identityEnumerationComplete,
    enumerationComplete,
    observedCohortTargetMet,
    conservativeTargetMet,
    objectiveEstablished,
    limitations: [
      'Coverage is an offline source/manifest association measure, not financial strategy, runtime safety, liquidity, deployment, or transaction-success evidence.',
      'Observed-active coverage uses observed active canonical products; conservative coverage adds recorded unresolved canonical products and unresolved source records to its denominator.',
      'Unresolved source records are conservative proxy units, not verified unique products; a repeated source reference across chains counts once globally and once per attributed chain.',
      'Any unresolved source record, including one with known chain attribution, means source-universe product identity enumeration is incomplete and prevents objectiveEstablished; its denominator contribution is a conservative row proxy, not a verified product count.',
      'A null-chain unresolved record is included globally but prevents a per-chain conservative ratio and objective claim because its chain cannot be attributed.',
      'Unknown snapshot capture time is reported as null and prevents a current/fresh coverage objective claim.',
      'Any incomplete chain enumeration, unresolved identity/chain attribution, missing workflow inventory, or incomplete instance inventory prevents objectiveEstablished.',
      'A complete workflow row reflects only the exact frozen requirement-to-active-verified-capability match for its recorded target; it does not establish product-wide support or a complete deployment population. Lineage-only workflow seeds never enter the coverage-product denominator.',
      'Only compatible activity weights with the same chain, category, metric definition, unit, window, and source are combined; missing weights remain missing and are never treated as zero.',
      'Weighted conservative ratios are null when an applicable unresolved source proxy or unresolved canonical product has no compatible weight; source proxy references and rows are reported separately from canonical-product weight counts.',
      'API-key grant ceilings and transaction call limits are execution constraints, not evidence that market coverage is complete.',
    ],
  };
}

export class CoverageValidationError extends Error {
  constructor(readonly errors: readonly CoverageInputError[]) { super(`Invalid coverage input (${errors.length} error(s))`); }
}

export function coverageInputFingerprint(input: CoverageInput, capabilities: readonly CoverageManifestCapability[]): string {
  const canonical = canonicalJson({ input, capabilities: [...capabilities].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)) });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function count(activeRows: readonly ObservationEval[], unresolvedRows: readonly ObservationEval[], extraUnresolved = 0, requireAllRows = false): CoverageCount {
  const activeIds = new Set(activeRows.map((row) => row.observation.productId));
  const unresolvedIds = new Set(unresolvedRows.map((row) => row.observation.productId));
  const grouped = new Map<string, ObservationEval[]>();
  for (const row of activeRows) grouped.set(row.observation.productId, [...(grouped.get(row.observation.productId) ?? []), row]);
  const supported = new Set([...grouped].filter(([, rows]) => requireAllRows ? rows.every((row) => row.complete) : rows.some((row) => row.complete)).map(([id]) => id));
  const activeProducts = activeIds.size;
  const unresolvedProducts = unresolvedIds.size + extraUnresolved;
  const fullySupportedActiveProducts = [...supported].filter((id) => !unresolvedIds.has(id)).length;
  const denominator = new Set([...activeIds, ...unresolvedIds]).size + extraUnresolved;
  const observedBps = activeProducts ? Math.floor((fullySupportedActiveProducts * 10_000) / activeProducts) : null;
  const conservativeBps = denominator ? Math.floor((fullySupportedActiveProducts * 10_000) / denominator) : null;
  return {
    activeProducts, unresolvedProducts, fullySupportedActiveProducts,
    conservativeDenominator: denominator,
    observedActiveCoverageBps: observedBps,
    conservativeCoverageBps: conservativeBps,
    observedTargetMet: observedBps !== null && observedBps >= TARGET_BPS,
    conservativeTargetMet: conservativeBps !== null && conservativeBps >= TARGET_BPS,
  };
}

function uniqueUnresolvedRefs(records: CoverageInput['unresolvedUniverseRecords']): Set<string> {
  return new Set(records.map((record) => record.sourceRecordRef));
}

function computeWeighted(
  observations: readonly ProductChainObservation[],
  evaluated: readonly ObservationEval[],
  products: ReadonlyMap<string, CoverageInput['products'][number]>,
  definitions: readonly ActivityMetricDefinition[],
  unresolvedUniverseRecords: CoverageInput['unresolvedUniverseRecords'],
): WeightedCoverage[] {
  type Bucket = { chainId: number; categoryId: string; metric: Omit<ActivityMetric, 'value'>; active: Array<{ value: Decimal; complete: boolean }>; unresolved: Array<{ value: Decimal; complete: boolean }>; missingActive: number; missingUnresolved: number; sourceProxyRefs: Set<string>; sourceProxyRows: number };
  const buckets = new Map<string, Bucket>();
  const completeness = new Map(evaluated.map((entry) => [`${entry.observation.productId}:${entry.observation.chainId}`, entry.complete]));
  const getBucket = (chainId: number, categoryId: string, metric: Omit<ActivityMetric, 'value'>): Bucket => {
    const key = [chainId, categoryId, metric.definitionId, metric.unit, metric.window, metric.sourceRef].join('\u0000');
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { chainId, categoryId, metric, active: [], unresolved: [], missingActive: 0, missingUnresolved: 0, sourceProxyRefs: new Set(), sourceProxyRows: 0 }; buckets.set(key, bucket); }
    return bucket;
  };
  for (const definition of definitions) getBucket(definition.chainId, definition.categoryId, definition);
  for (const observation of observations) {
    if (observation.status !== 'observed_active' && observation.status !== 'unresolved') continue;
    if (products.get(observation.productId)?.countingRole !== 'coverage_unit') continue;
    const categoryId = products.get(observation.productId)!.categoryId;
    for (const activity of observation.activityMetrics ?? []) {
      const bucket = getBucket(observation.chainId, categoryId, activity);
      const row = { value: parseDecimal(activity.value), complete: completeness.get(`${observation.productId}:${observation.chainId}`) === true && observation.status === 'observed_active' };
      (observation.status === 'observed_active' ? bucket.active : bucket.unresolved).push(row);
    }
  }
  // A proxy with known attribution affects only matching metric populations. A missing chain/category
  // is potentially applicable to every compatible group, but its unknown weight is never fabricated.
  for (const bucket of buckets.values()) {
    const applicableRows = unresolvedUniverseRecords.filter((record) =>
      (record.chainId === null || record.chainId === bucket.chainId)
      && (!record.categoryId || record.categoryId === bucket.categoryId));
    bucket.sourceProxyRows = applicableRows.length;
    for (const record of applicableRows) bucket.sourceProxyRefs.add(record.sourceRecordRef);
  }
  // Missing or differently-defined values count against each explicitly expected group, never as zero.
  for (const observation of observations) {
    if (observation.status !== 'observed_active' && observation.status !== 'unresolved') continue;
    if (products.get(observation.productId)?.countingRole !== 'coverage_unit') continue;
    const categoryId = products.get(observation.productId)!.categoryId;
    for (const bucket of buckets.values()) if (bucket.chainId === observation.chainId && bucket.categoryId === categoryId) {
      const compatible = (observation.activityMetrics ?? []).some((activity) => metricKey({ chainId: observation.chainId, categoryId, ...activity })
        === metricKey({ chainId: bucket.chainId, categoryId: bucket.categoryId, ...bucket.metric }));
      if (!compatible) {
        if (observation.status === 'observed_active') bucket.missingActive++;
        else bucket.missingUnresolved++;
      }
    }
  }
  return [...buckets.values()].map((bucket) => {
    const scale = Math.max(0, ...[...bucket.active, ...bucket.unresolved].map((row) => row.value.scale));
    const activeWeight = bucket.active.reduce((sum, row) => sum + rescale(row.value, scale), 0n);
    const supportedWeight = bucket.active.reduce((sum, row) => sum + (row.complete ? rescale(row.value, scale) : 0n), 0n);
    const unresolvedWeight = bucket.unresolved.reduce((sum, row) => sum + rescale(row.value, scale), 0n);
    const conservativeDenominator = activeWeight + unresolvedWeight;
    const observedBps = activeWeight > 0n ? Number((supportedWeight * 10_000n) / activeWeight) : null;
    const conservativeBps = conservativeDenominator > 0n ? Number((supportedWeight * 10_000n) / conservativeDenominator) : null;
    return {
      chainId: bucket.chainId, categoryId: bucket.categoryId, definitionId: bucket.metric.definitionId,
      unit: bucket.metric.unit, window: bucket.metric.window, sourceRef: bucket.metric.sourceRef,
      eligibleActiveProducts: observations.filter((row) => row.chainId === bucket.chainId && products.get(row.productId)?.countingRole === 'coverage_unit' && products.get(row.productId)?.categoryId === bucket.categoryId && row.status === 'observed_active').length,
      eligibleUnresolvedProducts: observations.filter((row) => row.chainId === bucket.chainId && products.get(row.productId)?.countingRole === 'coverage_unit' && products.get(row.productId)?.categoryId === bucket.categoryId && row.status === 'unresolved').length,
      activeProductsWithWeight: bucket.active.length,
      unresolvedProductsWithWeight: bucket.unresolved.length,
      applicableUnresolvedUniverseSourceRecords: bucket.sourceProxyRefs.size,
      applicableUnresolvedUniverseSourceRecordRows: bucket.sourceProxyRows,
      weightedActive: formatDecimal(activeWeight, scale), weightedSupported: formatDecimal(supportedWeight, scale),
      observedActiveCoverageBps: observedBps,
      activeProductsWithoutWeight: bucket.missingActive, unresolvedProductsWithoutWeight: bucket.missingUnresolved,
      conservativeCoverageBps: bucket.sourceProxyRefs.size > 0 || bucket.missingActive > 0 || bucket.missingUnresolved > 0 ? null : conservativeBps,
      targetMet: observedBps !== null && bucket.sourceProxyRefs.size === 0 && bucket.missingUnresolved === 0 && conservativeBps !== null
        && observedBps >= TARGET_BPS && conservativeBps >= TARGET_BPS
        && bucket.missingActive === 0 && bucket.missingUnresolved === 0,
    };
  }).sort((a, b) => a.chainId - b.chainId || a.categoryId.localeCompare(b.categoryId) || a.definitionId.localeCompare(b.definitionId) || a.unit.localeCompare(b.unit) || a.window.localeCompare(b.window) || a.sourceRef.localeCompare(b.sourceRef));
}

type Decimal = { integer: bigint; scale: number };
function parseDecimal(value: string): Decimal {
  if (value.length > 96 || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(value)) throw new Error(`Invalid decimal metric value: ${value}`);
  const [whole, fraction = ''] = value.split('.');
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
function rescale(value: Decimal, scale: number): bigint { return value.integer * 10n ** BigInt(scale - value.scale); }
function formatDecimal(value: bigint, scale: number): string {
  if (!scale) return value.toString();
  const digits = value.toString().padStart(scale + 1, '0');
  const result = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
  return result || '0';
}
function validateMetric(metric: ActivityMetric, path: string, error: (path: string, message: string) => void, requiredText: (value: unknown, path: string) => void): void {
  requiredText(metric.definitionId, `${path}.definitionId`);
  requiredText(metric.unit, `${path}.unit`);
  requiredText(metric.window, `${path}.window`);
  requiredText(metric.sourceRef, `${path}.sourceRef`);
  try { parseDecimal(metric.value); } catch { error(`${path}.value`, 'Must be a non-negative canonical decimal string'); }
}
function validateMetricDefinition(metric: ActivityMetricDefinition, path: string, requiredText: (value: unknown, path: string) => void): void {
  requiredText(metric.definitionId, `${path}.definitionId`);
  requiredText(metric.categoryId, `${path}.categoryId`);
  requiredText(metric.unit, `${path}.unit`);
  requiredText(metric.window, `${path}.window`);
  requiredText(metric.sourceRef, `${path}.sourceRef`);
}
function metricKey(metric: ActivityMetricDefinition): string { return JSON.stringify([metric.chainId, metric.categoryId, metric.definitionId, metric.unit, metric.window, metric.sourceRef]); }
function compareMetricDefinition(a: ActivityMetricDefinition, b: ActivityMetricDefinition): number { return a.chainId - b.chainId || a.categoryId.localeCompare(b.categoryId) || a.definitionId.localeCompare(b.definitionId) || a.unit.localeCompare(b.unit) || a.window.localeCompare(b.window) || a.sourceRef.localeCompare(b.sourceRef); }
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function compareObservation(a: ProductChainObservation, b: ProductChainObservation): number { return a.chainId - b.chainId || a.productId.localeCompare(b.productId); }
function compareWorkflow(a: WorkflowCoverage, b: WorkflowCoverage): number { return a.chainId - b.chainId || a.productId.localeCompare(b.productId) || a.instanceId.localeCompare(b.instanceId) || a.workflowId.localeCompare(b.workflowId); }
function lower(value: string): string { return value.toLowerCase(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

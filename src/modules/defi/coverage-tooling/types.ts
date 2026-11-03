export type CoverageStatus = 'observed_active' | 'unresolved' | 'observed_inactive' | 'explicitly_excluded';
export type Completeness = 'complete' | 'incomplete';

export type CoverageManifestCapability = Readonly<{
  capabilityId: string;
  status: 'active' | 'inactive';
  type: 'contract_call' | 'typed_data_sign';
  chainId: number;
  contract: string;
  signature: string;
  abiHash: string;
  provenance: Readonly<{ status: 'verified' | 'candidate'; sourceRef: string; verifiedAt: string }>;
}>;

export type RequiredCapability = Readonly<{
  capabilityId: string;
  chainId: number;
  contract: string;
  signature: string;
  abiHash: string;
}>;

export type CoreWorkflowDefinition = Readonly<{
  workflowId: string;
  productId: string;
  chainId: number;
  sourceRef: string;
  requirementStatus?: 'resolved' | 'unresolved';
  unresolvedReason?: string;
  requiredCapabilities: readonly RequiredCapability[];
}>;

export type ActivityMetric = Readonly<{
  definitionId: string;
  value: string;
  unit: string;
  window: string;
  sourceRef: string;
}>;

export type ActivityMetricDefinition = Readonly<{
  chainId: number;
  categoryId: string;
  definitionId: string;
  unit: string;
  window: string;
  sourceRef: string;
}>;

export type ProductInstance = Readonly<{
  instanceId: string;
  workflowClaims: readonly Readonly<{
    workflowId: string;
    status: 'supported' | 'partial' | 'source_blocked' | 'unknown';
    sourceRef: string;
    admittedCapabilityIds: readonly string[];
  }>[];
}>;

export type ProductChainObservation = Readonly<{
  productId: string;
  chainId: number;
  status: CoverageStatus;
  observationRef: string;
  instanceEnumeration: Completeness;
  instances: readonly ProductInstance[];
  workflowSet: Readonly<{
    status: 'complete' | 'incomplete' | 'explicitly_excluded';
    sourceRef: string;
    workflowIds: readonly string[];
    exclusionReason?: string;
  }>;
  activityMetrics?: readonly ActivityMetric[];
}>;

export type CoverageInput = Readonly<{
  schemaVersion: 1;
  snapshot: Readonly<{
    snapshotId: string;
    observedAt: string | null;
    captureTimeStatus: 'known' | 'unknown';
    captureTimeNote?: string;
    sourceRefs: readonly string[];
    eligibilityRule: Readonly<{ ruleId: string; description: string; sourceRefs: readonly string[] }>;
    scopeChains: readonly Readonly<{ chainId: number; enumeration: Completeness; sourceRefs: readonly string[] }>[];
  }>;
  products: readonly Readonly<{
    productId: string;
    label: string;
    categoryId: string;
    countingRole: 'coverage_unit' | 'lineage_only';
    expectedScopeChainIds: readonly number[];
    chainInventoryCompleteness: Completeness;
    chainInventorySourceRef: string;
    parentProductId?: string;
}>[];
  workflowDefinitions: readonly CoreWorkflowDefinition[];
  activityMetricDefinitions: readonly ActivityMetricDefinition[];
  observations: readonly ProductChainObservation[];
  unresolvedUniverseRecords: readonly Readonly<{
    sourceRecordRef: string;
    chainId: number | null;
    categoryId?: string;
    reason: string;
  }>[];
}>;

export type CoverageInputError = Readonly<{ path: string; message: string }>;

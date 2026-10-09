import { buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import { executionScopeHash, NPM_MULTICALL_CHILD_SIGNATURES } from '../execution/scope';
import type { CoverageInput, CoverageManifestCapability, ProductChainObservation, RequiredCapability } from './types';

type Obj = Record<string, any>;
export type V3Sources = Readonly<{
  baseInput: CoverageInput;
  m1Catalog: Obj;
  m2Catalog: Obj;
  v3Catalog: Obj;
  workflowExtensions: Obj;
  frozenEvidence: Readonly<Record<string, unknown>>;
  sourceDigests: Readonly<Record<string, string>>;
}>;

export type V3Projection = Readonly<{
  input: CoverageInput;
  capabilities: readonly CoverageManifestCapability[];
  workflowInventory: V3WorkflowInventory;
  normalizationEvidence: Readonly<Record<string, unknown>>;
}>;

export type V3WorkflowInventory = Readonly<{
  summary: Readonly<Record<string, unknown>>;
  v3CatalogManifestHash: string;
  scopedWorkflowBundles: readonly Readonly<{
    family: string;
    identityMapping: Readonly<{ status: string }>;
    completionScope: string;
  }>[];
  [key: string]: unknown;
}>;

type V3WorkflowBundle = Readonly<{
  family: string;
  identityMapping: Readonly<{ status: string; [key: string]: unknown }>;
  completionScope: string;
  requiredCapabilities: readonly unknown[];
  executionScopes: readonly unknown[];
  [key: string]: unknown;
}>;

const NPM_TARGETS = new Set(['refundETH()', 'unwrapWETH9(uint256,address)', 'sweepToken(address,uint256,address)', 'multicall(bytes[])']);
const NPM_CORE = Object.freeze([
  'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
  'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))',
  'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  'collect((uint256,address,uint128,uint128))', 'burn(uint256)',
  'refundETH()', 'unwrapWETH9(uint256,address)', 'sweepToken(address,uint256,address)', 'multicall(bytes[])',
]);
const MORPHO_INDEX: Readonly<Record<string, number>> = Object.freeze({
  'supply((address,address,address,address,uint256),uint256,uint256,address,bytes)': 4,
  'supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)': 3,
  'repay((address,address,address,address,uint256),uint256,uint256,address,bytes)': 4,
});

function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function binding(fn: Obj): RequiredCapability {
  return { capabilityId: fn.capabilityId, chainId: fn.chainId, contract: fn.contract.toLowerCase(), signature: fn.signature, abiHash: functionAbiHash(fn as never) };
}
function asCoverageCapabilities(capabilities: readonly Obj[]): CoverageManifestCapability[] {
  return capabilities.map((fn) => ({ capabilityId: fn.capabilityId, status: fn.status, type: fn.type, chainId: fn.chainId, contract: fn.contract.toLowerCase(), signature: fn.signature, abiHash: functionAbiHash(fn as never), provenance: fn.provenance }));
}

/** Offline v3 projection. It validates source-closed scopes but never changes market identity/activity evidence. */
export function adaptV3Coverage(sources: V3Sources): V3Projection {
  const { baseInput, v3Catalog, workflowExtensions, sourceDigests } = sources;
  if (!baseInput || baseInput.schemaVersion !== 1 || baseInput.unresolvedUniverseRecords.length !== 8_472) throw new Error('V3 adapter requires the unchanged M2 unresolved source universe');
  const m2Report = sources.frozenEvidence.m2CoverageReport as Obj | undefined;
  const m2Evidence = sources.frozenEvidence.m2NormalizationEvidence as Obj | undefined;
  const m2Activity = sources.frozenEvidence.m2ActivityMethods as Obj | undefined;
  if (m2Report?.inputFingerprint !== 'sha256:042fbbb49407776d9e3b257d908f3dbb52045d9a7dac90bf1347e9524f8796a7' || m2Report.products?.activeProducts !== 3 || m2Report.unresolvedUniverseRecordRows !== 8_472 || m2Evidence?.rawRosterRecords !== 8_476 || (m2Evidence?.unmatchedMetricIds as unknown[])?.length !== 7) throw new Error('Frozen M2 identity/activity disposition is missing or changed');
  const compoundFees = (m2Activity?.methods as Obj[] | undefined)?.find((method) => (method.sourceIds ?? []).includes('114'));
  if (!compoundFees || compoundFees.methodId !== 'compound-v2-borrow-interest-fees-unqualified-v1' || compoundFees.qualifiesAsUserActivity !== false) throw new Error('M2 Compound V2 fee-only activity must remain unresolved and unqualified');
  if (v3Catalog?.schemaVersion !== 1 || !Array.isArray(v3Catalog.chains) || workflowExtensions?.schemaVersion !== 1 || !Array.isArray(workflowExtensions.families)) throw new Error('Invalid v3 catalog or workflow extension source snapshot');

  const m1 = buildReviewedManifest([{ chains: sources.m1Catalog.chains }]);
  if (m1.capabilities.length !== 202) throw new Error('Frozen M1 authority must remain complete at 202 functions');
  const m2 = buildReviewedManifest([{ chains: sources.m2Catalog.chains }]);
  if (m2.capabilities.length !== 315) throw new Error('Frozen M2 catalog must retain its complete 315-function authority');
  const v3 = buildReviewedManifest([{ chains: v3Catalog.chains }]);
  if (v3.capabilities.length !== 349) throw new Error('V3 catalog must contain the unchanged M2 authority plus 34 scoped additions');
  const oldById = new Map(m2.capabilities.map((fn) => [fn.capabilityId, fn]));
  const v3ById = new Map(v3.capabilities.map((fn) => [fn.capabilityId, fn]));
  const v2ById = new Map(m2.capabilities.map((fn) => [fn.capabilityId, fn]));
  for (const baseline of m1.capabilities) {
    const retained = v2ById.get(baseline.capabilityId);
    if (!retained || retained.chainId !== baseline.chainId || retained.contract.toLowerCase() !== baseline.contract.toLowerCase() || retained.signature !== baseline.signature || functionAbiHash(retained) !== functionAbiHash(baseline) || !!retained.executionScope) throw new Error(`V2 changed frozen M1 authority: ${baseline.capabilityId}`);
  }
  for (const old of m2.capabilities) {
    const current = v3ById.get(old.capabilityId);
    if (!current || current.chainId !== old.chainId || current.contract.toLowerCase() !== old.contract.toLowerCase() || current.signature !== old.signature || functionAbiHash(current) !== functionAbiHash(old) || !!current.executionScope) throw new Error(`V3 changed or removed frozen M2 authority: ${old.capabilityId}`);
  }
  const additions = v3.capabilities.filter((fn) => !oldById.has(fn.capabilityId));
  if (additions.length !== 34) throw new Error('Expected exactly 34 new v3 source-bound function definitions');

  const families = workflowExtensions.families as Obj[];
  const npmFamily = families.find((family) => family.familyId === 'uniswap-v3-position-manager');
  const morphoFamily = families.find((family) => family.familyId === 'morpho-blue');
  if (!npmFamily || !morphoFamily || npmFamily.contracts?.length !== 7 || morphoFamily.contracts?.length !== 2) throw new Error('V3 source inventory must retain seven NPM and two Morpho deployment records');
  const distinctSourceRefs = new Set(families.flatMap((family) => (family.contracts as Obj[]).flatMap((contract) => contract.sourceRefs as string[])));
  if (distinctSourceRefs.size !== 18 || families.some((family) => (family.contracts as Obj[]).some((contract) => !Array.isArray(contract.sourceRefs) || contract.sourceRefs.length === 0))) throw new Error('V3 workflow extension source references are incomplete');
  const sourceFunctionRows = families.reduce((sum, family) => sum + (family.contracts as Obj[]).reduce((perFamily, contract) => perFamily + (contract.abiFunctions as Obj[]).length, 0), 0);
  if (sourceFunctionRows !== 69 || npmFamily.contracts.some((contract: Obj) => (contract.abiFunctions as Obj[]).length !== 9) || morphoFamily.contracts.some((contract: Obj) => (contract.abiFunctions as Obj[]).length !== 3)) throw new Error('V3 source snapshot must preserve 69 records including the 35 repeated M2 NPM records');
  const sourceAbi = new Map<string, Obj>();
  for (const family of families) for (const contract of family.contracts as Obj[]) for (const abi of contract.abiFunctions as Obj[]) {
    const signature = abiSignature(abi);
    const key = `${contract.chainId}:${contract.address.toLowerCase()}:${signature}`;
    if (sourceAbi.has(key)) {
      if (functionAbiHash({ abi: abi as never }) !== functionAbiHash({ abi: sourceAbi.get(key) as never })) throw new Error(`Conflicting duplicate v3 source ABI: ${key}`);
    } else sourceAbi.set(key, abi);
  }
  for (const fn of additions) {
    const abi = sourceAbi.get(`${fn.chainId}:${fn.contract.toLowerCase()}:${fn.signature}`);
    if (!abi || functionAbiHash(fn) !== functionAbiHash({ abi: abi as never }) || fn.status !== 'active' || fn.provenance.status !== 'verified') throw new Error(`V3 addition lacks exact source/ABI admission evidence: ${fn.capabilityId}`);
  }
  const expectedNew = new Set<string>();
  for (const contract of npmFamily.contracts as Obj[]) for (const signature of NPM_TARGETS) expectedNew.add(`${contract.chainId}:${contract.address.toLowerCase()}:${signature}`);
  for (const contract of morphoFamily.contracts as Obj[]) for (const signature of Object.keys(MORPHO_INDEX)) expectedNew.add(`${contract.chainId}:${contract.address.toLowerCase()}:${signature}`);
  if (expectedNew.size !== 34 || additions.some((fn) => !expectedNew.has(`${fn.chainId}:${fn.contract.toLowerCase()}:${fn.signature}`)) || expectedNew.size !== additions.length) throw new Error('V3 additions do not match the exact scoped NPM/Morpho source function set');

  const workflowBundles: V3WorkflowBundle[] = [];
  const definitions = [...baseInput.workflowDefinitions];
  const observations: Obj[] = baseInput.observations.map((row) => ({ ...row, instances: row.instances.map((instance) => ({ ...instance, workflowClaims: [...instance.workflowClaims] })), workflowSet: { ...row.workflowSet, workflowIds: [...row.workflowSet.workflowIds] } }));
  const npmProductId = 'raw-provider:2198';
  const npmInventory = sources.frozenEvidence.workflowInventory as Obj | undefined;
  const canonicalNpm = npmInventory?.products?.find((product: Obj) => product.sourceId === '2198');
  if (!canonicalNpm || canonicalNpm.identityStatus !== 'canonical') throw new Error('NPM function progress requires the frozen exact Uniswap V3 identity bridge');
  for (const contract of npmFamily.contracts as Obj[]) {
    const chainId = contract.chainId as number;
    const target = String(contract.address).toLowerCase();
    const funcs = NPM_CORE.map((signature) => findCapability(v3.capabilities, chainId, target, signature));
    const wrapper = funcs.find((fn) => fn.signature === 'multicall(bytes[])')!;
    const scope: any = wrapper.executionScope;
    if (!scope || scope.kind !== 'same-target-multicall-v1' || scope.bytesArrayArgIndex !== 0 || scope.allowedChildren.length !== 8) throw new Error(`NPM wrapper has missing or changed finite child scope on chain ${chainId}`);
    const scopeHash = executionScopeHash(scope);
    validateExactChildren(scope.allowedChildren, funcs, chainId, target);
    const id = `m3:v3:npm:${chainId}:helpers-and-closed-multicall`;
    const requiredCapabilities = funcs.map(binding);
    definitions.push({ workflowId: id, productId: npmProductId, chainId, sourceRef: `data/defi-catalog/v3/sources/workflow-extensions.json#uniswap-v3-position-manager:${chainId}`, requirementStatus: 'resolved', requiredCapabilities });
    const row = observations.find((observation) => observation.productId === npmProductId && observation.chainId === chainId);
    if (!row) throw new Error(`Frozen M2 NPM chain observation missing: ${chainId}`);
    row.workflowSet.workflowIds = [...row.workflowSet.workflowIds, id].sort(cmp);
    row.instances = [...row.instances, { instanceId: `m3-target:${chainId}:${target}`, workflowClaims: [{ workflowId: id, status: 'supported', sourceRef: `data/defi-catalog/v3/sources/workflow-extensions.json#${chainId}:${target}`, admittedCapabilityIds: requiredCapabilities.map((required) => required.capabilityId) }] }];
    workflowBundles.push({ workflowId: id, family: 'uniswap-v3-position-manager', chainId, target, identityMapping: { status: 'canonical-product-target-evidence', sourceId: '2198', sourceRef: canonicalNpm.identityEvidenceRef }, completionScope: 'these nine exact target-bound function roles only; not all token populations, user approvals, all core workflows, or whole-product completeness', status: 'target-scoped-functions-admitted', requiredCapabilities: requiredCapabilities.map((required) => ({ ...required, ...(funcs.find((fn) => fn.capabilityId === required.capabilityId)?.executionScope ? { executionScopeHash: executionScopeHash(funcs.find((fn) => fn.capabilityId === required.capabilityId)!.executionScope) } : {}) })), executionScopes: [{ capabilityId: wrapper.capabilityId, kind: scope.kind, hash: scopeHash, allowedChildren: scope.allowedChildren.map((child: Obj) => ({ ...child })) }], unresolvedProductDimensions: ['complete token/asset population', 'approval availability and user-selected grants', 'all user workflows and full-product completeness'] });
  }

  const morphoProductId = 'lineage-only:morpho-blue-scope-candidate';
  const morphoChains = (morphoFamily.contracts as Obj[]).map((contract) => contract.chainId as number).sort((a, b) => a - b);
  const morphoRef = 'data/defi-catalog/v3/sources/workflow-extensions.json#morpho-blue';
  const inputProducts = [...baseInput.products, { productId: morphoProductId, label: 'Morpho Blue source-scope candidate (not an independently mapped market product)', categoryId: 'lending-yield', countingRole: 'lineage_only' as const, expectedScopeChainIds: morphoChains, chainInventoryCompleteness: 'incomplete' as const, chainInventorySourceRef: morphoRef }];
  for (const contract of morphoFamily.contracts as Obj[]) {
    const chainId = contract.chainId as number;
    const target = String(contract.address).toLowerCase();
    const funcs = Object.keys(MORPHO_INDEX).map((signature) => findCapability(v3.capabilities, chainId, target, signature));
    const rows = funcs.map((fn) => {
      const scope = fn.executionScope;
      const expectedIndex = MORPHO_INDEX[fn.signature];
      if (!scope || scope.kind !== 'empty-callback-data-v1' || scope.bytesArgIndex !== expectedIndex || fn.abi.inputs[expectedIndex]?.type !== 'bytes') throw new Error(`Morpho callback-free scope is missing or mismatched: ${fn.capabilityId}`);
      return { ...binding(fn), executionScopeHash: executionScopeHash(scope), kind: scope.kind, bytesArgIndex: scope.bytesArgIndex };
    });
    const id = `m3:v3:morpho-blue:${chainId}:empty-callback-standard-methods`;
    definitions.push({ workflowId: id, productId: morphoProductId, chainId, sourceRef: morphoRef, requirementStatus: 'resolved', requiredCapabilities: funcs.map(binding) });
    observations.push({ productId: morphoProductId, chainId, status: 'unresolved', observationRef: `${morphoRef}:${chainId}:${target}`, instanceEnumeration: 'incomplete', instances: [{ instanceId: `source-target:${chainId}:${target}`, workflowClaims: [{ workflowId: id, status: 'supported', sourceRef: `${morphoRef}:${chainId}:${target}`, admittedCapabilityIds: funcs.map((fn) => fn.capabilityId) }] }], workflowSet: { status: 'incomplete', sourceRef: morphoRef, workflowIds: [id] } });
    workflowBundles.push({ workflowId: id, family: 'morpho-blue', chainId, target, identityMapping: { status: 'lineage-only-unverified-market-crosswalk', rawSourceId: '4025', rawSourceMappingClaim: false }, completionScope: 'three fixed methods with exact empty bytes callback rule only; not canonical product identity, market existence, liquidity, or whole-product completeness', status: 'target-scoped-functions-admitted', requiredCapabilities: rows, executionScopes: rows.map(({ capabilityId, kind, executionScopeHash, bytesArgIndex }) => ({ capabilityId, kind, hash: executionScopeHash, bytesArgIndex })), unresolvedProductDimensions: ['independent canonical market-product mapping', 'market identity/enumeration', 'asset/instance population and complete workflow inventory'] });
  }

  const v3Digest = sourceDigests['data/defi-catalog/v3/catalog.json'];
  if (!v3Digest) throw new Error('Missing v3 catalog digest');
  const extensionRef = `data/defi-catalog/v3/sources/workflow-extensions.json#sha256=${sourceDigests['data/defi-catalog/v3/sources/workflow-extensions.json']}`;
  const input: CoverageInput = {
    ...baseInput,
    snapshot: { ...baseInput.snapshot, snapshotId: `${baseInput.snapshot.snapshotId}-m3-v3-workflow-scope`, sourceRefs: [...baseInput.snapshot.sourceRefs, `data/defi-catalog/v3/catalog.json#sha256=${v3Digest}`, extensionRef] },
    products: inputProducts,
    workflowDefinitions: definitions,
    observations: observations as ProductChainObservation[],
  };
  const capabilities = asCoverageCapabilities(v3.capabilities);
  const workflowInventory: V3WorkflowInventory = {
    schemaVersion: 1,
    v3CatalogManifestHash: v3.manifestHash,
    sourceRefs: Object.entries(sourceDigests).filter(([path]) => path.includes('/v2/') || path.includes('/v3/')).map(([path, digest]) => `${path}#sha256=${digest}`),
    m2Authority: { capabilityCount: m2.capabilities.length, preservedCapabilities: m2.capabilities.length, manifestHash: m2.manifestHash, addedCapabilityCount: additions.length },
    scopedWorkflowBundles: workflowBundles,
    summary: { m2WorkflowDefinitionsPreserved: baseInput.workflowDefinitions.length, m2WorkflowCapabilityReferencesPreserved: baseInput.workflowDefinitions.reduce((sum, row) => sum + row.requiredCapabilities.length, 0), npmBundles: npmFamily.contracts.length, morphoLineageOnlyBundles: morphoFamily.contracts.length, targetScopedWorkflowBundles: workflowBundles.length, distinctNewFunctionBindings: additions.length, newNpmFunctionBindings: NPM_TARGETS.size * npmFamily.contracts.length, newMorphoFunctionBindings: Object.keys(MORPHO_INDEX).length * morphoFamily.contracts.length, scopeBindings: workflowBundles.reduce((sum, row) => sum + row.executionScopes.length, 0), requiredCapabilityReferences: workflowBundles.reduce((sum, row) => sum + row.requiredCapabilities.length, 0), duplicateNpmSourceRowsPreserved: 35, rawRosterRowsPreserved: m2Evidence!.rawRosterRecords, unresolvedRawRosterRowsPreserved: baseInput.unresolvedUniverseRecords.length, rawRosterRecordsAreCanonicalProducts: false, morphoRaw4025PromotedToCanonicalProduct: false, wholeProductCompletenessEstablished: false, marketActivityChanged: false },
    frozenM2Disposition: { inputFingerprint: m2Report.inputFingerprint, activeCanonicalProducts: m2Report.products.activeProducts, unresolvedRawUniverseRows: baseInput.unresolvedUniverseRecords.length, unmatchedMetricIds: (m2Evidence!.unmatchedMetricIds as unknown[]).length, mappedIdentityRows: (sources.frozenEvidence.m2IdentityCrosswalk as Obj | undefined)?.mappings?.length, compoundV2FeesQualifiedAsUserActivity: false, compoundV2MethodRecord: compoundFees },
    limitations: ['Target-scoped workflow/function progress is not a protocol, product, market-share, active-market, or complete-instance denominator.', 'M2 activity observations, M2 identity crosswalk, the 8,476-row raw universe, and seven unmatched metric IDs are copied without promotion or deletion.', 'M2 Compound V2 borrow-interest fee labels remain unresolved and are not activity evidence.', 'The 90% market objective remains false/unestablished.'],
  };
  const normalizationEvidence: Readonly<Record<string, unknown>> = { schemaVersion: 1, sourceDigests, v3CatalogManifestHash: v3.manifestHash, frozenM2ManifestHash: m2.manifestHash, frozenM2CapabilityCount: m2.capabilities.length, v3CapabilityCount: v3.capabilities.length, additions: additions.map((fn) => ({ capabilityId: fn.capabilityId, chainId: fn.chainId, contract: fn.contract, signature: fn.signature, abiHash: functionAbiHash(fn), executionScopeHash: fn.executionScope ? executionScopeHash(fn.executionScope) : null })), frozenUniverseRows: m2Evidence!.rawRosterRecords, unresolvedUniverseRecords: baseInput.unresolvedUniverseRecords.length, frozenUnmatchedMetricRecords: (sources.frozenEvidence.m2IdentityCrosswalk as Obj).unmatchedMetricRecords, originalSnapshotObservedAt: baseInput.snapshot.observedAt, m2WorkflowDefinitionsPreserved: baseInput.workflowDefinitions.length, m2ExactWorkflowBindingsPreserved: baseInput.workflowDefinitions.reduce((sum, row) => sum + row.requiredCapabilities.length, 0), marketMetricAndIdentityFilesMutated: false, objectiveEstablished: false };
  return { input, capabilities, workflowInventory, normalizationEvidence };
}

function findCapability(capabilities: readonly Obj[], chainId: number, target: string, signature: string): Obj {
  const matches = capabilities.filter((fn) => fn.status === 'active' && fn.type === 'contract_call' && fn.chainId === chainId && fn.contract.toLowerCase() === target && fn.signature === signature);
  if (matches.length !== 1) throw new Error(`Expected one exact active capability for ${chainId}:${target}:${signature}`);
  return matches[0];
}

function validateExactChildren(children: readonly Obj[], capabilities: readonly Obj[], chainId: number, target: string): void {
  const resolved = children.map((child) => findCapability(capabilities, chainId, target, child.signature));
  if (new Set(children.map((child) => child.capabilityId)).size !== 8 || resolved.some((fn) => !children.some((child) => child.capabilityId === fn.capabilityId && child.abiHash.toLowerCase() === functionAbiHash(fn as never)))) throw new Error('NPM scoped wrapper child references do not match all eight exact active same-target functions');
  if (NPM_MULTICALL_CHILD_SIGNATURES.some((signature) => !children.some((child) => child.signature === signature))) throw new Error('NPM wrapper child set is incomplete or contains unsupported scope');
}

function abiSignature(fn: Obj): string {
  if (!fn || fn.type !== 'function' || !Array.isArray(fn.inputs)) throw new Error('Invalid source ABI function');
  const param = (item: Obj): string => item.type.startsWith('tuple') ? `(${(item.components ?? []).map(param).join(',')})${item.type.slice(5)}` : item.type;
  return `${fn.name}(${fn.inputs.map(param).join(',')})`;
}

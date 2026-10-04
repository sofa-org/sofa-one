import { createHash } from 'node:crypto';
import { keccak256, stringToHex, toFunctionSelector } from 'viem';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;
export type StaticProfile = Readonly<{ bundleId: string; version: string; label: string; chainIds: readonly number[]; capabilityIds: readonly string[]; fingerprint: string; warnings: readonly string[]; limitations: readonly string[] }>;

export type AuditInputs = Readonly<{
  catalogVersion?: 'v3' | 'v4';
  market: JsonObject;
  classification: JsonObject;
  m1Catalog: JsonObject;
  m2Catalog: JsonObject;
  m3Catalog: JsonObject;
  admissions: JsonObject;
  workflowExtensions: JsonObject;
  m2Activity: JsonObject;
  m2ActivityMethods: JsonObject;
  m2Identity: JsonObject;
  m2Evidence: JsonObject;
  m2WorkflowInventory: JsonObject;
  m2Normalized: JsonObject;
  m3Normalized: JsonObject;
  m3WorkflowInventory: JsonObject;
  m3ComparisonReport: JsonObject;
  profiles: readonly StaticProfile[];
  v3ProfileFixture?: JsonObject;
  v3ProfileFixtureSha256?: string;
  currentV4Catalog?: JsonObject;
  currentV4Admissions?: JsonObject;
  currentV4OrdinarySource?: JsonObject;
  currentV4YearnSource?: JsonObject;
  currentV4Profiles?: readonly StaticProfile[];
  currentSourceRetrievedDates?: JsonObject;
  rawSha256: Readonly<Record<string, string>>;
  rawSourceContents?: Readonly<Record<string, string>>;
  protocolUniverseCompactSha256: string;
  auditAsOf: string;
}>;

export type GoalEvidence = Readonly<{
  targetBasisPoints: number;
  marketDenominator: number | null;
  marketDenominatorUnit: 'distinct-canonical-active-products';
  rawCanonicalDeduplicationDocumented: boolean;
  observedActiveProducts: number;
  fullySupportedProducts: number;
  blockers: readonly string[];
  objectiveEstablished: boolean;
}>;

type ScopeChild = Readonly<{ capabilityId: string; signature: string; abiHash: string }>;
type Scope = Readonly<{ kind: 'empty-callback-data-v1'; bytesArgIndex: number } | { kind: 'same-target-multicall-v1'; bytesArrayArgIndex: number; allowedChildren: readonly ScopeChild[] }>;
type FunctionRow = Readonly<{ capabilityId: string; chainId: number; contract: string; functionName: string; signature: string; type: string; status: string; abi: JsonObject; provenance?: JsonObject; executionScope?: Scope; [key: string]: JsonValue | Scope | undefined }>;
type ContractRow = Readonly<{ address: string; status: string; functions: readonly FunctionRow[] }>;
type ChainRow = Readonly<{ chainId: number; status: string; contracts: readonly ContractRow[] }>;

const cmp = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const NPM_CHILD_SIGNATURES = Object.freeze([
  'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
  'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))',
  'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  'collect((uint256,address,uint128,uint128))', 'burn(uint256)', 'refundETH()',
  'unwrapWETH9(uint256,address)', 'sweepToken(address,uint256,address)',
]);
const CALLBACK_INDEX: Readonly<Record<string, number>> = Object.freeze({
  'supply((address,address,address,address,uint256),uint256,uint256,address,bytes)': 4,
  'supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)': 3,
  'repay((address,address,address,address,uint256),uint256,uint256,address,bytes)': 4,
});
const TARGET_BPS = 9_000;
const CURRENT_AS_OF = '2026-10-04T00:26:00Z';
const V3_PROFILE_FIXTURE_SHA256 = 'f5f06ce93f46bf2ddf8554da6b9efb7db9b1a8175cd19b40dc69c454f873a607';
const V3_PROFILE_SOURCE_BYTES_SHA256 = '8655bc24a6ce3f9605716e718c7bb30750c6531a0d8091f2d8762b457eab05d9';
const V3_PROFILE_FIXTURE_COMMIT = 'e453acde073554d31d4e1ceb46f429c2191e1dfa';
const V3_PROFILE_IDS = Object.freeze([
  'uniswap-v3-positions-1', 'uniswap-v3-positions-10', 'uniswap-v3-positions-56', 'uniswap-v3-positions-137',
  'uniswap-v3-positions-143', 'uniswap-v3-positions-8453', 'uniswap-v3-positions-42161', 'morpho-blue-1', 'morpho-blue-8453',
]);
const V4_SOURCE_PATHS = Object.freeze(['data/defi-catalog/v4/sources/ordinary-protocols.json', 'data/defi-catalog/v4/sources/yearn.json']);
const V4_EXPECTED_PROFILE_IDS = Object.freeze(['curve-3pool-1', 'pancakeswap-v3-positions-56', 'yearn-tokenized-strategy-1']);
const V4_BATCH_TARGETS = Object.freeze({
  'curve-3pool-stableswap': { chainId: 1, address: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', sourcePath: V4_SOURCE_PATHS[0], familyVersion: 'curve-contract-574f440' },
  'pancakeswap-v3-position-manager': { chainId: 56, address: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364', sourcePath: V4_SOURCE_PATHS[0], familyVersion: 'pancake-v3-contracts-9868479' },
  'yearn-tokenized-strategy': { chainId: 1, address: '0x074134a2784f4f66b6ced6f68849382990ff3215', sourcePath: V4_SOURCE_PATHS[1], familyVersion: 'tokenized-strategy-v3.0.4' },
});
const CURVE_SIGNATURES = Object.freeze(['add_liquidity(uint256[3],uint256)', 'exchange(int128,int128,uint256,uint256)', 'remove_liquidity(uint256,uint256[3])', 'remove_liquidity_one_coin(uint256,int128,uint256)']);
const YEARn_SIGNATURES = Object.freeze(['deposit(uint256,address)', 'mint(uint256,address)', 'withdraw(uint256,address,address)', 'withdraw(uint256,address,address,uint256)', 'redeem(uint256,address,address)', 'redeem(uint256,address,address,uint256)']);

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(cmp).map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Recompute the frozen protocol-array digest from its original JSON lexemes, preserving large numeric tokens. */
export function compactArrayPropertyHash(sourceText: string, property: string): string {
  const marker = `"${property}"`;
  const keyAt = sourceText.indexOf(marker);
  if (keyAt < 0) throw new Error(`Missing source array ${property}`);
  let start = sourceText.indexOf(':', keyAt + marker.length) + 1;
  while (/\s/.test(sourceText[start] ?? '')) start++;
  if (sourceText[start] !== '[') throw new Error(`Expected array ${property}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < sourceText.length; index++) {
    const char = sourceText[index]!;
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
  if (end < 0) throw new Error(`Unterminated source array ${property}`);
  const raw = sourceText.slice(start, end);
  let compact = '';
  inString = false;
  escaped = false;
  for (const char of raw) {
    if (inString) {
      compact += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') { compact += char; inString = true; }
    else if (!/\s/.test(char)) compact += char;
  }
  return sha256(compact);
}

function parseLiteralArrayAfter(sourceText: string, marker: string): JsonValue[] {
  const markerAt = sourceText.indexOf(marker);
  if (markerAt < 0) throw new Error(`Missing literal array marker: ${marker}`);
  const start = sourceText.indexOf('[', markerAt + marker.length);
  if (start < 0) throw new Error(`Missing literal array after ${marker}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < sourceText.length; index++) {
    const char = sourceText[index]!;
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
  if (end < 0) throw new Error(`Unterminated literal array after ${marker}`);
  const parsed: unknown = JSON.parse(sourceText.slice(start, end));
  if (!Array.isArray(parsed)) throw new Error(`Expected literal array after ${marker}`);
  return parsed as JsonValue[];
}

function canonicalAbiHash(abi: JsonObject): string { return keccak256(stringToHex(stableJson([abi]))); }

function signatureFor(abi: JsonObject): string {
  const inputs = Array.isArray(abi.inputs) ? abi.inputs as JsonObject[] : [];
  const type = (parameter: JsonObject): string => {
    const label = String(parameter.type ?? '');
    if (!label.startsWith('tuple')) return label;
    const components = Array.isArray(parameter.components) ? parameter.components as JsonObject[] : [];
    return `(${components.map(type).join(',')})${label.slice('tuple'.length)}`;
  };
  return `${String(abi.name)}(${inputs.map(type).join(',')})`;
}

function flattenCatalog(document: JsonObject): FunctionRow[] {
  if (!Array.isArray(document.chains)) throw new Error('Catalog must have chains');
  const all: FunctionRow[] = [];
  const ids = new Set<string>();
  const selectors = new Set<string>();
  for (const chainValue of document.chains) {
    const chain = chainValue as unknown as ChainRow;
    if (!Number.isSafeInteger(chain.chainId) || chain.chainId < 1 || !Array.isArray(chain.contracts)) throw new Error('Malformed chain catalog');
    for (const contract of chain.contracts) {
      if (!/^0x[0-9a-f]{40}$/i.test(contract.address) || !Array.isArray(contract.functions)) throw new Error('Malformed contract catalog');
      for (const fn of contract.functions) {
        if (fn.chainId !== chain.chainId || fn.contract.toLowerCase() !== contract.address.toLowerCase() || !fn.capabilityId || ids.has(fn.capabilityId)) throw new Error(`Catalog identity collision/inconsistency: ${fn.capabilityId}`);
        if (signatureFor(fn.abi) !== fn.signature || fn.abi.name !== fn.functionName || fn.abi.type !== 'function') throw new Error(`Signature/ABI mismatch: ${fn.capabilityId}`);
        if (fn.status === 'active' && object(fn.provenance).status !== 'verified') throw new Error(`Active catalog function lacks verified provenance: ${fn.capabilityId}`);
        const selector = `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature).toLowerCase()}`;
        if (selectors.has(selector)) throw new Error(`Selector collision: ${fn.capabilityId}`);
        selectors.add(selector); ids.add(fn.capabilityId); all.push(fn);
      }
    }
  }
  return all;
}

function capabilityIdentity(fn: FunctionRow): JsonObject {
  const identity: JsonObject = { capabilityId: fn.capabilityId, type: fn.type as JsonValue, chainId: fn.chainId as JsonValue, contract: fn.contract.toLowerCase(), signature: fn.signature, abiHash: canonicalAbiHash(fn.abi), status: fn.status };
  if (fn.executionScope) identity.executionScopeHash = scopeHash(fn.executionScope);
  return identity;
}

function scopeHash(scope: Scope): string {
  if (scope.kind === 'empty-callback-data-v1') return keccak256(stringToHex(JSON.stringify({ kind: scope.kind, bytesArgIndex: scope.bytesArgIndex })));
  const allowedChildren = [...scope.allowedChildren].map((child) => ({ capabilityId: child.capabilityId, signature: child.signature, abiHash: child.abiHash.toLowerCase() })).sort((a, b) => cmp(a.capabilityId, b.capabilityId) || cmp(a.signature, b.signature) || cmp(a.abiHash, b.abiHash));
  return keccak256(stringToHex(JSON.stringify({ kind: scope.kind, bytesArrayArgIndex: 0, allowedChildren })));
}

function functionIndex(functions: readonly FunctionRow[]): Map<string, FunctionRow> { return new Map(functions.map((fn) => [fn.capabilityId, fn])); }
function object(value: JsonValue | undefined): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
function array(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : []; }
function recordCount(value: JsonValue | undefined): number { return Array.isArray(value) ? value.length : 0; }
function number(value: JsonValue | undefined): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

export function evaluateGoalClosure(input: Readonly<{
  rawUniverseCount: number;
  unresolvedIdentityProxyCount: number;
  unmatchedIdentityCount: number;
  canonicalProductCount: number;
  activeProductCount: number;
  fullySupportedProductCount: number;
  chainsEnumerated: boolean;
  activityComplete: boolean;
  workflowsComplete: boolean;
  instancesComplete: boolean;
  rawCanonicalDeduplicationDocumented?: boolean;
  targetBasisPoints?: number;
}>): GoalEvidence {
  const blockers: string[] = [];
  const counts = [input.rawUniverseCount, input.unresolvedIdentityProxyCount, input.unmatchedIdentityCount, input.canonicalProductCount, input.activeProductCount, input.fullySupportedProductCount];
  const countsValid = counts.every((count) => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(input.targetBasisPoints ?? TARGET_BPS) && (input.targetBasisPoints ?? TARGET_BPS) > 0 && (input.targetBasisPoints ?? TARGET_BPS) <= 10_000;
  if (!countsValid || input.fullySupportedProductCount > input.activeProductCount || input.activeProductCount > input.canonicalProductCount) blockers.push('invalid_independent_product_accounting');
  if (input.unresolvedIdentityProxyCount > 0) blockers.push('unresolved_identity_proxy_universe');
  if (input.unmatchedIdentityCount > 0) blockers.push('unmatched_identity_records');
  if (input.rawCanonicalDeduplicationDocumented !== true) blockers.push('raw_canonical_population_equivalence_not_documented');
  if (!input.chainsEnumerated) blockers.push('chain_enumeration_incomplete');
  if (!input.activityComplete) blockers.push('activity_evidence_incomplete');
  if (!input.workflowsComplete) blockers.push('core_workflow_requirements_incomplete');
  if (!input.instancesComplete) blockers.push('product_instance_enumeration_incomplete');
  if (input.activeProductCount === 0) blockers.push('no_active_products_for_coverage_ratio');
  const identityPopulationClosed = input.unresolvedIdentityProxyCount === 0 && input.unmatchedIdentityCount === 0
    && input.canonicalProductCount > 0 && input.rawCanonicalDeduplicationDocumented === true
    && input.canonicalProductCount <= input.rawUniverseCount;
  const closed = blockers.length === 0 && identityPopulationClosed;
  const marketDenominator = closed && input.activeProductCount > 0 ? input.activeProductCount : null;
  if (!closed) blockers.push('market_denominator_not_independently_closed');
  const targetBasisPoints = input.targetBasisPoints ?? TARGET_BPS;
  const objectiveEstablished = marketDenominator !== null
    && BigInt(input.fullySupportedProductCount) * 10_000n >= BigInt(targetBasisPoints) * BigInt(marketDenominator);
  return {
    targetBasisPoints,
    marketDenominator,
    marketDenominatorUnit: 'distinct-canonical-active-products',
    rawCanonicalDeduplicationDocumented: input.rawCanonicalDeduplicationDocumented === true,
    observedActiveProducts: input.activeProductCount,
    fullySupportedProducts: input.fullySupportedProductCount,
    blockers,
    objectiveEstablished,
  };
}

function verifyCatalogs(inputs: AuditInputs): JsonObject {
  const m1 = flattenCatalog(inputs.m1Catalog);
  const m2 = flattenCatalog(inputs.m2Catalog);
  const m3 = flattenCatalog(inputs.m3Catalog);
  const m1Map = functionIndex(m1), m2Map = functionIndex(m2), m3Map = functionIndex(m3);
  const m1Preserved = m1.every((fn) => stableJson(fn) === stableJson(m2Map.get(fn.capabilityId)));
  const m2Preserved = m2.every((fn) => stableJson(fn) === stableJson(m3Map.get(fn.capabilityId)));
  const additions = m3.filter((fn) => !m2Map.has(fn.capabilityId));
  const scopes = m3.filter((fn) => fn.executionScope);
  const extensionFamilies = array(inputs.workflowExtensions.families).map((x) => x as unknown as JsonObject);
  const extensionRows: { family: string; chainId: number; address: string; abi: JsonObject }[] = [];
  for (const family of extensionFamilies) for (const contractValue of array(family.contracts)) {
    const contract = contractValue as unknown as JsonObject;
    for (const abiValue of array(contract.abiFunctions)) extensionRows.push({ family: String(family.familyId), chainId: Number(contract.chainId), address: String(contract.address).toLowerCase(), abi: abiValue as JsonObject });
  }
  const sourceBound = extensionRows.every((row) => {
    const sig = signatureFor(row.abi);
    return m3.some((fn) => fn.chainId === row.chainId && fn.contract.toLowerCase() === row.address && fn.signature === sig && canonicalAbiHash(fn.abi) === canonicalAbiHash(row.abi));
  });
  const expected = new Set(extensionRows.filter((row) => !m2.some((fn) => fn.chainId === row.chainId && fn.contract.toLowerCase() === row.address && fn.signature === signatureFor(row.abi))).map((row) => `${row.chainId}:${row.address}:${signatureFor(row.abi)}`));
  const additionsBound = additions.length === 34 && additions.every((fn) => expected.has(`${fn.chainId}:${fn.contract.toLowerCase()}:${fn.signature}`));
  const wrapperFunctions = scopes.filter((fn) => fn.executionScope?.kind === 'same-target-multicall-v1');
  const callbackFunctions = scopes.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1');
  const scopeChecks = scopes.every((fn) => {
    const scope = fn.executionScope;
    if (!scope) return true;
    if (scope.kind === 'empty-callback-data-v1') return scope.bytesArgIndex === CALLBACK_INDEX[fn.signature] && fn.abi.stateMutability === 'nonpayable' && (Array.isArray(fn.abi.inputs) ? (fn.abi.inputs[scope.bytesArgIndex] as JsonObject | undefined)?.type : undefined) === 'bytes';
    if (fn.signature !== 'multicall(bytes[])' || scope.bytesArrayArgIndex !== 0 || scope.allowedChildren.length !== 8 || fn.status !== 'active' || fn.abi.stateMutability !== 'payable') return false;
    const sameTargetChildren = scope.allowedChildren.map((child) => m3.find((item) => item.capabilityId === child.capabilityId));
    return sameTargetChildren.every((child, i) => {
      const binding = scope.allowedChildren[i]!;
      return !!child && child.status === 'active' && child.type === 'contract_call' && child.chainId === fn.chainId && child.contract.toLowerCase() === fn.contract.toLowerCase() && child.signature === binding.signature && canonicalAbiHash(child.abi) === binding.abiHash.toLowerCase() && NPM_CHILD_SIGNATURES.includes(child.signature) && !child.executionScope;
    }) && new Set(scope.allowedChildren.map((child) => child.capabilityId)).size === 8 && NPM_CHILD_SIGNATURES.every((signature) => scope.allowedChildren.some((child) => child.signature === signature));
  });
  const catalogHash = keccak256(stringToHex(stableJson(m3.map(capabilityIdentity).sort((a, b) => cmp(String(a.capabilityId), String(b.capabilityId))))));
  const sourceAdmission = verifyAdmission(inputs, additions, m3);
  return {
    m1FunctionCount: m1.length, m2FunctionCount: m2.length, v3FunctionCount: m3.length,
    m1BaselineCompletelyRetained: m1.length === 202 && m1Preserved,
    m2AuthorityCompletelyRetained: m2.length === 315 && m2Preserved,
    v3AdditionCount: additions.length, exactV3AdditionsSourceBound: additionsBound && sourceBound && Number(sourceAdmission.unadmittedAdditions) === 0,
    v3CatalogManifestHash: catalogHash, publishedV3ManifestHash: string(inputs.m3WorkflowInventory.v3CatalogManifestHash),
    scopeCount: scopes.length, wrapperScopeCount: wrapperFunctions.length, callbackScopeCount: callbackFunctions.length,
    finiteScopeBindingsValid: scopeChecks && wrapperFunctions.length === 7 && callbackFunctions.length === 6,
    admission: sourceAdmission,
    sourceFunctionRows: extensionRows.length,
    repeatedNpmSourceRows: extensionRows.filter((row) => row.family === 'uniswap-v3-position-manager' && m2.some((fn) => fn.chainId === row.chainId && fn.contract.toLowerCase() === row.address && fn.signature === signatureFor(row.abi))).length,
    activeFunctionCount: m3.filter((fn) => fn.status === 'active').length,
    inactiveCandidateCount: m3.filter((fn) => fn.status !== 'active').length,
  };
}

function verifyAdmission(inputs: AuditInputs, additions: readonly FunctionRow[], capabilities: readonly FunctionRow[]): JsonObject {
  const snapshots = array(inputs.admissions.snapshots).map((x) => x as unknown as JsonObject);
  const admissionSourceHash = sha256(stableJson(inputs.workflowExtensions));
  const bindingRows = snapshots.flatMap((snapshot) => array(snapshot.bindings).map((x) => ({ snapshot, binding: x as unknown as JsonObject })));
  const catalogByIdentity = new Map(capabilities.map((fn) => [`${fn.chainId}:${fn.contract.toLowerCase()}:${fn.signature}`, fn]));
  const bindingKey = ({ snapshot, binding }: { snapshot: JsonObject; binding: JsonObject }): string => `${String(snapshot.sourcePath)}:${Number(binding.chainId)}:${String(binding.contract).toLowerCase()}:${String(binding.signature)}`;
  const sourceFunctionRows = array(inputs.workflowExtensions.families).flatMap((familyValue) => array(object(familyValue).contracts).flatMap((contractValue) => array(object(contractValue).abiFunctions).map((abiValue) => ({
    family: String(object(familyValue).familyId), chainId: Number(object(contractValue).chainId), contract: String(object(contractValue).address).toLowerCase(), abi: abiValue as JsonObject,
  }))));
  const expectedBindings = sourceFunctionRows.map((row) => `${String(snapshots[0]?.sourcePath)}:${row.chainId}:${row.contract}:${signatureFor(row.abi)}`);
  const actualKeys = bindingRows.map(bindingKey);
  const identitiesUnique = new Set(actualKeys).size === actualKeys.length;
  const sourcePathsUnique = new Set(snapshots.map((snapshot) => String(snapshot.sourcePath))).size === snapshots.length;
  const exact = bindingRows.every(({ snapshot, binding }) => {
    if (snapshot.sourcePath !== 'data/defi-catalog/v3/sources/workflow-extensions.json') return false;
    const fn = catalogByIdentity.get(`${Number(binding.chainId)}:${String(binding.contract).toLowerCase()}:${String(binding.signature)}`);
    const sourceMatches = sourceFunctionRows.filter((row) => row.chainId === Number(binding.chainId) && row.contract === String(binding.contract).toLowerCase() && signatureFor(row.abi) === String(binding.signature));
    return sourceMatches.length === 1 && !!fn && binding.capabilityId === fn.capabilityId && binding.abiHash === canonicalAbiHash(fn.abi)
      && canonicalAbiHash(sourceMatches[0]!.abi) === canonicalAbiHash(fn.abi)
      && stableJson(binding.executionScope ?? null) === stableJson(fn.executionScope ?? null)
      && (!fn.executionScope || binding.executionScopeHash === scopeHash(fn.executionScope))
      && (!fn.executionScope ? binding.executionScopeHash === undefined : binding.executionScopeHash === scopeHash(fn.executionScope));
  });
  const exactBijection = sourcePathsUnique && identitiesUnique && expectedBindings.length === bindingRows.length
    && expectedBindings.every((key) => actualKeys.includes(key)) && actualKeys.every((key) => expectedBindings.includes(key)) && exact;
  const unadmittedAdditions = additions.filter((fn) => bindingRows.filter(({ binding }) => binding.capabilityId === fn.capabilityId
    && Number(binding.chainId) === fn.chainId && String(binding.contract).toLowerCase() === fn.contract.toLowerCase()
    && String(binding.signature) === fn.signature && binding.abiHash === canonicalAbiHash(fn.abi)
    && stableJson(binding.executionScope ?? null) === stableJson(fn.executionScope ?? null)
    && (!fn.executionScope ? binding.executionScopeHash === undefined : binding.executionScopeHash === scopeHash(fn.executionScope))).length !== 1).length;
  const admissionClosureValid = exactBijection && unadmittedAdditions === 0;
  return {
    snapshots: snapshots.length,
    snapshotsSourceHashValid: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.canonicalSha256 === admissionSourceHash && snapshot.sourcePath === 'data/defi-catalog/v3/sources/workflow-extensions.json'),
    admissionBindingCount: bindingRows.length,
    uniqueSnapshotSourcePaths: sourcePathsUnique,
    uniqueAdmissionBindingIdentities: identitiesUnique,
    bindingBijectionValid: exactBijection,
    sourceAdmissionCatalogBijectionValid: admissionClosureValid,
    admissionClosureValid,
    everyAdmissionBindingMatchesCatalogAbiAndScope: admissionClosureValid,
    unadmittedAdditions,
  };
}

function verifyActivityAndIdentity(inputs: AuditInputs): JsonObject {
  const universe = array(inputs.market.protocolUniverse);
  const ledger = array(inputs.m2Identity.ledger).map((x) => x as unknown as JsonObject);
  const mappings = array(inputs.m2Identity.mappings).map((x) => x as unknown as JsonObject);
  const rawRows = array(inputs.m2Activity.sourceIdMetricRows).map((x) => x as unknown as JsonObject);
  const methods = array(inputs.m2ActivityMethods.methods).map((x) => x as unknown as JsonObject);
  const canonicalMap = new Map(mappings.filter((mapping) => mapping.identityStatus === 'canonical').map((mapping) => [String(mapping.sourceId), mapping]));
  const sourceRows = Object.entries(object(inputs.m2Activity.sources)).map(([sourceName, value]) => [sourceName, value as unknown as JsonObject] as const);
  const responseHashChecks = sourceRows.map(([sourceName, source]) => {
    const body = object(source.responseBody);
    return { sourceName, httpStatus: source.httpStatus, declaredRows: source.rowCount, bodyRows: recordCount(body.protocols), digestMatchesBody: source.responseCanonicalJsonSha256 === `sha256:${sha256(stableJson(body))}` || source.responseCanonicalJsonSha256 === sha256(JSON.stringify(body)) };
  });
  const dexMethod = methods.find((method) => method.methodId === 'dex-volume-30d-positive-occurrence-v1');
  const dexApiSourceByChain = new Map(sourceRows.filter(([name]) => name.endsWith('_dexs')).map(([name, source]) => [name.replace('_dexs', ''), object(source.responseBody)]));
  const positiveActive = new Set<string>();
  const positiveEvidence: JsonObject[] = [];
  const positiveDexSourceIds = new Set<string>();
  const positiveDexChainsBySourceId = new Map<string, string[]>();
  let positiveDexObservationCount = 0;
  let unmatchedPositiveDexObservationCount = 0;
  for (const row of rawRows) {
    const sourceId = String(row.sourceId);
    for (const [providerChain, metricValues] of Object.entries(object(row.metricsByChain))) {
      const dex = object(object(metricValues).dexs);
      const value = number(dex.valueUsd);
      if (value === null || value <= 0) continue;
      positiveDexObservationCount++;
      const chainResponse = dexApiSourceByChain.get(providerChain);
      const rawRow = array(chainResponse?.protocols).map((item) => item as unknown as JsonObject).find((item) => String(item.defillamaId ?? item.id) === sourceId);
      const qualifies = dexMethod?.qualifiesAsUserActivity === true && dexMethod.providerMetric === 'dexs' && dexMethod.unit === 'USD' && String(dexMethod.window).includes('30d') && String(dexMethod.window).includes('90d')
        && dex.observationWindowDays === 30 && dex.activityEvidenceStatus === 'positive_observation_within_90d_window'
        && rawRow !== undefined && number(rawRow.total30d) === value && value > 0;
      if (!qualifies) { unmatchedPositiveDexObservationCount++; continue; }
      positiveDexSourceIds.add(sourceId);
      const chains = positiveDexChainsBySourceId.get(sourceId) ?? [];
      chains.push(providerChain); positiveDexChainsBySourceId.set(sourceId, chains);
    }
  }
  for (const [sourceId, mapping] of canonicalMap) {
    if (mapping.categoryId !== 'dex' || dexMethod?.qualifiesAsUserActivity !== true || dexMethod.providerMetric !== 'dexs' || dexMethod.unit !== 'USD' || !String(dexMethod.window).includes('30d') || !String(dexMethod.window).includes('90d')) continue;
    for (const [providerChain, metricsValue] of Object.entries(object(rawRows.find((row) => String(row.sourceId) === sourceId)?.metricsByChain))) {
      const dex = object(object(metricsValue).dexs);
      const value = number(dex.valueUsd);
      const positive = value !== null && value > 0 && dex.observationWindowDays === 30 && dex.activityEvidenceStatus === 'positive_observation_within_90d_window';
      const chainResponse = dexApiSourceByChain.get(providerChain);
      const rawRow = array(chainResponse?.protocols).map((x) => x as unknown as JsonObject).find((row) => String(row.defillamaId ?? row.id) === sourceId);
      if (positive && rawRow && number(rawRow.total30d) !== null && number(rawRow.total30d) === value && number(rawRow.total30d)! > 0) {
        positiveActive.add(sourceId);
        positiveEvidence.push({ sourceId, productLabel: mapping.productLabel, chain: providerChain, metric: 'dexs', valueUsd: value, windowDays: 30, sourceRowMatched: true, methodologyRuleId: dexMethod!.methodId as string });
        break;
      }
    }
  }
  const dispositions = ledger.reduce<Record<string, number>>((counts, row) => { const key = String(row.disposition); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
  const ledgerMatchedRoster = ledger.length === universe.length && stableJson(ledger.map((row) => row.sourceId)) === stableJson(universe.map((row) => String(object(row).id)));
  const expectedProxyIds = ledger.filter((row) => row.disposition === 'unresolved' || row.disposition === 'partial').map((row) => `protocol-roster:${String(row.sourceId)}`).sort(cmp);
  const actualProxyIds = array(inputs.m2Normalized.unresolvedUniverseRecords).map((row) => String(object(row).sourceRecordRef)).sort(cmp);
  const unresolvedProxySetConserved = stableJson(expectedProxyIds) === stableJson(actualProxyIds);
  const unmatched = array(inputs.m2Identity.unmatchedMetricRecords);
  const rawCanonicalDeduplicationDocumented = ledgerMatchedRoster && unmatched.length === 0
    && (dispositions.unresolved ?? 0) === 0 && (dispositions.partial ?? 0) === 0
    && mappings.length === universe.length && mappings.every((mapping) => mapping.identityStatus === 'canonical')
    && new Set(mappings.map((mapping) => String(mapping.sourceId))).size === mappings.length;
  const compound114Method = methods.filter((method) => array(method.sourceIds).includes('114'));
  const feeMethodsStillUnqualified = compound114Method.length === 1 && compound114Method.every((method) => method.qualifiesAsUserActivity === false && method.providerMetric === 'fees' && method.unit === 'USD');
  const activityMethodRulesValid = methods.every((method) => method.qualifiesAsUserActivity !== true || method.providerMetric === 'dexs' && method.unit === 'USD' && String(method.window).includes('30d') && String(method.window).includes('90d'));
  const asOf = Date.parse(inputs.auditAsOf);
  const captured = Date.parse(String(inputs.m2Activity.captureTimestampUtc));
  const fresh = Number.isFinite(asOf) && Number.isFinite(captured) && captured <= asOf && captured >= asOf - 90 * 86_400_000;
  const mappingsMatchLedger = mappings.every((mapping) => ledger.some((row) => row.sourceId === mapping.sourceId && (mapping.identityStatus === 'canonical' && row.disposition === 'mapped' || mapping.identityStatus === 'partial' && row.disposition === 'partial')));
  const activityWindowRuleValid = inputs.m2Activity.activityRules && object(inputs.m2Activity.activityRules).windowDaysForActiveOccurrence === 90 && inputs.m2ActivityMethods.activityWindowDays === 90;
  return {
    rawUniverseRows: universe.length,
    rawUniverseCompactJsonSha256: inputs.protocolUniverseCompactSha256,
    expectedFrozenUniverseSha256: String(inputs.m2Identity.m1UniverseCanonicalJsonSha256),
    rawUniverseDigestValid: inputs.protocolUniverseCompactSha256 === inputs.m2Identity.m1UniverseCanonicalJsonSha256 && inputs.protocolUniverseCompactSha256 === object(inputs.classification.frozenRoster).protocolUniverseCanonicalJsonSha256,
    identityLedgerRows: ledger.length, identityLedgerMatchesRosterOrder: ledgerMatchedRoster,
    crosswalkMappingsAgreeWithLedger: mappingsMatchLedger,
    identityDispositionCounts: dispositions,
    canonicalMappings: mappings.filter((mapping) => mapping.identityStatus === 'canonical').length,
    rawCanonicalDeduplicationDocumented,
    partialMappings: mappings.filter((mapping) => mapping.identityStatus === 'partial').length,
    unresolvedIdentityLedgerRows: dispositions.unresolved ?? 0,
    unresolvedProxyRowsIncludingPartial: (dispositions.unresolved ?? 0) + (dispositions.partial ?? 0),
    unresolvedProxyRecordsConservedAgainstLedger: unresolvedProxySetConserved,
    unmatchedMetricRecords: unmatched.length,
    unmatchedMetricRecordsAreAdditionalRosterRows: false,
    canonicalActiveProductCount: positiveActive.size,
    canonicalActiveSourceIds: [...positiveActive].sort(cmp),
    positiveDexObservationCount,
    positiveDexSourceIdCount: positiveDexSourceIds.size,
    positiveDexSourceIds: [...positiveDexSourceIds].sort(cmp),
    positiveDexChainsBySourceId: Object.fromEntries([...positiveDexChainsBySourceId].sort(([a], [b]) => cmp(a, b)).map(([id, chains]) => [id, [...new Set(chains)].sort(cmp)])),
    positiveDexObservationEvidenceComplete: positiveDexObservationCount === 603 && unmatchedPositiveDexObservationCount === 0 && positiveDexSourceIds.size === 349,
    unmatchedPositiveDexObservationCount,
    eligiblePositive30dDexEvidence: positiveEvidence,
    activitySourceCount: sourceRows.length,
    http200ActivitySources: sourceRows.filter(([, source]) => source.httpStatus === 200).length,
    responseCanonicalHashMatchesBody: responseHashChecks.filter((row) => row.digestMatchesBody).length,
    responseCanonicalHashMismatches: responseHashChecks.filter((row) => !row.digestMatchesBody).map((row) => row.sourceName),
    allDeclaredResponseBodyHashesReconciled: responseHashChecks.every((row) => row.digestMatchesBody),
    eligibleDexResponseBodyHashesReconciled: responseHashChecks.filter((row) => row.sourceName.endsWith('_dexs')).every((row) => row.digestMatchesBody),
    activityMethodRulesValid,
    activityCaptureTimestampUtc: inputs.m2Activity.captureTimestampUtc,
    auditAsOf: inputs.auditAsOf,
    activityCaptureWithin90Days: fresh,
    activityWindowRuleValid: activityWindowRuleValid === true,
    compoundV2Source114FeeMethods: compound114Method.map((method) => ({ id: method.methodId, unit: method.unit, window: method.window, qualifiesAsUserActivity: method.qualifiesAsUserActivity })),
    compoundV2FeesQualify: compound114Method.some((method) => method.qualifiesAsUserActivity === true),
    compoundV2FeeMethodPreservedUnqualified: feeMethodsStillUnqualified,
  };
}

function verifyWorkflows(inputs: AuditInputs, functions: readonly FunctionRow[], activity: JsonObject): JsonObject {
  const v2Definitions = array(inputs.m2Normalized.workflowDefinitions).map((x) => x as unknown as JsonObject);
  const v3Definitions = array(inputs.m3Normalized.workflowDefinitions).map((x) => x as unknown as JsonObject);
  const v2Ids = new Set(v2Definitions.map((workflow) => String(workflow.workflowId)));
  const v3Map = new Map(v3Definitions.map((workflow) => [String(workflow.workflowId), workflow]));
  const oldWorkflowPreserved = v2Definitions.every((workflow) => stableJson(workflow) === stableJson(v3Map.get(String(workflow.workflowId))));
  const exactReferences = v2Definitions.flatMap((workflow) => array(workflow.requiredCapabilities).map((req) => ({ workflow, req: req as unknown as JsonObject }))).filter(({ req }) => functions.some((fn) => fn.capabilityId === req.capabilityId && fn.chainId === req.chainId && fn.contract.toLowerCase() === String(req.contract).toLowerCase() && fn.signature === req.signature && canonicalAbiHash(fn.abi) === String(req.abiHash).toLowerCase())).length;
  const resolvedRequirementsNonemptyAndBound = v2Definitions.every((workflow) => workflow.requirementStatus !== 'resolved' || recordCount(workflow.requiredCapabilities) > 0 && array(workflow.requiredCapabilities).every((reqValue) => {
    const req = reqValue as unknown as JsonObject;
    return functions.some((fn) => fn.capabilityId === req.capabilityId && fn.chainId === req.chainId && fn.contract.toLowerCase() === String(req.contract).toLowerCase() && fn.signature === req.signature && canonicalAbiHash(fn.abi) === String(req.abiHash).toLowerCase());
  }));
  const inventoryBundles = array(inputs.m3WorkflowInventory.scopedWorkflowBundles).map((x) => x as unknown as JsonObject);
  const targetBindings = inventoryBundles.flatMap((bundle) => array(bundle.requiredCapabilities).map((req) => ({ bundle, req: req as unknown as JsonObject })));
  const exactTargetBindings = targetBindings.filter(({ bundle, req }) => functions.some((fn) => fn.capabilityId === req.capabilityId && fn.chainId === req.chainId && fn.contract.toLowerCase() === String(req.contract).toLowerCase() && fn.signature === req.signature && canonicalAbiHash(fn.abi) === String(req.abiHash).toLowerCase() && (req.executionScopeHash === undefined || fn.executionScope && scopeHash(fn.executionScope) === req.executionScopeHash))).length;
  const targetScopeRows = inventoryBundles.length === 9 && inventoryBundles.every((bundle) => bundle.status === 'target-scoped-functions-admitted' && String(bundle.completionScope).includes('not') && bundle.requiredCapabilities !== undefined);
  const targetIdentityDispositionValid = inventoryBundles.filter((bundle) => bundle.family === 'uniswap-v3-position-manager').every((bundle) => object(bundle.identityMapping).status === 'canonical-product-target-evidence' && object(bundle.identityMapping).sourceId === '2198')
    && inventoryBundles.filter((bundle) => bundle.family === 'morpho-blue').every((bundle) => object(bundle.identityMapping).status === 'lineage-only-unverified-market-crosswalk' && object(bundle.identityMapping).rawSourceMappingClaim === false);
  const productObservations = array(inputs.m3Normalized.observations).map((x) => x as unknown as JsonObject);
  const normalizedProducts = array(inputs.m3Normalized.products).map((x) => x as unknown as JsonObject);
  const productRecords = normalizedProducts.filter((product) => product.countingRole === 'coverage_unit');
  const m2Products = array(inputs.m2Normalized.products).map(object);
  const m2CoverageById = new Map(m2Products.filter((product) => product.countingRole === 'coverage_unit').map((product) => [String(product.productId), product]));
  const coverageProductAuthorityValid = productRecords.length === m2CoverageById.size && productRecords.every((product) => {
    const baseline = m2CoverageById.get(String(product.productId));
    return !!baseline && stableJson(product) === stableJson(baseline);
  });
  const coverageProductIds = new Set(productRecords.map((product) => String(product.productId)));
  const sourceIdByProductId = new Map(productRecords.map((product) => {
    const productId = String(product.productId);
    return [productId, productId.startsWith('raw-provider:') ? productId.slice('raw-provider:'.length) : ''] as const;
  }));
  const lineageOnlyProductIds = new Set(normalizedProducts.filter((product) => product.countingRole === 'lineage_only').map((product) => String(product.productId)));
  const activeObservationProductIds = new Set<string>();
  const unresolvedObservationProductIds = new Set<string>();
  const activeRosterSourceIds = new Set(array(activity.positiveDexSourceIds).map(String));
  const unresolvedObservationRosterSourceIds = new Set<string>();
  const unresolvedObservationChains = new Map<string, number[]>();
  let activeObservationRows = 0;
  let unresolvedObservationRows = 0;
  let ignoredLineageObservationRows = 0;
  let unclassifiedCoverageObservationRows = 0;
  for (const observation of productObservations) {
    const productId = String(observation.productId);
    if (lineageOnlyProductIds.has(productId)) { ignoredLineageObservationRows++; continue; }
    if (!coverageProductIds.has(productId)) { unclassifiedCoverageObservationRows++; continue; }
    const sourceId = sourceIdByProductId.get(productId) ?? '';
    if (observation.status === 'observed_active') {
      activeObservationProductIds.add(productId); activeObservationRows++;
    }
    else if (observation.status === 'unresolved') {
      unresolvedObservationProductIds.add(productId); unresolvedObservationRows++;
      if (sourceId) {
        unresolvedObservationRosterSourceIds.add(sourceId);
        const chains = unresolvedObservationChains.get(sourceId) ?? [];
        chains.push(Number(observation.chainId)); unresolvedObservationChains.set(sourceId, chains);
      }
    }
    else unclassifiedCoverageObservationRows++;
  }
  const activeUnresolvedIntersection = [...activeObservationProductIds].filter((id) => unresolvedObservationProductIds.has(id)).sort(cmp);
  const activeUnresolvedUnion = [...new Set([...activeObservationProductIds, ...unresolvedObservationProductIds])].sort(cmp);
  const activeUnresolvedOnly = [...unresolvedObservationProductIds].filter((id) => !activeObservationProductIds.has(id)).sort(cmp);
  const activeOnly = [...activeObservationProductIds].filter((id) => !unresolvedObservationProductIds.has(id)).sort(cmp);
  const m3ProxyReferences = array(inputs.m3Normalized.unresolvedUniverseRecords).map((record) => String(object(record).sourceRecordRef));
  const m3ProxyRosterSourceIds = m3ProxyReferences.map((ref) => ref.startsWith('protocol-roster:') ? ref.slice('protocol-roster:'.length) : `INVALID:${ref}`);
  const unresolvedRosterSourceIds = new Set(m3ProxyRosterSourceIds);
  for (const sourceId of unresolvedObservationRosterSourceIds) unresolvedRosterSourceIds.add(sourceId);
  const universeRosterSourceIds = array(inputs.market.protocolUniverse).map((row) => String(object(row).id));
  const activeRosterSourceIdList = [...activeRosterSourceIds].sort(cmp);
  const unresolvedRosterSourceIdList = [...unresolvedRosterSourceIds].sort(cmp);
  const rosterIntersection = activeRosterSourceIdList.filter((sourceId) => unresolvedRosterSourceIds.has(sourceId));
  const rosterUnion = [...new Set([...activeRosterSourceIdList, ...unresolvedRosterSourceIdList])].sort(cmp);
  const rosterActiveOnly = activeRosterSourceIdList.filter((sourceId) => !unresolvedRosterSourceIds.has(sourceId));
  const rosterUnresolvedOnly = unresolvedRosterSourceIdList.filter((sourceId) => !activeRosterSourceIds.has(sourceId));
  const rosterAccountingValid = new Set(universeRosterSourceIds).size === universeRosterSourceIds.length
    && activeRosterSourceIdList.every((id) => universeRosterSourceIds.includes(id))
    && unresolvedRosterSourceIdList.every((id) => universeRosterSourceIds.includes(id))
    && m3ProxyRosterSourceIds.length === new Set(m3ProxyRosterSourceIds).size
    && stableJson(m3ProxyRosterSourceIds.slice().sort(cmp)) === stableJson(array(inputs.m2Normalized.unresolvedUniverseRecords).map((record) => String(object(record).sourceRecordRef).replace(/^protocol-roster:/, '')).sort(cmp));
  const observationSetAccounting: JsonObject = {
    countingUnit: 'distinct normalized coverage-unit productId, not observation rows or unmatched metric IDs',
    coverageUnitProductCount: coverageProductIds.size,
    activeObservationRowCount: activeObservationRows,
    unresolvedObservationRowCount: unresolvedObservationRows,
    ignoredLineageOnlyObservationRowCount: ignoredLineageObservationRows,
    unclassifiedCoverageObservationRowCount: unclassifiedCoverageObservationRows,
    activeProductCount: activeObservationProductIds.size,
    activeProductIds: [...activeObservationProductIds].sort(cmp),
    unresolvedProductCount: unresolvedObservationProductIds.size,
    unresolvedProductIds: [...unresolvedObservationProductIds].sort(cmp),
    activeUnresolvedIntersectionCount: activeUnresolvedIntersection.length,
    activeUnresolvedIntersectionProductIds: activeUnresolvedIntersection,
    activeUnresolvedUnionCount: activeUnresolvedUnion.length,
    activeUnresolvedUnionProductIds: activeUnresolvedUnion,
    activeOnlyCount: activeOnly.length,
    activeOnlyProductIds: activeOnly,
    unresolvedOnlyCount: activeUnresolvedOnly.length,
    unresolvedOnlyProductIds: activeUnresolvedOnly,
    activeUnresolvedRosterAccounting: {
      countingUnit: 'unique sourceId in frozen roster; unresolved source-row proxies plus unresolved coverage-unit observations; lineage-only excluded',
      rosterSourceRowCount: universeRosterSourceIds.length,
      unresolvedProxyRosterRows: m3ProxyRosterSourceIds.length,
      activeSourceIds: activeRosterSourceIdList,
      activeSourceIdCount: activeRosterSourceIdList.length,
      activeEvidenceObservationCount: number(activity.positiveDexObservationCount),
      activePositiveDexObservationChainsBySourceId: object(activity.positiveDexChainsBySourceId),
      unresolvedSourceIdCount: unresolvedRosterSourceIdList.length,
      unresolvedObservationSourceIds: [...unresolvedObservationRosterSourceIds].sort(cmp),
      unresolvedObservationChainsBySourceId: Object.fromEntries([...unresolvedObservationChains].map(([id, chains]) => [id, [...new Set(chains)].sort((a, b) => a - b)])),
      activeUnresolvedIntersectionCount: rosterIntersection.length,
      activeUnresolvedIntersectionSourceIds: rosterIntersection,
      activeUnresolvedUnionCount: rosterUnion.length,
      activeOnlyCount: rosterActiveOnly.length,
      activeOnlySourceIds: rosterActiveOnly,
      unresolvedOnlyCount: rosterUnresolvedOnly.length,
      unresolvedOnlyProxyRosterRowCount: m3ProxyRosterSourceIds.filter((id) => !activeRosterSourceIds.has(id)).length,
      unresolvedOnlyObservedSourceIds: rosterUnresolvedOnly.filter((id) => !m3ProxyRosterSourceIds.includes(id)),
      inclusionExclusionUnionCount: activeRosterSourceIdList.length + unresolvedRosterSourceIdList.length - rosterIntersection.length,
      unionEqualsFrozenRoster: rosterUnion.length === universeRosterSourceIds.length && stableJson(rosterUnion) === stableJson(universeRosterSourceIds.slice().sort(cmp)),
      proxyRowsConservedAgainstM2: rosterAccountingValid,
      unmatchedMetricRecordsCount: array(inputs.m2Identity.unmatchedMetricRecords).length,
      unmatchedMetricRecordsAreExtraRosterRows: false,
    },
    unmatchedMetricRecordsAreRosterRows: false,
  };
  const completeProductInstances = productObservations.filter((observation) => observation.instanceEnumeration === 'complete' && object(observation.workflowSet).status === 'complete' && array(observation.instances).length > 0 && array(observation.instances).every((instanceValue) => {
    const instance = instanceValue as unknown as JsonObject;
    return array(instance.workflowClaims).length > 0 && array(instance.workflowClaims).every((claimValue) => object(claimValue).status === 'supported');
  })).length;
  const missingExpectedChainObservations = productRecords.reduce<number>((missing, product) => missing + array(product.expectedScopeChainIds).filter((chainId) => !productObservations.some((observation) => observation.productId === product.productId && observation.chainId === chainId)).length, 0);
  const workflowById = new Map(v3Definitions.map((workflow) => [String(workflow.workflowId), workflow]));
  const workflowDefinitionIds = v3Definitions.map((workflow) => String(workflow.workflowId));
  const workflowDefinitionsUnique = new Set(workflowDefinitionIds).size === workflowDefinitionIds.length;
  const functionById = functionIndex(functions);
  const canonicalActiveSourceIds = new Set(array(activity.canonicalActiveSourceIds).map(String));
  const productChainPairs = new Set<string>();
  const supportedCanonicalProductIds = new Set<string>();
  const productCompletionChecks: JsonObject[] = [];
  for (const product of productRecords) {
    const productId = String(product.productId);
    const sourceId = sourceIdByProductId.get(productId) ?? '';
    const isCanonicalActive = sourceId !== '' && canonicalActiveSourceIds.has(sourceId);
    const expectedChains = array(product.expectedScopeChainIds).map(Number);
    const chainsUnique = new Set(expectedChains).size === expectedChains.length && expectedChains.length > 0;
    let allChainsComplete = coverageProductAuthorityValid && workflowDefinitionsUnique && isCanonicalActive
      && product.chainInventoryCompleteness === 'complete' && typeof product.chainInventorySourceRef === 'string' && chainsUnique;
    const chainChecks: JsonObject[] = [];
    for (const chainId of expectedChains) {
      const matches = productObservations.filter((observation) => observation.productId === productId && Number(observation.chainId) === chainId);
      const pairKey = `${productId}:${chainId}`;
      const pairUnique = !productChainPairs.has(pairKey);
      productChainPairs.add(pairKey);
      let chainComplete = matches.length === 1 && pairUnique;
      const observation = matches[0];
      if (!observation || observation.status !== 'observed_active' || observation.instanceEnumeration !== 'complete' || object(observation.workflowSet).status !== 'complete') chainComplete = false;
      const definitions = v3Definitions.filter((workflow) => String(workflow.productId) === productId && Number(workflow.chainId) === chainId);
      const requiredWorkflowIds = definitions.map((workflow) => String(workflow.workflowId)).sort(cmp);
      const declaredWorkflowIds = array(object(observation?.workflowSet).workflowIds).map(String).sort(cmp);
      if (definitions.length === 0 || definitions.some((workflow) => workflow.requirementStatus !== 'resolved' || array(workflow.requiredCapabilities).length === 0)
        || stableJson(requiredWorkflowIds) !== stableJson(declaredWorkflowIds)) chainComplete = false;
      const instances = array(observation?.instances).map(object);
      const instanceIds = instances.map((instance) => String(instance.instanceId));
      if (instances.length === 0 || new Set(instanceIds).size !== instanceIds.length) chainComplete = false;
      for (const instance of instances) {
        const claims = array(instance.workflowClaims).map(object);
        const claimIds = claims.map((claim) => String(claim.workflowId));
        if (new Set(claimIds).size !== claimIds.length || stableJson(claimIds.slice().sort(cmp)) !== stableJson(requiredWorkflowIds)) chainComplete = false;
        for (const claim of claims) {
          const workflow = workflowById.get(String(claim.workflowId));
          const required = array(workflow?.requiredCapabilities).map(object);
          const expectedCapabilityIds = required.map((requirement) => String(requirement.capabilityId)).sort(cmp);
          const claimedCapabilityIds = array(claim.admittedCapabilityIds).map(String).sort(cmp);
          const allBindingsValid = required.length > 0 && required.every((requirement) => {
            const fn = functionById.get(String(requirement.capabilityId));
            return !!fn && fn.status === 'active' && fn.chainId === Number(requirement.chainId) && fn.contract.toLowerCase() === String(requirement.contract).toLowerCase()
              && fn.signature === requirement.signature && canonicalAbiHash(fn.abi) === String(requirement.abiHash).toLowerCase()
              && (fn.executionScope ? requirement.executionScopeHash === scopeHash(fn.executionScope) : requirement.executionScopeHash === undefined);
          });
          if (!workflow || String(workflow.productId) !== productId || Number(workflow.chainId) !== chainId || workflow.requirementStatus !== 'resolved'
            || claim.status !== 'supported' || stableJson(expectedCapabilityIds) !== stableJson(claimedCapabilityIds) || !allBindingsValid) chainComplete = false;
        }
      }
      chainChecks.push({ chainId, observationCount: matches.length, expectedWorkflowCount: requiredWorkflowIds.length, enumeratedInstanceCount: instances.length, complete: chainComplete });
      if (!chainComplete) allChainsComplete = false;
    }
    if (allChainsComplete) supportedCanonicalProductIds.add(productId);
    productCompletionChecks.push({ productId, sourceId: sourceId || null, canonicalActiveProduct: isCanonicalActive, expectedChainCount: expectedChains.length, allExpectedChainsComplete: allChainsComplete, chains: chainChecks });
  }
  return {
    m2WorkflowDefinitions: v2Definitions.length,
    m2RequiredCapabilityReferences: v2Definitions.reduce((sum, workflow) => sum + recordCount(workflow.requiredCapabilities), 0),
    m2DefinitionsPreservedExactlyInV3: oldWorkflowPreserved && v3Definitions.length === v2Definitions.length + 9 && [...v2Ids].every((id) => v3Map.has(id)),
    workflowDefinitionIdsUnique: workflowDefinitionsUnique,
    exactM2CapabilityBindingsFoundInCatalog: exactReferences,
    resolvedWorkflowRequirementsNonemptyAndExact: resolvedRequirementsNonemptyAndBound,
    targetScopedWorkflowBundles: inventoryBundles.length,
    targetBundleCapabilityReferences: targetBindings.length,
    exactTargetBindingsIndependentlyRevalidated: exactTargetBindings,
    allTargetBundlesRemainNarrowScopeOnly: targetScopeRows,
    targetIdentityDispositionValid,
    wholeProductObservationRows: productObservations.length,
    countableProducts: productRecords.length,
    coverageProductAuthorityPreservedFromM2: coverageProductAuthorityValid,
    observationSetAccounting,
    missingExpectedProductChainObservations: missingExpectedChainObservations,
    completeInstanceAndWorkflowObservationRows: completeProductInstances,
    completeDistinctCanonicalActiveProductCount: supportedCanonicalProductIds.size,
    completeCanonicalActiveProductIds: [...supportedCanonicalProductIds].sort(cmp),
    productWorkflowEvidenceChecks: productCompletionChecks,
    duplicateProductChainObservationPairs: productChainPairs.size < productObservations.filter((observation) => coverageProductIds.has(String(observation.productId))).length,
    wholeProductWorkflowCompletionEstablished: supportedCanonicalProductIds.size > 0,
    sourceWorkflowSeedProducts: array(inputs.m2WorkflowInventory.products).length,
    sourceWorkflowSeedRows: array(inputs.m2WorkflowInventory.products).reduce<number>((sum, productValue) => sum + recordCount(object(productValue).workflows), 0),
  };
}

function verifyProfiles(profiles: readonly StaticProfile[], functions: readonly FunctionRow[], expectedBundleIds: readonly string[], expectedReferenceCount: number): JsonObject {
  const byId = functionIndex(functions);
  const used = new Set<string>();
  let allValid = profiles.length === expectedBundleIds.length;
  let totalRefs = 0;
  let max = 0;
  const results: JsonObject[] = [];
  for (const profile of profiles) {
    const ids = [...profile.capabilityIds];
    totalRefs += ids.length; max = Math.max(max, ids.length);
    const localUnique = new Set(ids).size === ids.length;
    const sorted = ids.every((id, index) => index === 0 || cmp(ids[index - 1]!, id) < 0);
    const members = ids.map((id) => byId.get(id));
    const identityMembers = members.map((fn, index) => fn ? {
      capabilityId: ids[index]!, type: fn.type, chainId: fn.chainId, contract: fn.contract.toLowerCase(), signature: fn.signature,
      abiHash: canonicalAbiHash(fn.abi), ...(fn.executionScope ? { executionScopeHash: scopeHash(fn.executionScope) } : {}),
    } : null);
    const expected = `sha256:${sha256(stableJson({ bundleId: profile.bundleId, version: profile.version, members: identityMembers }))}`;
    const chainBound = members.every((fn) => !!fn && fn.status === 'active' && fn.type === 'contract_call' && profile.chainIds.length === 1 && fn.chainId === profile.chainIds[0]);
    const uniqueGlobally = ids.every((id) => !used.has(id));
    ids.forEach((id) => used.add(id));
    const expectedSize = profile.bundleId.startsWith('uniswap-v3-') ? 9
      : profile.bundleId.startsWith('morpho-blue-') ? 6
        : profile.bundleId === 'curve-3pool-1' ? 4
          : profile.bundleId === 'pancakeswap-v3-positions-56' ? 9
            : profile.bundleId === 'yearn-tokenized-strategy-1' ? 6 : -1;
    const profileKeys = Object.keys(profile).sort(cmp);
    const shapeValid = stableJson(profileKeys) === stableJson(['bundleId', 'capabilityIds', 'chainIds', 'fingerprint', 'label', 'limitations', 'version', 'warnings'])
      && profile.label.trim().length > 0 && profile.chainIds.length === 1
      && profile.warnings.every((warning) => typeof warning === 'string' && warning.trim().length > 0)
      && profile.limitations.every((limitation) => typeof limitation === 'string' && limitation.trim().length > 0);
    const valid = profile.version === '1.0.0' && shapeValid && localUnique && sorted && chainBound && uniqueGlobally && profile.fingerprint === expected && ids.length === expectedSize;
    allValid &&= valid;
    results.push({ bundleId: profile.bundleId, chainIds: [...profile.chainIds], exactMemberCount: ids.length, sortedUnique: localUnique && sorted, chainBoundActiveMembers: chainBound, fingerprintValid: profile.fingerprint === expected, membershipValid: valid });
  }
  const profileIds = profiles.map((profile) => profile.bundleId);
  return {
    profileCount: profiles.length,
    profileReferenceCount: totalRefs,
    uniqueProfileMemberIds: used.size,
    maximumProfileSize: max,
    expectedBundleIdsPresent: expectedBundleIds.length === profileIds.length && expectedBundleIds.every((id) => profileIds.includes(id)),
    allLiteralProfilesValid: allValid && expectedBundleIds.length === profileIds.length && expectedBundleIds.every((id) => profileIds.includes(id)) && totalRefs === expectedReferenceCount && used.size === expectedReferenceCount,
    allNineLiteralProfilesValid: expectedBundleIds.length === 9 && allValid && totalRefs === 75 && used.size === 75 && max === 9,
    profiles: results,
  };
}

type V4SourceFunction = Readonly<{ familyId: string; familyVersion: string; chainId: number; address: string; abi: JsonObject; sourcePath: string }>;

function v4SourceFunctions(sourcePath: string, source: JsonObject): V4SourceFunction[] {
  if (source.schemaVersion !== 1 || !Array.isArray(source.families) || array(source.unresolved).length !== 0) throw new Error(`Invalid or unresolved V4 source snapshot: ${sourcePath}`);
  const sourceRows = array(source.sources);
  if (sourceRows.length === 0 || sourceRows.some((rowValue) => {
    const row = object(rowValue);
    return typeof row.url !== 'string' || typeof row.evidence !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.retrievedAtUtc));
  })) throw new Error(`Malformed V4 source evidence metadata: ${sourcePath}`);
  const sourceIds = new Set(sourceRows.map((row) => String(object(row).sourceId)));
  const referencedSourceIds = new Set<string>();
  const rows: V4SourceFunction[] = [];
  for (const familyValue of array(source.families)) {
    const family = object(familyValue);
    const familyId = String(family.familyId);
    const expectedTarget = V4_BATCH_TARGETS[familyId as keyof typeof V4_BATCH_TARGETS];
    if (!expectedTarget || expectedTarget.sourcePath !== sourcePath || family.familyVersion !== expectedTarget.familyVersion || !Array.isArray(family.contracts) || family.contracts.length !== 1) throw new Error(`Unexpected V4 source family/target: ${familyId}`);
    for (const contractValue of array(family.contracts)) {
      const contract = object(contractValue);
      if (Number(contract.chainId) !== expectedTarget.chainId || String(contract.address).toLowerCase() !== expectedTarget.address || !Array.isArray(contract.abiFunctions)) throw new Error(`Unexpected V4 source deployment: ${familyId}`);
      const refs = array(contract.sourceRefs).map(String);
      if (refs.length === 0 || refs.some((ref) => !sourceIds.has(ref))) throw new Error(`V4 deployment references unknown source evidence: ${familyId}`);
      refs.forEach((ref) => referencedSourceIds.add(ref));
      for (const abiValue of array(contract.abiFunctions)) {
        const abi = abiValue as JsonObject;
        const rootKeys = Object.keys(abi).sort(cmp);
        if (stableJson(rootKeys) !== stableJson(['inputs', 'name', 'outputs', 'stateMutability', 'type']) || abi.type !== 'function' || !['nonpayable', 'payable', 'view', 'pure'].includes(String(abi.stateMutability))) throw new Error(`Unsupported source ABI root metadata: ${familyId}`);
        const inputs = array(abi.inputs);
        const outputs = array(abi.outputs);
        if ([...inputs, ...outputs].some((param) => !param || typeof param !== 'object' || Array.isArray(param))) throw new Error(`Malformed ABI parameter: ${familyId}`);
        rows.push({ familyId, familyVersion: String(family.familyVersion), chainId: expectedTarget.chainId, address: expectedTarget.address, abi, sourcePath });
      }
    }
  }
  if (referencedSourceIds.size !== sourceIds.size || [...sourceIds].some((sourceId) => !referencedSourceIds.has(sourceId))) throw new Error(`Unreferenced V4 source evidence: ${sourcePath}`);
  return rows;
}

function validExactScope(fn: FunctionRow, allFunctions: readonly FunctionRow[]): boolean {
  const scope = fn.executionScope;
  if (!scope) return false;
  if (scope.kind !== 'same-target-multicall-v1' || fn.signature !== 'multicall(bytes[])' || fn.abi.stateMutability !== 'payable' || scope.bytesArrayArgIndex !== 0 || scope.allowedChildren.length !== NPM_CHILD_SIGNATURES.length) return false;
  const children = scope.allowedChildren.map((binding) => allFunctions.find((child) => child.capabilityId === binding.capabilityId));
  return children.every((child, index) => {
    const binding = scope.allowedChildren[index]!;
    return !!child && child.status === 'active' && child.type === 'contract_call' && child.chainId === fn.chainId
      && child.contract.toLowerCase() === fn.contract.toLowerCase() && child.signature === binding.signature
      && canonicalAbiHash(child.abi) === binding.abiHash.toLowerCase() && NPM_CHILD_SIGNATURES.includes(child.signature)
      && child.executionScope === undefined;
  }) && new Set(scope.allowedChildren.map((child) => child.capabilityId)).size === NPM_CHILD_SIGNATURES.length
    && NPM_CHILD_SIGNATURES.every((signature) => scope.allowedChildren.some((child) => child.signature === signature));
}

function verifyCurrentV4(inputs: AuditInputs, v3Functions: readonly FunctionRow[]): JsonObject | null {
  if (!inputs.currentV4Catalog || !inputs.currentV4Admissions || !inputs.currentV4OrdinarySource || !inputs.currentV4YearnSource || !inputs.currentV4Profiles || !inputs.v3ProfileFixture) return null;
  const currentProfilesData = inputs.currentV4Profiles;
  const v4Functions = flattenCatalog(inputs.currentV4Catalog);
  const v4Map = functionIndex(v4Functions);
  const v3Map = functionIndex(v3Functions);
  const additions = v4Functions.filter((fn) => !v3Map.has(fn.capabilityId));
  const v3FullyPreserved = v3Functions.length === 349 && v3Functions.every((fn) => stableJson(fn) === stableJson(v4Map.get(fn.capabilityId)));
  const sources = [
    [V4_SOURCE_PATHS[0], inputs.currentV4OrdinarySource] as const,
    [V4_SOURCE_PATHS[1], inputs.currentV4YearnSource] as const,
  ];
  const sourceRows = sources.flatMap(([path, document]) => v4SourceFunctions(path, document));
  const expectedFamilyCounts: Record<string, number> = { 'curve-3pool-stableswap': 4, 'pancakeswap-v3-position-manager': 9, 'yearn-tokenized-strategy': 6 };
  const expectedSourceRefCounts: Record<string, number> = { 'curve-3pool-stableswap': 2, 'pancakeswap-v3-position-manager': 4, 'yearn-tokenized-strategy': 3 };
  const expectedSignatures: Record<string, readonly string[]> = {
    'curve-3pool-stableswap': CURVE_SIGNATURES,
    'pancakeswap-v3-position-manager': [...NPM_CHILD_SIGNATURES, 'multicall(bytes[])'],
    'yearn-tokenized-strategy': YEARn_SIGNATURES,
  };
  const sourceKey = (row: Pick<V4SourceFunction, 'familyId' | 'chainId' | 'address' | 'abi'>): string => `${row.familyId}:${row.chainId}:${row.address.toLowerCase()}:${signatureFor(row.abi)}`;
  const sourceKeys = sourceRows.map(sourceKey);
  const sourceIdentityUnique = new Set(sourceKeys).size === sourceKeys.length;
  const groupChecks = Object.entries(expectedFamilyCounts).map(([familyId, expectedCount]) => {
    const familyRows = sourceRows.filter((row) => row.familyId === familyId);
    const expectedTarget = V4_BATCH_TARGETS[familyId as keyof typeof V4_BATCH_TARGETS];
    const actualSignatures = familyRows.map((row) => signatureFor(row.abi)).sort(cmp);
    const requiredSignatures = [...expectedSignatures[familyId]!].sort(cmp);
    const mutability = familyRows.every((row) => row.abi.stateMutability === (familyId === 'pancakeswap-v3-position-manager' ? 'payable' : 'nonpayable'));
    const outputsCorrect = familyRows.every((row) => familyId !== 'curve-3pool-stableswap' || array(row.abi.outputs).length === 0);
    const sourceFamily = array(object(sources.find(([path]) => path === expectedTarget.sourcePath)?.[1]).families).map(object).find((family) => family.familyId === familyId);
    const sourceRefsCount = array(object(array(sourceFamily?.contracts)[0]).sourceRefs).length;
    return {
      familyId, chainId: expectedTarget.chainId, target: expectedTarget.address,
      sourceFunctionCount: familyRows.length, requiredFunctionCount: expectedCount,
      sourceRefsCount, requiredSourceRefsCount: expectedSourceRefCounts[familyId],
      exactSignatureSet: stableJson(actualSignatures) === stableJson(requiredSignatures),
      mutabilityValid: mutability, curveOutputsEmpty: outputsCorrect,
    };
  });
  const sourceCatalogMatches = sourceRows.every((row) => {
    const matches = v4Functions.filter((fn) => fn.chainId === row.chainId && fn.contract.toLowerCase() === row.address.toLowerCase() && fn.signature === signatureFor(row.abi));
    return matches.length === 1 && canonicalAbiHash(matches[0]!.abi) === canonicalAbiHash(row.abi) && matches[0]!.status === 'active'
      && matches[0]!.type === 'contract_call' && object(matches[0]!.provenance).status === 'verified';
  });
  const everyAdditionBoundOnce = additions.length === sourceRows.length && additions.every((fn) => sourceRows.filter((row) => row.chainId === fn.chainId && row.address.toLowerCase() === fn.contract.toLowerCase() && signatureFor(row.abi) === fn.signature && canonicalAbiHash(row.abi) === canonicalAbiHash(fn.abi)).length === 1);
  const snapshotRows = array(inputs.currentV4Admissions.snapshots).map((value) => object(value));
  const snapshotByPath = new Map(sources.map(([path, document]) => [path, document]));
  const admissionRows = snapshotRows.flatMap((snapshot) => array(snapshot.bindings).map((binding) => ({ snapshot, binding: object(binding) })));
  const admissionKeys = admissionRows.map(({ snapshot, binding }) => `${String(snapshot.sourcePath)}:${Number(binding.chainId)}:${String(binding.contract).toLowerCase()}:${String(binding.signature)}`);
  const admissionIdentitiesUnique = new Set(admissionKeys).size === admissionKeys.length;
  const admissionSourcePathsUnique = new Set(snapshotRows.map((snapshot) => String(snapshot.sourcePath))).size === snapshotRows.length;
  const admissionDigestValid = snapshotRows.length === 2 && snapshotRows.every((snapshot) => {
    const path = String(snapshot.sourcePath);
    const source = snapshotByPath.get(path);
    return !!source && V4_SOURCE_PATHS.includes(path) && snapshot.canonicalSha256 === sha256(stableJson(source)) && inputs.rawSha256[path] !== undefined;
  });
  const admissionBindingsValid = admissionSourcePathsUnique && admissionIdentitiesUnique && admissionRows.length === sourceRows.length && admissionRows.every(({ snapshot, binding }) => {
    const source = snapshotByPath.get(String(snapshot.sourcePath));
    const matchingSourceFamily = array(source?.families).map(object).find((family) => family.familyId === binding.familyId);
    const matchingSourceContract = array(matchingSourceFamily?.contracts).map(object).find((contract) => Number(contract.chainId) === Number(binding.chainId) && String(contract.address).toLowerCase() === String(binding.contract).toLowerCase());
    const abi = array(matchingSourceContract?.abiFunctions).map(object).find((candidate) => signatureFor(candidate) === binding.signature);
    const fn = v4Functions.find((candidate) => candidate.chainId === Number(binding.chainId) && candidate.contract.toLowerCase() === String(binding.contract).toLowerCase() && candidate.signature === binding.signature);
    if (!abi || !fn || binding.capabilityId !== fn.capabilityId || binding.abiHash !== canonicalAbiHash(abi) || canonicalAbiHash(abi) !== canonicalAbiHash(fn.abi)) return false;
    if (stableJson(binding.executionScope ?? null) !== stableJson(fn.executionScope ?? null)) return false;
    if (fn.executionScope) return binding.executionScopeHash === scopeHash(fn.executionScope);
    return binding.executionScopeHash === undefined;
  });
  const v4Scopes = v4Functions.filter((fn) => fn.executionScope);
  const v3ScopeIds = new Set(v3Functions.filter((fn) => fn.executionScope).map((fn) => fn.capabilityId));
  const newScopeFunctions = v4Scopes.filter((fn) => !v3ScopeIds.has(fn.capabilityId));
  const scopeBindingsValid = v4Scopes.length === 14 && v3ScopeIds.size === 13 && newScopeFunctions.length === 1
    && newScopeFunctions[0]!.chainId === 56 && newScopeFunctions[0]!.contract.toLowerCase() === V4_BATCH_TARGETS['pancakeswap-v3-position-manager'].address
    && validExactScope(newScopeFunctions[0]!, v4Functions)
    && v3Functions.every((fn) => !fn.executionScope || stableJson(fn.executionScope) === stableJson(v4Map.get(fn.capabilityId)?.executionScope));
  const sourceFamiliesExact = groupChecks.length === 3 && groupChecks.every((group) => group.sourceFunctionCount === group.requiredFunctionCount && group.sourceRefsCount === group.requiredSourceRefsCount && group.exactSignatureSet && group.mutabilityValid && group.curveOutputsEmpty);
  const profileFixture = inputs.v3ProfileFixture;
  const provenance = object(profileFixture.provenance);
  const baselineProfiles = array(profileFixture.profiles).map((value) => value as unknown as StaticProfile);
  const oldCurrentProfiles = currentProfilesData.filter((profile) => V3_PROFILE_IDS.includes(profile.bundleId));
  const currentProfilesPreserveV3Metadata = stableJson(oldCurrentProfiles) === stableJson(baselineProfiles);
  const fixtureAuthorityValid = inputs.v3ProfileFixtureSha256 === V3_PROFILE_FIXTURE_SHA256 && provenance.gitCommit === V3_PROFILE_FIXTURE_COMMIT
    && provenance.path === 'src/modules/defi/bundles/production-bundles.ts' && provenance.sourceBytesSha256 === V3_PROFILE_SOURCE_BYTES_SHA256
    && baselineProfiles.length === 9 && baselineProfiles.reduce((sum, profile) => sum + profile.capabilityIds.length, 0) === 75;
  const currentProfiles = verifyProfiles(currentProfilesData, v4Functions, [...V3_PROFILE_IDS, ...V4_EXPECTED_PROFILE_IDS], 94);
  const profileFamilyMatches = V4_EXPECTED_PROFILE_IDS.every((bundleId) => {
    const profile = currentProfilesData.find((item) => item.bundleId === bundleId);
    const familyId = bundleId === 'curve-3pool-1' ? 'curve-3pool-stableswap' : bundleId === 'pancakeswap-v3-positions-56' ? 'pancakeswap-v3-position-manager' : 'yearn-tokenized-strategy';
    const expected = additions.filter((fn) => fn.capabilityId.startsWith(`${familyId}:`)).map((fn) => fn.capabilityId).sort(cmp);
    return !!profile && stableJson([...profile.capabilityIds].sort(cmp)) === stableJson(expected);
  });
  const batchTargets = Object.entries(V4_BATCH_TARGETS).map(([familyId, target]) => ({
    familyId, chainId: target.chainId, target: target.address,
    availableFunctions: additions.filter((fn) => fn.capabilityId.startsWith(`${familyId}:`)).map((fn) => ({ capabilityId: fn.capabilityId, signature: fn.signature, abiHash: canonicalAbiHash(fn.abi), ...(fn.executionScope ? { executionScopeHash: scopeHash(fn.executionScope) } : {}) })).sort((a, b) => cmp(a.capabilityId, b.capabilityId)),
    marketIdentity: 'unverified', marketActivity: 'unknown', wholeProductWorkflow: 'not-established',
  }));
  const functionsByType = v4Functions.reduce<Record<string, number>>((counts, fn) => { counts[fn.type] = (counts[fn.type] ?? 0) + 1; return counts; }, {});
  const rawSourceDigestsPresent = V4_SOURCE_PATHS.every((path) => /^[a-f0-9]{64}$/.test(inputs.rawSha256[path] ?? ''))
    && /^[a-f0-9]{64}$/.test(inputs.rawSha256['data/defi-catalog/v4/catalog.json'] ?? '')
    && /^[a-f0-9]{64}$/.test(inputs.rawSha256['data/defi-catalog/v4/admissions.json'] ?? '')
    && /^[a-f0-9]{64}$/.test(inputs.rawSha256['src/modules/defi/bundles/production-bundles.ts'] ?? '');
  const rawInputs = [
    ...V4_SOURCE_PATHS,
    'data/defi-catalog/v4/catalog.json', 'data/defi-catalog/v4/admissions.json',
    'src/modules/defi/bundles/production-bundles.ts',
  ];
  const rawContentsMatchDigests = rawInputs.every((path) => typeof inputs.rawSourceContents?.[path] === 'string'
    && sha256(inputs.rawSourceContents[path]!) === inputs.rawSha256[path]);
  const parsedFilesMatchInputs = [
    ['data/defi-catalog/v4/catalog.json', inputs.currentV4Catalog],
    ['data/defi-catalog/v4/admissions.json', inputs.currentV4Admissions],
    [V4_SOURCE_PATHS[0], inputs.currentV4OrdinarySource],
    [V4_SOURCE_PATHS[1], inputs.currentV4YearnSource],
  ].every(([path, value]) => {
    const text = inputs.rawSourceContents?.[String(path)];
    if (typeof text !== 'string' || !value) return false;
    try { return stableJson(JSON.parse(text)) === stableJson(value); } catch { return false; }
  });
  const fixtureRawMatchesDigest = typeof inputs.rawSourceContents?.['src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json'] === 'string'
    && sha256(inputs.rawSourceContents['src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json']!) === V3_PROFILE_FIXTURE_SHA256
    && inputs.v3ProfileFixtureSha256 === V3_PROFILE_FIXTURE_SHA256;
  let fixtureParsedMatchesRaw = false;
  let currentProfilesMatchRawModule = false;
  try {
    const rawFixture = JSON.parse(inputs.rawSourceContents?.['src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json'] ?? 'null') as JsonObject;
    fixtureParsedMatchesRaw = stableJson(rawFixture) === stableJson(profileFixture);
    const rawProfiles = parseLiteralArrayAfter(inputs.rawSourceContents?.['src/modules/defi/bundles/production-bundles.ts'] ?? '', 'PRODUCTION_DEFI_CAPABILITY_BUNDLES: readonly DefiCapabilityBundle[] = Object.freeze(');
    currentProfilesMatchRawModule = stableJson(rawProfiles) === stableJson(currentProfilesData);
  } catch { fixtureParsedMatchesRaw = false; currentProfilesMatchRawModule = false; }
  const sourceDates = sources.map(([path, source]) => ({ sourcePath: path, retrievedAtUtc: array(source.sources).map((item) => String(object(item).retrievedAtUtc)), exactCaptureTimeAvailable: false }));
  const outputDigest = keccak256(stringToHex(stableJson(v4Functions.map(capabilityIdentity).sort((a, b) => cmp(String(a.capabilityId), String(b.capabilityId))))));
  const valid = v4Functions.length === 368 && additions.length === 19 && v3FullyPreserved && sourceIdentityUnique && sourceCatalogMatches && everyAdditionBoundOnce
    && sourceFamiliesExact && admissionDigestValid && admissionBindingsValid && scopeBindingsValid && fixtureAuthorityValid && currentProfilesPreserveV3Metadata
    && currentProfiles.allLiteralProfilesValid === true && profileFamilyMatches && currentProfilesMatchRawModule
    && rawSourceDigestsPresent && rawContentsMatchDigests && parsedFilesMatchInputs && fixtureRawMatchesDigest && fixtureParsedMatchesRaw;
  return {
    catalogVersion: 'v4',
    functionCount: v4Functions.length,
    v3FunctionCountPreserved: v3Functions.length,
    v3FunctionsCompletelyUnchanged: v3FullyPreserved,
    activeFunctionCount: v4Functions.filter((fn) => fn.status === 'active').length,
    addedFunctionCount: additions.length,
    functionsByType,
    generatedCatalogKeccak256: outputDigest,
    sourceSnapshotCount: sources.length,
    sourceSnapshots: sources.map(([path, source]) => ({ sourcePath: path, rawSha256: inputs.rawSha256[path] ?? null, canonicalJsonSha256: sha256(stableJson(source)), sourceRecordCount: array(source.sources).length, unresolvedRecords: array(source.unresolved).length, retrievedAtUtc: array(source.sources).map((item) => String(object(item).retrievedAtUtc)), exactCaptureTimeAvailable: false })),
    sourceFunctionRows: sourceRows.length,
    sourceRowsHaveUniqueFamilyChainTargetSignature: sourceIdentityUnique,
    allSourceAbisMatchExactlyOneActiveCatalogFunction: sourceCatalogMatches,
    everyNewCatalogFunctionBoundExactlyOnce: everyAdditionBoundOnce,
    admissions: { snapshots: snapshotRows.length, uniqueSourcePaths: admissionSourcePathsUnique, digestBoundToExactSources: admissionDigestValid, bindings: admissionRows.length, uniqueBindingIdentities: admissionIdentitiesUnique, sourceAdmissionCatalogBijectionValid: admissionBindingsValid && everyAdditionBoundOnce && sourceRows.length === additions.length, everyBindingMatchesFamilyChainTargetSignatureAbiCapabilityAndConditionalScope: admissionBindingsValid },
    additionsByFamily: groupChecks,
    executionScopes: { total: v4Scopes.length, sameTargetMulticall: v4Scopes.filter((fn) => fn.executionScope?.kind === 'same-target-multicall-v1').length, emptyCallbackData: v4Scopes.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1').length, exactlyOneNewCakeScopeAndAllEightChildrenBound: scopeBindingsValid },
    v3ProfileFixture: { rawSha256: inputs.v3ProfileFixtureSha256 ?? null, pinnedFixtureSha256: V3_PROFILE_FIXTURE_SHA256, provenanceCommit: provenance.gitCommit ?? null, pinnedSourceBytesSha256: provenance.sourceBytesSha256 ?? null, exactV3Profiles: fixtureAuthorityValid && fixtureParsedMatchesRaw },
    profileAuthority: { currentProfileCount: currentProfilesData.length, currentProfileReferences: currentProfiles.profileReferenceCount, currentUniqueProfileMemberIds: currentProfiles.uniqueProfileMemberIds, maximumCurrentProfileSize: currentProfiles.maximumProfileSize, exactBaselineNineFullMetadataAndMembershipUnchanged: currentProfilesPreserveV3Metadata, allTwelveCurrentProfilesFingerprintAndCatalogBound: currentProfiles.allLiteralProfilesValid, currentProfilesMatchRawStaticModule: currentProfilesMatchRawModule, newProfileSetsExactlyCoverTheirFamilyFunctions: profileFamilyMatches, details: currentProfiles.profiles },
    targetScopedFunctionAvailabilityOnly: batchTargets,
    marketIdentityOrActivityPromoted: false,
    currentProfileRowsAreNotGrantAssignments: true,
    noRuntimeOrFinancialArgumentSafetyClaim: true,
    inputSourcesHashRecorded: rawSourceDigestsPresent,
    rawContentsMatchRecordedDigests: rawContentsMatchDigests && parsedFilesMatchInputs && fixtureRawMatchesDigest && fixtureParsedMatchesRaw && currentProfilesMatchRawModule,
    sourceRetrievalDatesOnlyNotUtcCaptureTimes: sourceDates,
    verifierValid: valid,
  };
}

export function independentAudit(inputs: AuditInputs): Readonly<{ report: JsonObject; evidence: JsonObject }> {
  const catalogs = verifyCatalogs(inputs);
  const activity = verifyActivityAndIdentity(inputs);
  const functions = flattenCatalog(inputs.m3Catalog);
  const workflows = verifyWorkflows(inputs, functions, activity);
  const catalogVersion = inputs.catalogVersion ?? (inputs.currentV4Catalog ? 'v4' : 'v3');
  const fixtureProfileRows = array(inputs.v3ProfileFixture?.profiles).map((x) => x as unknown as StaticProfile);
  const profiles = verifyProfiles(fixtureProfileRows, functions, V3_PROFILE_IDS, 75);
  const fixtureProvenance = object(inputs.v3ProfileFixture?.provenance);
  const v3ProfileFixtureValid = inputs.v3ProfileFixtureSha256 === V3_PROFILE_FIXTURE_SHA256
    && fixtureProvenance.gitCommit === V3_PROFILE_FIXTURE_COMMIT
    && fixtureProvenance.path === 'src/modules/defi/bundles/production-bundles.ts'
    && fixtureProvenance.sourceBytesSha256 === V3_PROFILE_SOURCE_BYTES_SHA256
    && profiles.allNineLiteralProfilesValid === true;
  const v4 = catalogVersion === 'v4' ? verifyCurrentV4(inputs, functions) : null;
  const crosswalk = inputs.m2Identity;
  const unknownProxy = Number(activity.unresolvedProxyRowsIncludingPartial);
  const canonicalProductCount = Number(activity.canonicalMappings);
  const goal = evaluateGoalClosure({
    rawUniverseCount: Number(activity.rawUniverseRows), unresolvedIdentityProxyCount: unknownProxy,
    unmatchedIdentityCount: Number(activity.unmatchedMetricRecords), canonicalProductCount,
    activeProductCount: Number(activity.canonicalActiveProductCount), fullySupportedProductCount: Number(workflows.completeDistinctCanonicalActiveProductCount),
    chainsEnumerated: false, activityComplete: false, workflowsComplete: false, instancesComplete: false,
    rawCanonicalDeduplicationDocumented: activity.rawCanonicalDeduplicationDocumented === true,
  });
  const expectedFiles = Object.entries(inputs.rawSha256).map(([path, digest]) => ({ path, sha256: digest }));
  const inputDigestsVerified = expectedFiles.every((entry) => /^([a-f0-9]{64})$/.test(entry.sha256))
    && array(inputs.m3WorkflowInventory.sourceRefs).every((refValue) => {
      const ref = String(refValue);
      const marker = ref.match(/^(.+)#sha256=([a-f0-9]{64})$/);
      return !marker || inputs.rawSha256[marker[1]!] === marker[2];
    });
  const obsAccounting = object(workflows.observationSetAccounting);
  const rosterSetAccounting = object(obsAccounting.activeUnresolvedRosterAccounting);
  const reportProducts = object(inputs.m3ComparisonReport.products);
  const legacyCountsMatchDerivedSets = number(reportProducts.activeProducts) === obsAccounting.activeProductCount
    && number(reportProducts.unresolvedProducts) === rosterSetAccounting.unresolvedSourceIdCount
    && number(reportProducts.conservativeDenominator) === rosterSetAccounting.activeUnresolvedUnionCount;
  const baseFactsValid = catalogs.m1BaselineCompletelyRetained === true && catalogs.m2AuthorityCompletelyRetained === true && catalogs.v3FunctionCount === 349 && catalogs.v3AdditionCount === 34 && catalogs.exactV3AdditionsSourceBound === true && catalogs.finiteScopeBindingsValid === true && object(catalogs.admission).snapshotsSourceHashValid === true && object(catalogs.admission).sourceAdmissionCatalogBijectionValid === true && object(catalogs.admission).everyAdmissionBindingMatchesCatalogAbiAndScope === true && Number(object(catalogs.admission).unadmittedAdditions) === 0 && activity.rawUniverseDigestValid === true && activity.identityLedgerMatchesRosterOrder === true && activity.crosswalkMappingsAgreeWithLedger === true && activity.unresolvedProxyRecordsConservedAgainstLedger === true && activity.activityCaptureWithin90Days === true && activity.activityWindowRuleValid === true && activity.activityMethodRulesValid === true && activity.eligibleDexResponseBodyHashesReconciled === true && activity.positiveDexObservationEvidenceComplete === true && array(activity.positiveDexSourceIds).every((id) => array(inputs.market.protocolUniverse).some((row) => String(object(row).id) === String(id))) && activity.compoundV2FeeMethodPreservedUnqualified === true && workflows.m2DefinitionsPreservedExactlyInV3 === true && workflows.workflowDefinitionIdsUnique === true && workflows.coverageProductAuthorityPreservedFromM2 === true && workflows.resolvedWorkflowRequirementsNonemptyAndExact === true && workflows.targetIdentityDispositionValid === true && workflows.exactTargetBindingsIndependentlyRevalidated === workflows.targetBundleCapabilityReferences && obsAccounting.activeProductCount === activity.canonicalActiveProductCount && obsAccounting.unclassifiedCoverageObservationRowCount === 0 && obsAccounting.activeUnresolvedUnionCount === workflows.countableProducts && rosterSetAccounting.unionEqualsFrozenRoster === true && rosterSetAccounting.proxyRowsConservedAgainstM2 === true && rosterSetAccounting.inclusionExclusionUnionCount === rosterSetAccounting.activeUnresolvedUnionCount && profiles.allNineLiteralProfilesValid === true && v3ProfileFixtureValid && inputDigestsVerified;
  const currentV4Verified = catalogVersion === 'v4' && v4?.verifierValid === true;
  const factsValid = baseFactsValid && (catalogVersion === 'v3' || currentV4Verified);
  const report: JsonObject = {
    schemaVersion: 1,
    auditKind: 'independent-offline-source-and-authority-audit-v2',
    auditedCatalogVersion: catalogVersion,
    auditAsOf: inputs.auditAsOf,
    currentEvidenceStatus: 'BLOCKED_CURRENT_EVIDENCE',
    auditedCatalogBaseline: {
      catalogVersion,
      functionCount: catalogVersion === 'v4' ? number(v4?.functionCount) : Number(catalogs.v3FunctionCount),
      finiteExecutionScopeCount: catalogVersion === 'v4' ? number(object(v4?.executionScopes).total) : Number(catalogs.scopeCount),
      exactProfileCount: catalogVersion === 'v4' ? number(object(v4?.profileAuthority).currentProfileCount) : Number(profiles.profileCount),
      frozenBaselineOnly: catalogVersion === 'v3',
      currentVersionInputIncluded: catalogVersion === 'v4' && v4 !== null,
      finalM4GatePassed: false,
    },
    independentSourceAndAuthorityChecksValid: factsValid,
    objectiveTargetBasisPoints: TARGET_BPS,
    objectiveEstablished: goal.objectiveEstablished,
    goal: { ...goal, blockers: [...goal.blockers] },
    captureTimeInterpretation: {
      frozenM1RosterCaptureUtc: inputs.market.snapshotObservedAtUtc,
      currentM2ActivityCaptureUtc: inputs.m2Activity.captureTimestampUtc,
      auditAsOf: inputs.auditAsOf,
      currentActivityCaptureKnownAndFresh: activity.activityCaptureWithin90Days,
      auditAsOfIsProviderCaptureTime: false,
      auditAsOfMeaning: 'Deterministic verifier cutoff only; source capture timestamps are reported independently and date-only metadata remains date-only.',
    },
    functionCatalog: catalogs,
    frozenV3Baseline: {
      functionCount: Number(catalogs.v3FunctionCount),
      scopeCount: Number(catalogs.scopeCount),
      profileCount: Number(profiles.profileCount),
      profileReferenceCount: Number(profiles.profileReferenceCount),
      profileFixtureSha256: inputs.v3ProfileFixtureSha256 ?? null,
      profileFixtureValid: v3ProfileFixtureValid,
    },
    currentCatalogVerification: v4 ? { ...v4, historicalV3ClosureValid: baseFactsValid, verifierValid: v4.verifierValid === true && baseFactsValid } : null,
    identityAndActivity: activity,
    workflows,
    profiles,
    inputSourceDigestsVerified: inputDigestsVerified,
    legacyM3ReportComparison: {
      comparedOnlyForDiscrepancies: true,
      comparisonCatalogVersion: 'v3',
      legacyComparisonMatchesIndependentSetCardinalities: legacyCountsMatchDerivedSets,
      m3ReportedActiveProducts: number(object(inputs.m3ComparisonReport.products).activeProducts),
      m3ReportedUnresolvedProducts: number(object(inputs.m3ComparisonReport.products).unresolvedProducts),
      m3ReportedConservativeDenominator: number(object(inputs.m3ComparisonReport.products).conservativeDenominator),
      reportUnresolvedCountIsObservationSetCount: false,
      reportCountsAssumedDisjoint: false,
      reportCountFormulaReconstructed: false,
      reportActiveCountMatchesObservationSetCardinality: number(reportProducts.activeProducts) === obsAccounting.activeProductCount,
      reportUnresolvedCountMatchesIndependentRosterSetCardinality: number(reportProducts.unresolvedProducts) === rosterSetAccounting.unresolvedSourceIdCount,
      reportConservativeDenominatorMatchesIndependentSetUnion: number(reportProducts.conservativeDenominator) === rosterSetAccounting.activeUnresolvedUnionCount,
      independentlyDerivedInclusionExclusionUnion: rosterSetAccounting.inclusionExclusionUnionCount,
      independentUnionEqualsRawRosterRows: rosterSetAccounting.unionEqualsFrozenRoster,
      observationSetAccounting: object(workflows.observationSetAccounting),
      reportIsNotAuthorityForThisAudit: true,
    },
    limitations: [
      '8,476 raw protocol rows remain a source-row universe, not 8,476 independently verified distinct products; 8,472 source identities remain unresolved/partial proxy rows and seven metric IDs remain unmatched.',
      'Identity dispositions (four canonical mappings, one partial mapping, 8,471 unresolved ledger identities), proxy accounting (8,472), observation status sets, and legacy report fields are distinct evidence sets. Excluding lineage-only observations, status rows yield three active IDs and three unresolved IDs among four coverage units; their intersection is two and union is four. For the frozen-roster sets, the 8,472 unresolved proxy rows are unioned with the observed unresolved canonical IDs; two active IDs overlap unresolved, yielding active=3, unresolved=8,475, intersection=2, union=8,476 by inclusion-exclusion. This independently matches the legacy report cardinalities without treating its counts as disjoint or reconstructing its calculation formula. Seven unmatched metric IDs are not extra roster rows.',
      'Current known capture UTC is 2026-10-03T19:11:22Z; the older M1 roster capture time remains unknown and is not propagated over M2/M3 evidence.',
      'Positive eligible activity is a 30-day DEX volume observation proving occurrence within an enclosing 90-day window, not a 90-day total. Zero/missing/unqualified fees are not inactivity.',
      'Function-scope bundles prove only fixed target/function role progress; they do not prove complete core workflows, product-instance populations, chain coverage, live execution, liquidity, or market completeness.',
      'Compound V2 source ID 114 has identity mapping only; BORROW_INTEREST fee values remain unqualified as user activity.',
    ],
  };
  const evidence: JsonObject = {
    schemaVersion: 1,
    auditedCatalogVersion: catalogVersion,
    auditAsOf: inputs.auditAsOf,
    sourceFiles: expectedFiles,
    protocolUniverseCompactSha256: inputs.protocolUniverseCompactSha256,
    sourceAuditMethod: 'Raw-byte SHA-256 for named input files; frozen roster SHA-256 over original compact JSON array lexemes; Keccak ABI/scope fingerprints independently canonicalized here.',
    factsValid,
    outputReportSha256: sha256(stableJson(report)),
  };
  return { report, evidence };
}

function string(value: JsonValue | undefined): string { return typeof value === 'string' ? value : ''; }

export const INDEPENDENT_AUDIT_DEFAULT_AS_OF = CURRENT_AS_OF;

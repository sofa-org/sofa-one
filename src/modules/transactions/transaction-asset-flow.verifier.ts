import { createHash } from 'crypto';
import { ethAddress, getAddress, isAddress } from 'viem';

/**
 * Simulation-evidence asset-flow verifier (Gate 1 final remediation).
 *
 * Pure parser: no network, no DB. Protocol-neutral, fail-closed.
 *
 * `verified` is unreachable from ordinary JSON/DTO-reconstructed evidence.
 * It requires a module-private opaque producer authority (WeakSet membership)
 * that only a trusted sealer can grant. Production `simulateAssetFlowEvidence`
 * never grants authority.
 *
 * Relations (when authorized) must precisely allocate observed outflow amounts
 * to relation legs by entryId — key-only pairing is insufficient.
 */

export const ASSET_FLOW_EVIDENCE_SCHEMA_VERSION = 'asset-flow-evidence.v1' as const;
export const ASSET_FLOW_RULE_VERSION = 'asset-flow-rules.v1' as const;

export type AssetFlowVerificationStatus = 'verified' | 'unknown' | 'external_transfer';
export type AssetFlowExecutionMode = 'session_key' | 'eoa';
export type AssetFlowSimulationMode = 'eth_simulateV1_non_atomic' | 'calibur_atomic';
export type CoverageCompleteness = 'complete' | 'incomplete' | 'unknown';

export type AssetFlowVerifierInteraction = {
  to: string;
  data: string;
  value?: string;
};

export type AssetFlowBlockIdentity = {
  number: bigint | null;
  hash: string | null;
};

export type AssetObservationCoverage = {
  completeness: CoverageCompleteness;
  probedAssetKeys?: readonly string[];
  probeFailures?: readonly string[];
  unobservedAssetKeys?: readonly string[];
};

export type InternalCallCoverage = {
  completeness: CoverageCompleteness;
  observed: boolean;
};

export type PermissionCoverage = {
  completeness: CoverageCompleteness;
  unknownPermissionChanges?: boolean;
  observedKinds?: readonly string[];
};

export type AssetFlowEvidenceCoverage = {
  assetObservation: AssetObservationCoverage;
  internalCalls: InternalCallCoverage;
  permissions: PermissionCoverage;
};

export type AssetKind = 'native' | 'erc20' | 'erc721' | 'erc1155' | 'unknown';

/**
 * Single owner-bound balance observation.
 * entryId is unique within one evidence envelope and is what relations reference.
 */
export type AssetChangeEvidence = {
  entryId: string;
  assetKey: string;
  kind: AssetKind;
  tokenAddress: string;
  /** Required for erc721 — decimal token id string. */
  tokenId?: string;
  pre: bigint;
  post: bigint;
  diff: bigint;
};

export type AssetRelationKind =
  | 'swap'
  | 'wrap'
  | 'unwrap'
  | 'supply_equity'
  | 'withdraw_equity'
  | 'exact_exchange';

/** One leg of a relation: exact amount drawn from a specific observed entry. */
export type AssetRelationLeg = {
  entryId: string;
  /** Non-negative amount allocated from the referenced entry's |diff|. */
  amount: bigint;
};

/**
 * Trusted relation with precise amount allocation.
 * Only meaningful when the evidence envelope carries producer authority.
 */
export type AssetRelation = {
  kind: AssetRelationKind;
  inputs: readonly AssetRelationLeg[];
  outputs: readonly AssetRelationLeg[];
};

export type AssetFlowEvidenceBinding = {
  ownerAddress: string;
  chainId: number;
  executionMode: AssetFlowExecutionMode;
  planDigest: string;
  schemaVersion: string;
  ruleVersion: string;
  baseBlock: AssetFlowBlockIdentity;
  simulatedBlock: AssetFlowBlockIdentity;
};

export type AssetFlowCallResult = {
  status: 'success' | 'failure' | string;
};

export type AssetFlowLogSummary = {
  completeness: CoverageCompleteness;
  count?: number;
};

/**
 * Structured evidence envelope.
 * Calldata / raw RPC / unsanitized logs must never appear.
 * Producer authority is NOT a serializable field — it is WeakSet membership.
 */
export type AssetFlowEvidence = {
  simulationMode: AssetFlowSimulationMode;
  binding: AssetFlowEvidenceBinding;
  coverage: AssetFlowEvidenceCoverage;
  results: ReadonlyArray<AssetFlowCallResult>;
  assetChanges: ReadonlyArray<AssetChangeEvidence>;
  relations: ReadonlyArray<AssetRelation>;
  logs: AssetFlowLogSummary;
};

export type VerifyTransactionAssetFlowInput = {
  ownerAddress: string;
  chainId: number;
  executionMode: AssetFlowExecutionMode;
  interactions: ReadonlyArray<AssetFlowVerifierInteraction>;
  evidence: AssetFlowEvidence;
};

export type AssetFlowVerificationResult = {
  status: AssetFlowVerificationStatus;
  rule: string;
  reason: string;
  simulationMode: AssetFlowSimulationMode | null;
  block: AssetFlowBlockIdentity | null;
};

/**
 * Draft used only by the trusted sealer (test/Phase-2 producer).
 * Not a public production builder for arbitrary verified claims.
 */
export type TrustedAssetFlowEvidenceDraft = {
  simulationMode: 'calibur_atomic';
  binding: AssetFlowEvidenceBinding;
  coverage: AssetFlowEvidenceCoverage;
  results: ReadonlyArray<AssetFlowCallResult>;
  assetChanges: ReadonlyArray<AssetChangeEvidence>;
  relations: ReadonlyArray<AssetRelation>;
  logs: AssetFlowLogSummary;
};

const ZERO = 0n;
const NATIVE_SENTINEL = ethAddress.toLowerCase();
const EXPECTED_SCHEMA = ASSET_FLOW_EVIDENCE_SCHEMA_VERSION;
const EXPECTED_RULES = ASSET_FLOW_RULE_VERSION;
const COMPLETENESS_VALUES = new Set<CoverageCompleteness>(['complete', 'incomplete', 'unknown']);
const RELATION_KINDS = new Set<AssetRelationKind>([
  'swap',
  'wrap',
  'unwrap',
  'supply_equity',
  'withdraw_equity',
  'exact_exchange',
]);
const ASSET_KINDS = new Set<AssetKind>(['native', 'erc20', 'erc721', 'erc1155', 'unknown']);

/**
 * Module-private registry of evidence objects sealed by a trusted producer.
 * JSON.parse / object spread / structuredClone yield new objects that are NOT members.
 * This is the only verified-path authority primitive.
 */
const TRUSTED_EVIDENCE_AUTHORITIES = new WeakSet<object>();

/**
 * Runtime/build guard: trusted sealer is unavailable in production and in any
 * non-test runtime. Jest sets JEST_WORKER_ID; NODE_ENV=production always denies.
 * Ordinary production imports that call this receive a hard rejection — no authority.
 */
function assertTestOnlyProducerAllowed(): void {
  const nodeEnv =
    typeof process !== 'undefined' && process.env ? process.env.NODE_ENV : undefined;
  const jestWorker =
    typeof process !== 'undefined' && process.env ? process.env.JEST_WORKER_ID : undefined;

  if (nodeEnv === 'production') {
    throw new Error('trusted_sealer_unavailable');
  }
  // Allow only Jest workers or an explicit test environment.
  if (!jestWorker && nodeEnv !== 'test') {
    throw new Error('trusted_sealer_unavailable');
  }
}

/**
 * Test-only trusted producer entry.
 * Production runtime/build cannot obtain WeakSet authority through this symbol:
 * the guard rejects production and non-test environments before sealing.
 * Grants opaque WeakSet authority that cannot be reconstructed from JSON/DTO fields.
 */
export function sealTrustedAssetFlowEvidenceForTests(
  draft: TrustedAssetFlowEvidenceDraft,
): AssetFlowEvidence {
  assertTestOnlyProducerAllowed();

  if (!draft || typeof draft !== 'object') {
    throw new Error('invalid_trusted_evidence_draft');
  }
  if (draft.simulationMode !== 'calibur_atomic') {
    throw new Error('trusted_sealer_requires_calibur_atomic');
  }

  // Deep-freeze a plain envelope; authority is WeakSet membership of this object identity.
  const evidence = deepFreeze({
    simulationMode: draft.simulationMode,
    binding: cloneBinding(draft.binding),
    coverage: cloneCoverage(draft.coverage),
    results: (draft.results ?? []).map((r) => deepFreeze({ status: r.status })),
    assetChanges: (draft.assetChanges ?? []).map((c) =>
      deepFreeze({
        entryId: c.entryId,
        assetKey: c.assetKey,
        kind: c.kind,
        tokenAddress: c.tokenAddress,
        ...(c.tokenId !== undefined ? { tokenId: c.tokenId } : {}),
        pre: c.pre,
        post: c.post,
        diff: c.diff,
      }),
    ),
    relations: (draft.relations ?? []).map((rel) =>
      deepFreeze({
        kind: rel.kind,
        inputs: (rel.inputs ?? []).map((leg) => deepFreeze({ entryId: leg.entryId, amount: leg.amount })),
        outputs: (rel.outputs ?? []).map((leg) => deepFreeze({ entryId: leg.entryId, amount: leg.amount })),
      }),
    ),
    logs: deepFreeze({
      completeness: draft.logs.completeness,
      ...(draft.logs.count !== undefined ? { count: draft.logs.count } : {}),
    }),
  }) as AssetFlowEvidence;

  TRUSTED_EVIDENCE_AUTHORITIES.add(evidence);
  return evidence;
}

/** Whether this object identity carries trusted producer authority. */
export function hasTrustedAssetFlowEvidenceAuthority(evidence: unknown): boolean {
  return typeof evidence === 'object' && evidence !== null && TRUSTED_EVIDENCE_AUTHORITIES.has(evidence);
}

/**
 * Verify owner asset/equity outcome from structured evidence.
 * Pure: no I/O.
 */
export function verifyTransactionAssetFlow(
  input: VerifyTransactionAssetFlowInput,
): AssetFlowVerificationResult {
  const evidence = input?.evidence;
  // M4: never cast/reflect arbitrary simulationMode strings into the result.
  const simulationMode = normalizeSimulationMode(
    evidence && typeof evidence === 'object'
      ? (evidence as { simulationMode?: unknown }).simulationMode
      : undefined,
  );
  const blockFromEvidence = extractSimulatedBlock(evidence as AssetFlowEvidence);

  if (!evidence || typeof evidence !== 'object') {
    return unknown('missing_evidence', 'Simulation evidence is missing', simulationMode, null);
  }

  // ── Binding (request vs evidence) ────────────────────────────────────────
  const bindingCheck = validateBinding(input, evidence as AssetFlowEvidence, simulationMode);
  if (!bindingCheck.ok) {
    return unknown(bindingCheck.rule, bindingCheck.reason, simulationMode, blockFromEvidence);
  }

  // ── Results ──────────────────────────────────────────────────────────────
  const interactions = Array.isArray(input.interactions) ? input.interactions : [];
  if (interactions.length === 0) {
    return unknown('empty_interactions', 'Interaction plan is empty', simulationMode, blockFromEvidence);
  }

  const resultsCheck = validateResults((evidence as AssetFlowEvidence).results, interactions.length);
  if (!resultsCheck.ok) {
    return unknown(resultsCheck.rule, resultsCheck.reason, simulationMode, blockFromEvidence);
  }

  // ── Strict coverage + logs schema ────────────────────────────────────────
  const coverageCheck = validateCoverageStrict(
    (evidence as AssetFlowEvidence).coverage,
    (evidence as AssetFlowEvidence).logs,
  );
  if (!coverageCheck.ok) {
    return unknown(coverageCheck.rule, coverageCheck.reason, simulationMode, blockFromEvidence);
  }

  // ── Simulation mode ──────────────────────────────────────────────────────
  if (simulationMode == null) {
    return unknown(
      'invalid_simulation_mode',
      'Simulation mode is unsupported',
      null,
      blockFromEvidence,
    );
  }
  if (simulationMode !== 'calibur_atomic') {
    return unknown(
      'non_atomic_simulation_mode',
      'Simulation mode is not an atomic execution proof',
      simulationMode,
      blockFromEvidence,
    );
  }

  // ── M1: producer authority required for any verified outcome ─────────────
  const hasAuthority = hasTrustedAssetFlowEvidenceAuthority(evidence);
  if (!hasAuthority) {
    return unknown(
      'missing_producer_authority',
      'Evidence lacks trusted producer authority and cannot be verified',
      simulationMode,
      blockFromEvidence,
    );
  }

  // ── Asset changes (strict) ───────────────────────────────────────────────
  const parsed = parseAssetChangesStrict((evidence as AssetFlowEvidence).assetChanges);
  if (!parsed.ok) {
    return unknown(parsed.rule, parsed.reason, simulationMode, blockFromEvidence);
  }

  // Observed keys must be subset of probed keys when probed list is present under complete coverage.
  const probeAlign = alignProbedKeys(
    (evidence as AssetFlowEvidence).coverage.assetObservation,
    parsed.changes,
  );
  if (!probeAlign.ok) {
    return unknown(probeAlign.rule, probeAlign.reason, simulationMode, blockFromEvidence);
  }

  // ── Relations (authorized + amount-exact) ────────────────────────────────
  const relationsRaw = (evidence as AssetFlowEvidence).relations;
  if (!Array.isArray(relationsRaw)) {
    return unknown('missing_relations', 'Asset relations evidence is missing', simulationMode, blockFromEvidence);
  }

  const relationCheck = validateRelationsExact(parsed.changes, relationsRaw);
  if (!relationCheck.ok) {
    if (relationCheck.status === 'external_transfer') {
      return {
        status: 'external_transfer',
        rule: relationCheck.rule,
        reason: relationCheck.reason,
        simulationMode,
        block: blockFromEvidence,
      };
    }
    return unknown(relationCheck.rule, relationCheck.reason, simulationMode, blockFromEvidence);
  }

  if (parsed.changes.length === 0) {
    return {
      status: 'verified',
      rule: 'owner_no_observed_asset_change',
      reason: 'Authorized atomic plan with complete coverage and no owner asset movement',
      simulationMode,
      block: blockFromEvidence,
    };
  }

  if (relationCheck.kind === 'swap_or_equity') {
    return {
      status: 'verified',
      rule: 'owner_asset_relation_verified',
      reason: 'Every owner outflow amount is exactly explained by authorized asset relations',
      simulationMode,
      block: blockFromEvidence,
    };
  }

  return {
    status: 'verified',
    rule: 'owner_asset_net_non_negative',
    reason: 'Authorized complete coverage with non-negative owner asset outcome',
    simulationMode,
    block: blockFromEvidence,
  };
}

// ── Plan digest ────────────────────────────────────────────────────────────

export function computeAssetFlowPlanDigest(input: {
  ownerAddress: string;
  chainId: number;
  executionMode: AssetFlowExecutionMode;
  interactions: ReadonlyArray<AssetFlowVerifierInteraction>;
}): string | null {
  const owner = normalizeAddress(input.ownerAddress);
  if (!owner) return null;
  if (typeof input.chainId !== 'number' || !Number.isSafeInteger(input.chainId) || input.chainId < 1) {
    return null;
  }
  if (input.executionMode !== 'session_key' && input.executionMode !== 'eoa') return null;

  const interactions = Array.isArray(input.interactions) ? input.interactions : [];
  const normalizedInteractions: Array<{ to: string; data: string; value: string }> = [];
  for (const interaction of interactions) {
    const normalized = normalizeInteractionForDigest(interaction);
    if (!normalized) return null;
    normalizedInteractions.push(normalized);
  }

  const body = [
    'v1',
    owner,
    String(input.chainId),
    input.executionMode,
    String(normalizedInteractions.length),
    ...normalizedInteractions.map((i) => `${i.to}|${i.data}|${i.value}`),
  ].join('\n');

  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function buildAssetKey(input: {
  kind: AssetKind;
  tokenAddress: string;
  tokenId?: string;
}): string | null {
  if (input.kind === 'native') return 'native';
  const addr = normalizeAddress(input.tokenAddress);
  if (!addr) return null;
  if (input.kind === 'erc20') return `erc20:${addr}`;
  if (input.kind === 'erc721') {
    if (typeof input.tokenId !== 'string' || !/^\d+$/.test(input.tokenId)) return null;
    // Canonical tokenId: strip leading zeros except bare "0"
    const tokenId = input.tokenId.replace(/^0+(?=\d)/, '') || '0';
    return `erc721:${addr}:${tokenId}`;
  }
  return null;
}

export function normalizeAssetTokenAddress(kind: AssetKind, address: string): string | null {
  if (kind === 'native') {
    const n = normalizeAddress(address);
    return n === NATIVE_SENTINEL ? n : null;
  }
  return normalizeAddress(address);
}

// ── Binding ────────────────────────────────────────────────────────────────

function validateBinding(
  input: VerifyTransactionAssetFlowInput,
  evidence: AssetFlowEvidence,
  simulationMode: AssetFlowSimulationMode | null,
): { ok: true } | { ok: false; rule: string; reason: string } {
  const binding = evidence.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    return { ok: false, rule: 'missing_binding', reason: 'Evidence binding is missing' };
  }

  if (typeof binding.schemaVersion !== 'string' || binding.schemaVersion !== EXPECTED_SCHEMA) {
    return { ok: false, rule: 'schema_version_mismatch', reason: 'Evidence schema version is unsupported' };
  }
  if (typeof binding.ruleVersion !== 'string' || binding.ruleVersion !== EXPECTED_RULES) {
    return { ok: false, rule: 'rule_version_mismatch', reason: 'Evidence rule version is unsupported' };
  }

  const requestOwner = normalizeAddress(input.ownerAddress);
  if (!requestOwner) {
    return { ok: false, rule: 'invalid_owner_address', reason: 'Owner address is invalid' };
  }
  if (typeof binding.ownerAddress !== 'string') {
    return { ok: false, rule: 'invalid_binding_owner', reason: 'Evidence owner binding type is invalid' };
  }
  const boundOwner = normalizeAddress(binding.ownerAddress);
  if (!boundOwner || boundOwner !== requestOwner) {
    return { ok: false, rule: 'owner_binding_mismatch', reason: 'Evidence owner does not match request owner' };
  }

  if (typeof input.chainId !== 'number' || !Number.isSafeInteger(input.chainId) || input.chainId < 1) {
    return { ok: false, rule: 'invalid_chain_id', reason: 'Chain id is invalid' };
  }
  if (
    typeof binding.chainId !== 'number' ||
    !Number.isSafeInteger(binding.chainId) ||
    binding.chainId !== input.chainId
  ) {
    return { ok: false, rule: 'chain_binding_mismatch', reason: 'Evidence chain does not match request chain' };
  }

  if (input.executionMode !== 'session_key' && input.executionMode !== 'eoa') {
    return { ok: false, rule: 'invalid_execution_mode', reason: 'Execution mode is invalid' };
  }
  if (binding.executionMode !== input.executionMode) {
    return {
      ok: false,
      rule: 'execution_mode_binding_mismatch',
      reason: 'Evidence execution mode does not match request',
    };
  }

  // M3: block identity is strict. Authorized/atomic evidence requires complete base+simulated.
  // Production non-atomic observation may leave base absent (null/null) — never forged from simulated.
  const baseCheck = validateBlockField(binding.baseBlock, 'base');
  const simulatedCheck = validateBlockField(binding.simulatedBlock, 'simulated');
  if (!simulatedCheck.ok) {
    return { ok: false, rule: simulatedCheck.rule, reason: simulatedCheck.reason };
  }
  if (simulationMode === 'calibur_atomic') {
    // Atomic/authorized path: both blocks must be complete (number + hash).
    if (!isCompleteBlockIdentity(binding.baseBlock)) {
      return { ok: false, rule: 'missing_base_block', reason: 'Base block identity is missing or invalid' };
    }
    if (!isCompleteBlockIdentity(binding.simulatedBlock)) {
      return {
        ok: false,
        rule: 'missing_simulated_block',
        reason: 'Simulated block identity is missing or invalid',
      };
    }
  } else {
    // Observation path: base may be fully absent; if present it must be complete (no partial junk).
    if (!baseCheck.ok) {
      return { ok: false, rule: baseCheck.rule, reason: baseCheck.reason };
    }
  }

  const expectedDigest = computeAssetFlowPlanDigest({
    ownerAddress: requestOwner,
    chainId: input.chainId,
    executionMode: input.executionMode,
    interactions: input.interactions,
  });
  if (!expectedDigest) {
    return { ok: false, rule: 'plan_digest_uncomputable', reason: 'Interaction plan could not be digested' };
  }
  if (typeof binding.planDigest !== 'string' || binding.planDigest !== expectedDigest) {
    return { ok: false, rule: 'plan_digest_mismatch', reason: 'Evidence plan digest does not match request plan' };
  }

  return { ok: true };
}

/** Complete block: non-negative block number + strict 32-byte 0x-hash. Both required. */
function isCompleteBlockIdentity(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const b = block as AssetFlowBlockIdentity;
  const number = parseNonNegativeBlockNumber(b.number);
  const hash = parseBlockHash(b.hash);
  return number != null && hash != null;
}

/** Fully unavailable baseline (production eth_simulateV1 has no trusted base fork id). */
function isAbsentBlockIdentity(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const b = block as AssetFlowBlockIdentity;
  return (b.number === null || b.number === undefined) && (b.hash === null || b.hash === undefined);
}

/**
 * Validate a block field: either complete, fully absent, or invalid.
 * Rejects partial/malformed values (-1n, bad hash, unsafe numbers, one-sided identity).
 */
function validateBlockField(
  block: unknown,
  which: 'base' | 'simulated',
): { ok: true } | { ok: false; rule: string; reason: string } {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return {
      ok: false,
      rule: which === 'base' ? 'missing_base_block' : 'missing_simulated_block',
      reason: which === 'base' ? 'Base block identity is missing or invalid' : 'Simulated block identity is missing or invalid',
    };
  }
  if (isAbsentBlockIdentity(block)) {
    return { ok: true };
  }
  if (isCompleteBlockIdentity(block)) {
    return { ok: true };
  }
  return {
    ok: false,
    rule: which === 'base' ? 'invalid_base_block' : 'invalid_simulated_block',
    reason: which === 'base' ? 'Base block identity is malformed' : 'Simulated block identity is malformed',
  };
}

function parseNonNegativeBlockNumber(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= ZERO ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  return null;
}

function parseBlockHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

function normalizeSimulationMode(value: unknown): AssetFlowSimulationMode | null {
  if (value === 'eth_simulateV1_non_atomic' || value === 'calibur_atomic') {
    return value;
  }
  return null;
}

// ── Results ────────────────────────────────────────────────────────────────

function validateResults(
  results: unknown,
  expectedLength: number,
): { ok: true } | { ok: false; rule: string; reason: string } {
  if (!Array.isArray(results)) {
    return { ok: false, rule: 'missing_results', reason: 'Simulation results are missing' };
  }
  if (results.length !== expectedLength) {
    return {
      ok: false,
      rule: 'results_length_mismatch',
      reason: 'Simulation results length does not match interaction plan',
    };
  }
  for (const result of results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { ok: false, rule: 'missing_result', reason: 'Simulation result entry is missing' };
    }
    if (typeof (result as AssetFlowCallResult).status !== 'string') {
      return { ok: false, rule: 'malformed_result_status', reason: 'Simulation result status is malformed' };
    }
    if ((result as AssetFlowCallResult).status !== 'success') {
      return { ok: false, rule: 'call_not_success', reason: 'Simulation call did not succeed' };
    }
  }
  return { ok: true };
}

// ── Coverage strict runtime schema (M2) ────────────────────────────────────

function validateCoverageStrict(
  coverage: unknown,
  logs: unknown,
): { ok: true } | { ok: false; rule: string; reason: string } {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return { ok: false, rule: 'missing_coverage', reason: 'Evidence coverage is missing' };
  }
  const c = coverage as AssetFlowEvidenceCoverage;

  // assetObservation
  const asset = c.assetObservation;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    return { ok: false, rule: 'missing_asset_coverage', reason: 'Asset observation coverage is missing' };
  }
  if (!isCompleteness(asset.completeness)) {
    return { ok: false, rule: 'invalid_asset_coverage_completeness', reason: 'Asset coverage completeness is invalid' };
  }
  if (asset.completeness !== 'complete') {
    return {
      ok: false,
      rule: 'incomplete_asset_coverage',
      reason: 'Asset observation coverage is incomplete or unknown',
    };
  }
  if ('probeFailures' in asset) {
    if (!isStringArray(asset.probeFailures)) {
      return { ok: false, rule: 'invalid_probe_failures', reason: 'probeFailures must be a string array' };
    }
    if (asset.probeFailures.length > 0) {
      return { ok: false, rule: 'asset_probe_failure', reason: 'One or more asset probes failed' };
    }
  }
  if ('unobservedAssetKeys' in asset) {
    if (!isStringArray(asset.unobservedAssetKeys)) {
      return {
        ok: false,
        rule: 'invalid_unobserved_asset_keys',
        reason: 'unobservedAssetKeys must be a string array',
      };
    }
    if (asset.unobservedAssetKeys.length > 0) {
      return { ok: false, rule: 'unobserved_assets', reason: 'Known assets were not observed' };
    }
  }
  if ('probedAssetKeys' in asset && asset.probedAssetKeys !== undefined) {
    if (!isStringArray(asset.probedAssetKeys)) {
      return { ok: false, rule: 'invalid_probed_asset_keys', reason: 'probedAssetKeys must be a string array' };
    }
  }

  // internalCalls
  const internal = c.internalCalls;
  if (!internal || typeof internal !== 'object' || Array.isArray(internal)) {
    return { ok: false, rule: 'missing_internal_call_coverage', reason: 'Internal call coverage is missing' };
  }
  if (!isCompleteness(internal.completeness)) {
    return {
      ok: false,
      rule: 'invalid_internal_call_completeness',
      reason: 'Internal call coverage completeness is invalid',
    };
  }
  if (typeof internal.observed !== 'boolean') {
    return {
      ok: false,
      rule: 'invalid_internal_call_observed',
      reason: 'Internal call observed flag must be boolean',
    };
  }
  if (internal.completeness !== 'complete' || internal.observed !== true) {
    return {
      ok: false,
      rule: 'incomplete_internal_call_coverage',
      reason: 'Internal call coverage is incomplete; nested authority changes are unproven',
    };
  }

  // permissions
  const permissions = c.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return { ok: false, rule: 'missing_permission_coverage', reason: 'Permission coverage is missing' };
  }
  if (!isCompleteness(permissions.completeness)) {
    return {
      ok: false,
      rule: 'invalid_permission_completeness',
      reason: 'Permission coverage completeness is invalid',
    };
  }
  if (permissions.completeness !== 'complete') {
    return {
      ok: false,
      rule: 'incomplete_permission_coverage',
      reason: 'Permission coverage is incomplete or unknown',
    };
  }
  if ('unknownPermissionChanges' in permissions && permissions.unknownPermissionChanges !== undefined) {
    if (typeof permissions.unknownPermissionChanges !== 'boolean') {
      return {
        ok: false,
        rule: 'invalid_unknown_permission_changes',
        reason: 'unknownPermissionChanges must be boolean',
      };
    }
    if (permissions.unknownPermissionChanges === true) {
      return {
        ok: false,
        rule: 'unknown_permission_changes',
        reason: 'Unknown permission or allowance changes were observed',
      };
    }
  }
  if ('observedKinds' in permissions && permissions.observedKinds !== undefined) {
    if (!isStringArray(permissions.observedKinds)) {
      return { ok: false, rule: 'invalid_observed_permission_kinds', reason: 'observedKinds must be a string array' };
    }
    if (permissions.observedKinds.length > 0) {
      return {
        ok: false,
        rule: 'permission_change_observed',
        reason: 'Permission or allowance changes cannot be verified as retained value',
      };
    }
  }

  // logs
  if (!logs || typeof logs !== 'object' || Array.isArray(logs)) {
    return { ok: false, rule: 'missing_log_coverage', reason: 'Log coverage summary is missing' };
  }
  const logSummary = logs as AssetFlowLogSummary;
  if (!isCompleteness(logSummary.completeness)) {
    return { ok: false, rule: 'invalid_log_completeness', reason: 'Log coverage completeness is invalid' };
  }
  if (logSummary.completeness !== 'complete') {
    return { ok: false, rule: 'incomplete_log_coverage', reason: 'Log coverage is incomplete or unknown' };
  }
  if ('count' in logSummary && logSummary.count !== undefined) {
    if (typeof logSummary.count !== 'number' || !Number.isInteger(logSummary.count) || logSummary.count < 0) {
      return { ok: false, rule: 'invalid_log_count', reason: 'Log count must be a non-negative integer' };
    }
  }

  return { ok: true };
}

function alignProbedKeys(
  assetObservation: AssetObservationCoverage,
  changes: AssetChangeEvidence[],
): { ok: true } | { ok: false; rule: string; reason: string } {
  if (!('probedAssetKeys' in assetObservation) || assetObservation.probedAssetKeys === undefined) {
    // Complete coverage without an explicit probed list is allowed only when there are no changes,
    // or when the producer omitted the list (still complete claim). Prefer requiring list when changes exist.
    if (changes.length > 0) {
      return {
        ok: false,
        rule: 'missing_probed_asset_keys',
        reason: 'Complete coverage with asset changes requires probedAssetKeys',
      };
    }
    return { ok: true };
  }

  const probed = new Set(assetObservation.probedAssetKeys);
  for (const change of changes) {
    if (!probed.has(change.assetKey)) {
      return {
        ok: false,
        rule: 'observed_not_in_probed_keys',
        reason: 'Observed asset key is not listed in probedAssetKeys',
      };
    }
  }
  return { ok: true };
}

// ── Asset changes ──────────────────────────────────────────────────────────

function parseAssetChangesStrict(
  rawChanges: unknown,
):
  | { ok: true; changes: AssetChangeEvidence[] }
  | { ok: false; rule: string; reason: string } {
  if (!Array.isArray(rawChanges)) {
    return { ok: false, rule: 'malformed_asset_changes', reason: 'Asset changes evidence is malformed' };
  }

  const seenEntryIds = new Set<string>();
  const seenAssetKeys = new Set<string>();
  const changes: AssetChangeEvidence[] = [];

  for (const raw of rawChanges) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, rule: 'malformed_asset_change', reason: 'Asset change entry is malformed' };
    }
    const c = raw as AssetChangeEvidence;

    if (typeof c.entryId !== 'string' || c.entryId.length === 0 || c.entryId.length > 128) {
      return { ok: false, rule: 'invalid_asset_entry_id', reason: 'Asset change entryId is invalid' };
    }
    if (seenEntryIds.has(c.entryId)) {
      return { ok: false, rule: 'duplicate_asset_entry_id', reason: 'Duplicate asset entryId in evidence' };
    }
    seenEntryIds.add(c.entryId);

    if (typeof c.kind !== 'string' || !ASSET_KINDS.has(c.kind)) {
      return { ok: false, rule: 'unsupported_asset_kind', reason: 'Asset kind is unsupported or unknown' };
    }
    if (c.kind === 'erc1155') {
      return {
        ok: false,
        rule: 'erc1155_unsupported',
        reason: 'ERC-1155 asset evidence is outside supported balance scope',
      };
    }
    if (c.kind === 'unknown') {
      return { ok: false, rule: 'unsupported_asset_kind', reason: 'Asset kind is unsupported or unknown' };
    }
    if (c.kind === 'erc721') {
      if (typeof c.tokenId !== 'string' || !/^\d+$/.test(c.tokenId)) {
        return {
          ok: false,
          rule: 'erc721_token_id_required',
          reason: 'ERC-721 evidence requires a decimal tokenId string',
        };
      }
    } else if (c.tokenId !== undefined) {
      return {
        ok: false,
        rule: 'unexpected_token_id',
        reason: 'tokenId is only valid for ERC-721 asset evidence',
      };
    }

    if (typeof c.tokenAddress !== 'string') {
      return { ok: false, rule: 'invalid_asset_token_address', reason: 'Asset token address is invalid' };
    }
    const tokenAddress = normalizeAssetTokenAddress(c.kind, c.tokenAddress);
    if (!tokenAddress) {
      return { ok: false, rule: 'invalid_asset_token_address', reason: 'Asset token address is invalid' };
    }

    const canonicalTokenId =
      c.kind === 'erc721' && typeof c.tokenId === 'string'
        ? c.tokenId.replace(/^0+(?=\d)/, '') || '0'
        : undefined;

    const expectedKey = buildAssetKey({
      kind: c.kind,
      tokenAddress,
      tokenId: canonicalTokenId,
    });
    if (!expectedKey || typeof c.assetKey !== 'string' || c.assetKey !== expectedKey) {
      return { ok: false, rule: 'asset_key_mismatch', reason: 'Asset key does not match normalized identity' };
    }
    if (seenAssetKeys.has(c.assetKey)) {
      return { ok: false, rule: 'duplicate_asset_key', reason: 'Duplicate asset key in evidence' };
    }
    seenAssetKeys.add(c.assetKey);

    const pre = asNonNegativeBigInt(c.pre);
    const post = asNonNegativeBigInt(c.post);
    const diff = asBigInt(c.diff);
    if (pre == null || post == null || diff == null) {
      return {
        ok: false,
        rule: 'malformed_asset_value',
        reason: 'Asset pre/post must be non-negative bigint and diff bigint-compatible',
      };
    }
    if (diff !== post - pre) {
      return {
        ok: false,
        rule: 'inconsistent_asset_diff',
        reason: 'Asset change diff does not equal post - pre',
      };
    }

    if (diff === ZERO) {
      // Zero-diff rows still consume entryId/key uniqueness but are not relation subjects.
      continue;
    }

    changes.push({
      entryId: c.entryId,
      assetKey: c.assetKey,
      kind: c.kind,
      tokenAddress: c.kind === 'native' ? ethAddress : getAddress(tokenAddress),
      ...(canonicalTokenId !== undefined ? { tokenId: canonicalTokenId } : {}),
      pre,
      post,
      diff,
    });
  }

  return { ok: true, changes };
}

// ── Relations: amount-exact (M1) ───────────────────────────────────────────

function validateRelationsExact(
  changes: AssetChangeEvidence[],
  relations: ReadonlyArray<AssetRelation>,
):
  | { ok: true; kind: 'none' | 'inflow_only' | 'swap_or_equity' }
  | { ok: false; status: 'unknown' | 'external_transfer'; rule: string; reason: string } {
  const byEntryId = new Map(changes.map((c) => [c.entryId, c]));
  const negatives = changes.filter((c) => c.diff < ZERO);
  const positives = changes.filter((c) => c.diff > ZERO);

  // Allocated amounts per entry (sum of relation legs).
  const allocatedIn = new Map<string, bigint>(); // entryId → sum of input amounts
  const allocatedOut = new Map<string, bigint>(); // entryId → sum of output amounts

  for (const relation of relations) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'malformed_relation',
        reason: 'Asset relation entry is malformed',
      };
    }
    if (typeof relation.kind !== 'string' || !RELATION_KINDS.has(relation.kind)) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'unsupported_relation_kind',
        reason: 'Asset relation kind is unsupported',
      };
    }
    if (!Array.isArray(relation.inputs) || !Array.isArray(relation.outputs)) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'malformed_relation',
        reason: 'Asset relation inputs/outputs are malformed',
      };
    }
    if (relation.inputs.length === 0 || relation.outputs.length === 0) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'empty_relation_side',
        reason: 'Asset relation must have both inputs and outputs',
      };
    }

    for (const leg of relation.inputs) {
      const parsedLeg = parseRelationLeg(leg, byEntryId, 'input');
      if (!parsedLeg.ok) {
        return { ok: false, status: 'unknown', rule: parsedLeg.rule, reason: parsedLeg.reason };
      }
      const prev = allocatedIn.get(parsedLeg.entryId) ?? ZERO;
      allocatedIn.set(parsedLeg.entryId, prev + parsedLeg.amount);
    }

    for (const leg of relation.outputs) {
      const parsedLeg = parseRelationLeg(leg, byEntryId, 'output');
      if (!parsedLeg.ok) {
        return { ok: false, status: 'unknown', rule: parsedLeg.rule, reason: parsedLeg.reason };
      }
      const prev = allocatedOut.get(parsedLeg.entryId) ?? ZERO;
      allocatedOut.set(parsedLeg.entryId, prev + parsedLeg.amount);
    }
  }

  // Every negative entry must be fully allocated (sum of input legs === |diff|).
  const unexplainedNegatives: AssetChangeEvidence[] = [];
  for (const neg of negatives) {
    const magnitude = -neg.diff;
    const allocated = allocatedIn.get(neg.entryId) ?? ZERO;
    if (allocated === ZERO) {
      unexplainedNegatives.push(neg);
      continue;
    }
    if (allocated !== magnitude) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'relation_input_amount_mismatch',
        reason: 'Relation input amounts do not exactly equal observed outflow',
      };
    }
  }

  // Output allocations must exactly equal positive diffs when referenced.
  for (const [entryId, allocated] of allocatedOut) {
    const change = byEntryId.get(entryId);
    if (!change || change.diff <= ZERO) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'relation_output_missing_inflow',
        reason: 'Relation output has no matching owner inflow',
      };
    }
    if (allocated !== change.diff) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'relation_output_amount_mismatch',
        reason: 'Relation output amounts do not exactly equal observed inflow',
      };
    }
  }

  // Input allocations must not reference positives or over-allocate (already checked equality).
  for (const [entryId] of allocatedIn) {
    const change = byEntryId.get(entryId);
    if (!change || change.diff >= ZERO) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'relation_input_missing_outflow',
        reason: 'Relation input has no matching owner outflow',
      };
    }
  }

  if (unexplainedNegatives.length > 0) {
    if (relations.length === 0 && positives.length === 0) {
      return {
        ok: false,
        status: 'external_transfer',
        rule: 'owner_outflow_uncompensated',
        reason: 'Owner asset decrease without compensating relation',
      };
    }
    if (relations.length === 0 && positives.length > 0) {
      return {
        ok: false,
        status: 'unknown',
        rule: 'outflow_masked_by_unrelated_inflow',
        reason: 'Owner outflow is not explained by an explicit asset relation',
      };
    }
    // Partial relations left some outflow unexplained (e.g. small swap + large extra transfer).
    return {
      ok: false,
      status: 'unknown',
      rule: 'unexplained_owner_outflow',
      reason: 'Owner outflow amount is not fully allocated to authorized relations',
    };
  }

  // Positives not referenced by any relation:
  // - allowed when there are no negatives and no relations (pure inflow)
  // - if relations exist, every positive used as compensation must be exact; extra dust → unknown
  const uncoveredPositives = positives.filter((p) => !allocatedOut.has(p.entryId));
  if (relations.length > 0 && uncoveredPositives.length > 0) {
    return {
      ok: false,
      status: 'unknown',
      rule: 'unrelated_inflow_dust',
      reason: 'Owner inflow is not part of a declared asset relation',
    };
  }

  if (negatives.length === 0 && positives.length === 0) return { ok: true, kind: 'none' };
  if (negatives.length === 0 && positives.length > 0) return { ok: true, kind: 'inflow_only' };
  return { ok: true, kind: 'swap_or_equity' };
}

function parseRelationLeg(
  leg: unknown,
  byEntryId: Map<string, AssetChangeEvidence>,
  side: 'input' | 'output',
):
  | { ok: true; entryId: string; amount: bigint }
  | { ok: false; rule: string; reason: string } {
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
    return { ok: false, rule: 'malformed_relation_leg', reason: 'Relation leg is malformed' };
  }
  const typed = leg as AssetRelationLeg;
  if (typeof typed.entryId !== 'string' || typed.entryId.length === 0) {
    return { ok: false, rule: 'malformed_relation_asset_key', reason: 'Relation leg entryId is invalid' };
  }
  if (!byEntryId.has(typed.entryId)) {
    return {
      ok: false,
      rule: side === 'input' ? 'relation_input_missing_outflow' : 'relation_output_missing_inflow',
      reason: 'Relation leg references an unknown asset entry',
    };
  }
  const amount = asNonNegativeBigInt(typed.amount);
  if (amount == null || amount === ZERO) {
    return {
      ok: false,
      rule: 'invalid_relation_amount',
      reason: 'Relation leg amount must be a positive non-negative bigint',
    };
  }
  return { ok: true, entryId: typed.entryId, amount };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractSimulatedBlock(evidence: AssetFlowEvidence | null | undefined): AssetFlowBlockIdentity | null {
  const block = evidence?.binding?.simulatedBlock;
  if (!block || typeof block !== 'object') return null;
  return {
    number: parseNonNegativeBlockNumber(block.number),
    hash: parseBlockHash(block.hash),
  };
}

function unknown(
  rule: string,
  reason: string,
  simulationMode: AssetFlowSimulationMode | null,
  block: AssetFlowBlockIdentity | null,
): AssetFlowVerificationResult {
  return { status: 'unknown', rule, reason, simulationMode, block };
}

function isCompleteness(value: unknown): value is CoverageCompleteness {
  return typeof value === 'string' && COMPLETENESS_VALUES.has(value as CoverageCompleteness);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  // M2: number inputs must be safe integers only (no float / unsafe / NaN / Infinity).
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function asNonNegativeBigInt(value: unknown): bigint | null {
  const n = asBigInt(value);
  if (n == null || n < ZERO) return null;
  return n;
}

function normalizeAddress(address: string | null | undefined): string | null {
  if (!address || typeof address !== 'string') return null;
  if (!isAddress(address)) return null;
  try {
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

function normalizeInteractionForDigest(
  interaction: AssetFlowVerifierInteraction | null | undefined,
): { to: string; data: string; value: string } | null {
  if (!interaction || typeof interaction !== 'object') return null;
  const to = normalizeAddress(interaction.to);
  if (!to) return null;

  if (typeof interaction.data !== 'string') return null;
  let data: string;
  if (interaction.data === '0x' || interaction.data === '0X') {
    data = '0x';
  } else if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(interaction.data)) {
    return null;
  } else if (interaction.data.length > 2 && interaction.data.length < 10) {
    return null;
  } else {
    data = interaction.data.toLowerCase();
  }

  let value = '0';
  if (interaction.value !== undefined && interaction.value !== null && interaction.value !== '') {
    if (typeof interaction.value !== 'string' || !/^\d+$/.test(interaction.value)) return null;
    value = interaction.value.replace(/^0+(?=\d)/, '') || '0';
  }

  return { to, data, value };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) {
      deepFreeze(child);
    }
  }
  return value;
}

function cloneBinding(binding: AssetFlowEvidenceBinding): AssetFlowEvidenceBinding {
  return {
    ownerAddress: binding.ownerAddress,
    chainId: binding.chainId,
    executionMode: binding.executionMode,
    planDigest: binding.planDigest,
    schemaVersion: binding.schemaVersion,
    ruleVersion: binding.ruleVersion,
    baseBlock: { number: binding.baseBlock.number, hash: binding.baseBlock.hash },
    simulatedBlock: {
      number: binding.simulatedBlock.number,
      hash: binding.simulatedBlock.hash,
    },
  };
}

function cloneStringArrayField(value: unknown): readonly string[] | unknown {
  // Preserve non-arrays as-is so the verifier's strict schema can reject them.
  // Never spread strings into character arrays (would launder invalid types).
  if (Array.isArray(value)) {
    return value.map((item) => item);
  }
  return value;
}

function cloneCoverage(coverage: AssetFlowEvidenceCoverage): AssetFlowEvidenceCoverage {
  const asset = coverage.assetObservation ?? ({} as AssetObservationCoverage);
  const permissions = coverage.permissions ?? ({} as PermissionCoverage);
  const internal = coverage.internalCalls ?? ({} as InternalCallCoverage);

  const assetObservation: AssetObservationCoverage = {
    completeness: asset.completeness,
  };
  if ('probedAssetKeys' in asset && asset.probedAssetKeys !== undefined) {
    (assetObservation as { probedAssetKeys?: unknown }).probedAssetKeys = cloneStringArrayField(
      asset.probedAssetKeys,
    );
  }
  if ('probeFailures' in asset && asset.probeFailures !== undefined) {
    (assetObservation as { probeFailures?: unknown }).probeFailures = cloneStringArrayField(
      asset.probeFailures,
    );
  }
  if ('unobservedAssetKeys' in asset && asset.unobservedAssetKeys !== undefined) {
    (assetObservation as { unobservedAssetKeys?: unknown }).unobservedAssetKeys =
      cloneStringArrayField(asset.unobservedAssetKeys);
  }

  const permissionsOut: PermissionCoverage = {
    completeness: permissions.completeness,
  };
  if ('unknownPermissionChanges' in permissions && permissions.unknownPermissionChanges !== undefined) {
    (permissionsOut as { unknownPermissionChanges?: unknown }).unknownPermissionChanges =
      permissions.unknownPermissionChanges;
  }
  if ('observedKinds' in permissions && permissions.observedKinds !== undefined) {
    (permissionsOut as { observedKinds?: unknown }).observedKinds = cloneStringArrayField(
      permissions.observedKinds,
    );
  }

  return {
    assetObservation,
    internalCalls: {
      completeness: internal.completeness,
      observed: internal.observed as boolean,
    },
    permissions: permissionsOut,
  };
}

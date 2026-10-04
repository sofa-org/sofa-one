import { createHash } from 'node:crypto';
import { parseAbiItem, toFunctionSelector } from 'viem';
import { buildDefiManifestHash, buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';
import { executionScopeHash } from '../execution/scope';
import type { DefiExecutionScope } from '../defi.types';
import { V6_SOURCE_IDENTITIES } from './v6-identities';
import { V7_SOURCE_IDENTITIES } from './v7-identities';

export const BASELINE_MANIFEST_HASH = '0x43ec3be0b20a32457719d8edb17c8eaa40c93480921d6e7c86e9c2cacdec5897' as const;

const TOP_KEYS = ['schemaVersion', 'chains'];
const CHAIN_KEYS = ['chainId', 'status', 'contracts'];
const CONTRACT_KEYS = ['address', 'status', 'functions'];
const FUNCTION_KEYS = ['capabilityId', 'type', 'chainId', 'contract', 'functionName', 'signature', 'abi', 'abiHash', 'status', 'provenance', 'policy', 'label', 'description', 'protocol', 'operation', 'warnings', 'inactiveReason', 'executionScope'];
const ABI_KEYS = ['type', 'name', 'stateMutability', 'inputs', 'outputs', 'internalType'];
const ABI_PARAM_KEYS = ['name', 'type', 'components', 'internalType'];
const PROVENANCE_KEYS = ['sourceRef', 'verifiedAt', 'status'];
const POLICY_KEYS = ['ref', 'version'];

export type CatalogCliMode = 'generate' | 'check' | 'diff' | 'assemble' | 'prepare-v5' | 'prepare-v6' | 'prepare-v7';
export type CatalogCliOptions = Readonly<{ mode: CatalogCliMode; inputPath: string }>;
export type SourceCatalogInput = Readonly<{ sourcePath: string; document: unknown }>;

export const SOURCE_CHAIN_IDS = Object.freeze([1, 10, 56, 137, 143, 8453, 42161]);

const SOURCE_ROOT_KEYS = ['schemaVersion', 'families', 'sources', 'unresolved'];
const SOURCE_A_FAMILY_KEYS = ['familyId', 'familyVersion', 'contracts'];
const SOURCE_B_FAMILY_KEYS = ['familyId', 'familyVersion', 'chains'];
const SOURCE_CONTRACT_KEYS = ['chainId', 'address', 'status', 'contractName', 'sourceRefs', 'abiFunctions'];
const SOURCE_RECORD_KEYS = ['sourceId', 'url', 'retrievedAtUtc', 'evidence'];
const SOURCE_B_CHAIN_KEYS = ['chainId', 'status', 'contracts'];
const SOURCE_B_CONTRACT_KEYS = ['address', 'status', 'contractName', 'functions'];
const SOURCE_B_CONTRACT_KEYS_V6 = ['address', 'status', 'contractName', 'sourceRefs', 'functions'];
const SOURCE_UNRESOLVED_KEYS = ['candidateId', 'familyId', 'familyVersion', 'chainId', 'chainIds', 'address', 'targetAddress', 'contractName', 'functionName', 'signature', 'slug', 'name', 'productId', 'sourceRefs', 'reason', 'description', 'evidence', 'status'];
const SOURCE_FUNCTION_KEYS = ['type', 'name', 'stateMutability', 'inputs', 'outputs', 'sourceId', 'sourceRefs', 'status', 'label', 'description', 'warnings', 'operation'];
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const FAMILY_ID_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'uniswap-v3-position-manager': 'v3-npm',
  'balancer-v2-vault': 'v2-vault',
  'aave-v3': 'v3-aave',
  'compound-iii': 'v3-comet',
  'compound-v2': 'v2-compound',
  'morpho-blue': 'v1-callback-free',
  'curve-3pool-stableswap': 'v1-3pool',
  'pancakeswap-v3-position-manager': 'v3-npm-bounded',
  'yearn-tokenized-strategy': 'v3.0.4',
  'quickswap-v2': 'v2', 'camelot-v2': 'v2', 'lfj-liquidity-book': 'v2.2',
  moonwell: 'v2', 'fluid-lending': 'v1', 'fluid-vault-t1': 'v1', 'rocket-pool': 'v1', etherfi: 'v1',
  'beefy-standard': 'v1', kelp: 'v1', 'pendle-v3': 'v3', ambient: 'coldpath-v1', convex: 'v1',
  'maverick-v2': 'v2', stakewise: 'v3-genesis', 'dodo-v2': 'v2', 'dolomite-router': 'v1',
  aura: 'v1', 'euler-vault': 'evk-v1', 'euler-evc': 'evc-v1', renzo: 'v1', 'silo-vault': 'v3-market',
});
const SELECTOR_QUALIFIED_FAMILIES = new Set(['yearn-tokenized-strategy', 'fluid-lending', 'etherfi', 'renzo']);
const FAMILY_CAPABILITY_SUFFIX_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'quickswap-v2': Object.freeze({ swapExactETHForTokens: 'swap-exact-eth-for-tokens', swapETHForExactTokens: 'swap-eth-for-exact-tokens' }),
  'pendle-v3': Object.freeze({ addLiquidityDualSyAndPt: 'add-liquidity-dual-sy-pt', removeLiquidityDualSyAndPt: 'remove-liquidity-dual-sy-pt', deposit: 'deposit-sy', redeem: 'redeem-sy' }),
  'dodo-v2': Object.freeze({ dodoSwapV2TokenToToken: 'dodo-swap-v2-token-to-token', dodoSwapV2ETHToToken: 'dodo-swap-v2-eth-to-token', dodoSwapV2TokenToETH: 'dodo-swap-v2-token-to-eth' }),
});
const V5_FAMILY_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'quickswap-v2': 'v2', 'camelot-v2': 'v2', 'lfj-liquidity-book': 'v2.2', moonwell: 'v2',
  'fluid-lending': 'v1', 'fluid-vault-t1': 'v1', 'rocket-pool': 'v1', etherfi: 'v1',
  'beefy-standard': 'standard-client@97385b9a832316d78a4c595319352726d5a322a7',
  kelp: 'lrt-rseth@3dded885f6f797f5959aff449c3a30c5cbb6ce23',
  'pendle-v3': 'router-sy@87685c89', ambient: 'coldpath-v1', convex: 'platform@4f220383',
  'maverick-v2': 'v2', stakewise: 'v3-genesis', 'dodo-v2': 'v2', 'dolomite-router': 'v1',
  aura: 'phase6@36599d53', 'euler-vault': 'evk-v1', 'euler-evc': 'evc-v1', renzo: 'contracts-public@fc8c8e08', 'silo-vault': 'v3-market@f896c9da',
});
const ALLOWED_SOURCE_PATHS = Object.freeze([
  'data/defi-catalog/v2/sources/dex.json',
  'data/defi-catalog/v2/sources/lending-yield.json',
]);
const V3_SOURCE_PATH = 'data/defi-catalog/v3/sources/workflow-extensions.json';
const V4_SOURCE_PATHS = Object.freeze([
  'data/defi-catalog/v4/sources/ordinary-protocols.json',
  'data/defi-catalog/v4/sources/yearn.json',
]);
export const V5_ASSEMBLY_PLAN_PATH = 'data/defi-catalog/v5/assembly-plan.json';
export const V5_SOURCE_PATHS = Object.freeze([
  'data/defi-catalog/v5/sources/ambient.json', 'data/defi-catalog/v5/sources/aura.json', 'data/defi-catalog/v5/sources/beefy.json',
  'data/defi-catalog/v5/sources/camelot.json', 'data/defi-catalog/v5/sources/convex.json',
  'data/defi-catalog/v5/sources/dodo.json', 'data/defi-catalog/v5/sources/dolomite.json',
  'data/defi-catalog/v5/sources/etherfi.json', 'data/defi-catalog/v5/sources/euler.json', 'data/defi-catalog/v5/sources/fluid.json',
  'data/defi-catalog/v5/sources/kelp.json', 'data/defi-catalog/v5/sources/lfj.json',
  'data/defi-catalog/v5/sources/maverick.json', 'data/defi-catalog/v5/sources/moonwell.json',
  'data/defi-catalog/v5/sources/pendle.json', 'data/defi-catalog/v5/sources/quickswap.json',
  'data/defi-catalog/v5/sources/renzo.json', 'data/defi-catalog/v5/sources/rocket-pool.json',
  'data/defi-catalog/v5/sources/silo.json', 'data/defi-catalog/v5/sources/stakewise.json',
]);
/** Explicit candidate inventory only; never globbed or implicitly admitted. */
export const V6_SOURCE_PATHS = Object.freeze([
  'data/defi-catalog/v6/sources/ajna.json', 'data/defi-catalog/v6/sources/angle.json',
  'data/defi-catalog/v6/sources/bancor.json', 'data/defi-catalog/v6/sources/eigenlayer.json',
  'data/defi-catalog/v6/sources/ekubo.json', 'data/defi-catalog/v6/sources/enzyme.json',
  'data/defi-catalog/v6/sources/ethena.json', 'data/defi-catalog/v6/sources/exactly.json',
  'data/defi-catalog/v6/sources/frax.json', 'data/defi-catalog/v6/sources/gearbox.json',
  'data/defi-catalog/v6/sources/harvest.json', 'data/defi-catalog/v6/sources/hashflow.json',
  'data/defi-catalog/v6/sources/idle.json', 'data/defi-catalog/v6/sources/integral.json',
  'data/defi-catalog/v6/sources/izumi.json', 'data/defi-catalog/v6/sources/liquity.json',
  'data/defi-catalog/v6/sources/lista.json', 'data/defi-catalog/v6/sources/lombard.json',
  'data/defi-catalog/v6/sources/origin.json', 'data/defi-catalog/v6/sources/puffer.json',
  'data/defi-catalog/v6/sources/sky.json', 'data/defi-catalog/v6/sources/solv.json',
  'data/defi-catalog/v6/sources/stakedao.json', 'data/defi-catalog/v6/sources/stakestone.json',
  'data/defi-catalog/v6/sources/swell.json', 'data/defi-catalog/v6/sources/symbiotic.json',
  'data/defi-catalog/v6/sources/usual.json',
]);
export const V6_ASSEMBLY_PLAN_PATH = 'data/defi-catalog/v6/assembly-plan.json';
export const V7_ASSEMBLY_PLAN_PATH = 'data/defi-catalog/v7/assembly-plan.json';
/** Fixed candidate paths, sorted and explicit; no directory discovery is used. */
export const V7_SOURCE_PATHS = Object.freeze([
  'data/defi-catalog/v7/sources/bebop.json',
  'data/defi-catalog/v7/sources/one-inch.json',
  'data/defi-catalog/v7/sources/open-ocean.json',
  'data/defi-catalog/v7/sources/velora.json',
  'data/defi-catalog/v7/sources/zero-x.json',
]);
export type V6AssemblyPlan = Readonly<{ schemaVersion: 1; baselinePath: 'data/defi-catalog/v5/catalog.json'; sourcePaths: readonly string[] }>;
export type V6CompiledBinding = Readonly<{ sourcePath: string; familyId: string; familyVersion: string; chainId: number; contract: string; functionName: string; signature: string; selector: string; capabilityId: string; abiHash: string; executionScope: DefiExecutionScope | null; executionScopeHash: string | null }>;
export type V6PreparationReport = Readonly<{ sourceCount: number; familyCount: number; targetCount: number; bindingCount: number; sourceDigests: readonly Readonly<{ sourcePath: string; canonicalSha256: string }>[]; bindings: readonly V6CompiledBinding[] }>;
export type V5AssemblyPlan = Readonly<{ schemaVersion: 1; baselinePath: 'data/defi-catalog/v4/catalog.json'; sourcePaths: readonly string[] }>;
export type V7AssemblyPlan = Readonly<{ schemaVersion: 1; baselinePath: 'data/defi-catalog/v6/catalog.json'; sourcePaths: readonly string[] }>;
export type V7CompiledBinding = Readonly<{ sourcePath: string; familyId: string; familyVersion: string; chainId: number; contract: string; functionName: string; signature: string; selector: string; capabilityId: string; abiHash: string; executionScope: DefiExecutionScope | null; executionScopeHash: string | null }>;
export type V7PreparationReport = Readonly<{ sourceCount: number; familyCount: number; targetCount: number; bindingCount: number; sourceDigests: readonly Readonly<{ sourcePath: string; canonicalSha256: string }>[]; bindings: readonly V7CompiledBinding[] }>;

export type SourceAdmissionBinding = Readonly<{ familyId: string; chainId: number; contract: string; signature: string; selector?: string; abiHash: string; capabilityId: string; executionScope?: DefiExecutionScope; executionScopeHash?: string }>;
export type SourceAdmissionSnapshot = Readonly<{ sourcePath: string; canonicalSha256: string; bindings: readonly SourceAdmissionBinding[] }>;
export type SourceAdmissionDocument = Readonly<{ schemaVersion: 1; snapshots: readonly SourceAdmissionSnapshot[] }>;

function assertJsonData(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${label} contains unsupported JSON data`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonData(item, `${label}[${index}]`, seen));
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain plain JSON objects`);
    for (const [key, child] of Object.entries(value)) assertJsonData(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

export function parseCatalogCliArgs(args: readonly string[]): CatalogCliOptions {
  const mode = args[0];
  if (mode !== 'generate' && mode !== 'check' && mode !== 'diff' && mode !== 'assemble' && mode !== 'prepare-v5' && mode !== 'prepare-v6' && mode !== 'prepare-v7') throw new Error('Usage: cli.ts <generate|check|diff|assemble|prepare-v5|prepare-v6|prepare-v7> [--input fixed repository file]');
  if ((mode === 'assemble' || mode === 'prepare-v5' || mode === 'prepare-v6' || mode === 'prepare-v7') && args.length > 3) throw new Error(`${mode} accepts at most one fixed input selector`);
  let inputPath = 'data/defi-catalog/v7/catalog.json';
  let inputSeen = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--input' || inputSeen || !args[index + 1]) throw new Error('Usage: cli.ts <generate|check|diff> [--input data/defi-catalog/vN/catalog.json]');
    inputSeen = true;
    inputPath = args[++index];
  }
  if (mode === 'assemble') {
    if (inputSeen && !['data/defi-catalog/v3/catalog.json', 'data/defi-catalog/v4/catalog.json', 'data/defi-catalog/v5/catalog.json', 'data/defi-catalog/v6/catalog.json', 'data/defi-catalog/v7/catalog.json'].includes(inputPath)) throw new Error('assemble only accepts a fixed v3, v4, v5, v6, or v7 source assembly selector');
    return { mode, inputPath: inputSeen ? inputPath : 'data/defi-catalog/v7/catalog.json' };
  }
  if (mode === 'prepare-v5') {
    if (inputSeen && inputPath !== V5_ASSEMBLY_PLAN_PATH) throw new Error(`prepare-v5 only accepts ${V5_ASSEMBLY_PLAN_PATH}`);
    return { mode, inputPath: V5_ASSEMBLY_PLAN_PATH };
  }
  if (mode === 'prepare-v6') {
    if (inputSeen && inputPath !== 'data/defi-catalog/v6/sources') throw new Error('prepare-v6 does not accept source selectors');
    return { mode, inputPath: 'data/defi-catalog/v6/sources' };
  }
  if (mode === 'prepare-v7') {
    if (inputSeen && inputPath !== V7_ASSEMBLY_PLAN_PATH) throw new Error(`prepare-v7 only accepts ${V7_ASSEMBLY_PLAN_PATH}`);
    return { mode, inputPath: V7_ASSEMBLY_PLAN_PATH };
  }
  if (!/^data\/defi-catalog\/v[1-9][0-9]*\/catalog\.json$/.test(inputPath)) throw new Error('Catalog input must be a repository source file at data/defi-catalog/vN/catalog.json');
  return { mode, inputPath };
}

export function validateV6AssemblyPlan(value: unknown): V6AssemblyPlan {
  const plan = record(value, 'V6 assembly plan');
  onlyKeys(plan, ['schemaVersion', 'baselinePath', 'sourcePaths'], 'V6 assembly plan');
  requireKeys(plan, ['schemaVersion', 'baselinePath', 'sourcePaths'], 'V6 assembly plan');
  if (plan.schemaVersion !== 1 || plan.baselinePath !== 'data/defi-catalog/v5/catalog.json' || !Array.isArray(plan.sourcePaths)) throw new Error('V6 assembly plan has unsupported schema or baseline');
  if (plan.sourcePaths.length !== V6_SOURCE_PATHS.length || plan.sourcePaths.some((path, index) => path !== V6_SOURCE_PATHS[index])) throw new Error('V6 assembly plan must select every fixed v6 source exactly once in canonical order');
  return { schemaVersion: 1, baselinePath: plan.baselinePath, sourcePaths: [...V6_SOURCE_PATHS] };
}

export function validateV7AssemblyPlan(value: unknown): V7AssemblyPlan {
  const plan = record(value, 'V7 assembly plan');
  onlyKeys(plan, ['schemaVersion', 'baselinePath', 'sourcePaths'], 'V7 assembly plan');
  requireKeys(plan, ['schemaVersion', 'baselinePath', 'sourcePaths'], 'V7 assembly plan');
  if (plan.schemaVersion !== 1 || plan.baselinePath !== 'data/defi-catalog/v6/catalog.json' || !Array.isArray(plan.sourcePaths)) throw new Error('V7 assembly plan has unsupported schema or baseline');
  if (plan.sourcePaths.length !== V7_SOURCE_PATHS.length || plan.sourcePaths.some((path, index) => path !== V7_SOURCE_PATHS[index])) throw new Error('V7 assembly plan must select every fixed v7 source exactly once in canonical order');
  return { schemaVersion: 1, baselinePath: plan.baselinePath, sourcePaths: [...V7_SOURCE_PATHS] };
}

export function validateV5AssemblyPlan(value: unknown): V5AssemblyPlan {
  const plan = record(value, 'V5 assembly plan');
  onlyKeys(plan, ['schemaVersion', 'baselinePath', 'sourcePaths'], 'V5 assembly plan');
  requireKeys(plan, ['schemaVersion', 'baselinePath', 'sourcePaths'], 'V5 assembly plan');
  if (plan.schemaVersion !== 1 || plan.baselinePath !== 'data/defi-catalog/v4/catalog.json' || !Array.isArray(plan.sourcePaths) || plan.sourcePaths.length === 0) throw new Error('V5 assembly plan has an unsupported schema or baseline');
  const paths = plan.sourcePaths;
  if (paths.some((path) => typeof path !== 'string' || !V5_SOURCE_PATHS.includes(path)) || new Set(paths).size !== paths.length) throw new Error('V5 assembly plan contains an unknown or duplicate source path');
  const sorted = [...paths].sort(cmp);
  if (paths.some((path, index) => path !== sorted[index])) throw new Error('V5 assembly plan source paths must be sorted');
  if (paths.length !== V5_SOURCE_PATHS.length || paths.some((path, index) => path !== V5_SOURCE_PATHS[index])) throw new Error('V5 assembly plan must select every explicitly qualified source snapshot exactly once');
  return { schemaVersion: 1, baselinePath: plan.baselinePath, sourcePaths: [...paths] as string[] };
}

export function assembleV5SourceCandidates(baseline: DefiRegistryFragment, planValue: unknown, inputs: readonly SourceCatalogInput[]): DefiRegistryFragment {
  const plan = validateV5AssemblyPlan(planValue);
  if (inputs.length !== plan.sourcePaths.length || inputs.some((input, index) => input.sourcePath !== plan.sourcePaths[index])) throw new Error('V5 source inputs must exactly match the selected assembly-plan source paths');
  for (const input of inputs) {
    const root = record(input.document, input.sourcePath);
    if (!Array.isArray(root.families)) throw new Error(`${input.sourcePath} has no source families`);
    for (const familyValue of root.families) {
      const family = record(familyValue, `${input.sourcePath} family`);
      const id = requireString(family.familyId, 'V5 source familyId');
      const expectedVersion = V5_FAMILY_VERSIONS[id];
      if (!expectedVersion || family.familyVersion !== expectedVersion) throw new Error(`${input.sourcePath} has an unknown family or unapproved familyVersion: ${id}`);
    }
  }
  const candidate = assembleCatalogFromSources(baseline, inputs);
  const added = catalogDiff(baseline, candidate).added;
  const candidateIds = new Set(added);
  for (const fn of candidate.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((item) => candidateIds.has(item.capabilityId))) {
    if (fn.status !== 'inactive' || fn.provenance.status !== 'candidate') throw new Error(`V5 source candidate was unexpectedly activated: ${fn.capabilityId}`);
  }
  return candidate;
}

type SourceRecord = { sourceId: string; url: string; retrievedAtUtc: string; evidence: string };
type SourceFunction = Record<string, unknown>;

function sourceCanonicalType(param: { type: string; components?: readonly { type: string; components?: readonly unknown[] }[] }): string {
  if (!param.type.startsWith('tuple')) return param.type;
  return `(${(param.components ?? []).map((part) => sourceCanonicalType(part as never)).join(',')})${param.type.slice(5)}`;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function sourceList(value: unknown, label: string): SourceRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = new Set<string>();
  return value.map((item, index) => {
    const row = record(item, `${label}[${index}]`);
    onlyKeys(row, SOURCE_RECORD_KEYS, `${label}[${index}]`);
    requireKeys(row, SOURCE_RECORD_KEYS, `${label}[${index}]`);
    const sourceId = requireString(row.sourceId, `${label}[${index}].sourceId`);
    const url = requireString(row.url, `${label}[${index}].url`);
    const retrievedAtUtc = requireString(row.retrievedAtUtc, `${label}[${index}].retrievedAtUtc`);
    const evidence = requireString(row.evidence, `${label}[${index}].evidence`);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sourceId)) throw new Error(`${label}[${index}].sourceId has invalid syntax`);
    if (ids.has(sourceId)) throw new Error(`${label} contains duplicate sourceId ${sourceId}`);
    if (!/^https:\/\//i.test(url) || !/^\d{4}-\d{2}-\d{2}$/.test(retrievedAtUtc) || Number.isNaN(Date.parse(`${retrievedAtUtc}T00:00:00Z`)) || new Date(`${retrievedAtUtc}T00:00:00Z`).toISOString().slice(0, 10) !== retrievedAtUtc) throw new Error(`${label}[${index}] has invalid source URL or snapshot date`);
    ids.add(sourceId);
    return { sourceId, url, retrievedAtUtc, evidence };
  });
}

/** Normalize only the two recorded v7 source-record formats into the strict compiler shape. */
function normalizeV7SourceDocument(document: unknown, sourcePath: string): unknown {
  if (!V7_SOURCE_PATHS.includes(sourcePath)) return document;
  const root = record(document, sourcePath);
  const sources = root.sources;
  if (!Array.isArray(sources)) throw new Error(`${sourcePath}.sources must be an array`);
  const normalizedSources = sources.map((value, index) => {
    const source = record(value, `${sourcePath}.sources[${index}]`);
    if ('retrievedAtUtc' in source || 'evidence' in source) return source;
    onlyKeys(source, ['sourceId', 'url', 'retrievedAt', 'sha256', 'notes'], `${sourcePath}.sources[${index}]`);
    requireKeys(source, ['sourceId', 'url', 'retrievedAt', 'sha256', 'notes'], `${sourcePath}.sources[${index}]`);
    if (typeof source.retrievedAt !== 'string' || typeof source.notes !== 'string' || (source.sha256 !== null && (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)))) throw new Error(`${sourcePath}.sources[${index}] has invalid dated evidence fields`);
    const retrievedAtUtc = source.retrievedAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(retrievedAtUtc) || Number.isNaN(Date.parse(`${retrievedAtUtc}T00:00:00Z`))) throw new Error(`${sourcePath}.sources[${index}] has invalid retrieval date`);
    return {
      sourceId: source.sourceId,
      url: source.url,
      retrievedAtUtc,
      evidence: `${source.notes}${source.sha256 ? ` SHA-256 ${source.sha256}.` : ''}`,
    };
  });
  return { ...root, ...(Object.hasOwn(root, 'unresolved') ? {} : { unresolved: [] }), sources: normalizedSources };
}

function normalizeSourceAddress(value: unknown, label: string): string {
  const address = requireString(value, label);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${label} must be an EVM address`);
  return address.toLowerCase();
}

function makeSourceFunction(input: SourceFunction, context: { familyId: string; familyVersion: string; chainId: number; address: string; contractName: string; familySources: readonly string[]; records: ReadonlyMap<string, SourceRecord> }): DefiFunctionPolicy {
  let raw = input;
  let expectedSignature: string | undefined;
  let policyAbi: Record<string, unknown> | undefined;
  if ('abi' in input || 'capabilityId' in input) {
    onlyKeys(input, FUNCTION_KEYS, 'Source policy function');
    requireKeys(input, ['capabilityId', 'type', 'chainId', 'contract', 'functionName', 'signature', 'abi', 'status', 'provenance'], 'Source policy function');
    if (input.type !== 'contract_call' || input.status !== 'inactive' || input.chainId !== context.chainId || typeof input.contract !== 'string' || input.contract.toLowerCase() !== context.address) throw new Error('Source policy function identity/status does not match its inactive source contract');
    const provenance = record(input.provenance, 'Source policy function provenance');
    onlyKeys(provenance, PROVENANCE_KEYS, 'Source policy function provenance');
    requireKeys(provenance, PROVENANCE_KEYS, 'Source policy function provenance');
    const ref = requireString(provenance.sourceRef, 'Source policy function provenance.sourceRef');
    const referenced = context.records.has(ref) ? ref : [...context.records.entries()].find(([, value]) => value.url === ref)?.[0];
    if (!referenced) throw new Error('Source policy function has undeclared source provenance');
    const sourceId = requireString(input.capabilityId, 'Source policy function capabilityId');
    if (!/^[A-Za-z0-9:._-]{1,160}$/.test(sourceId)) throw new Error('Source policy function has invalid capability ID');
    const abiInput = record(input.abi, 'Source policy function ABI');
    onlyKeys(abiInput, ABI_KEYS, 'Source policy function ABI');
    requireKeys(abiInput, ['type', 'name', 'stateMutability', 'inputs', 'outputs'], 'Source policy function ABI');
    policyAbi = abiInput;
    expectedSignature = requireString(input.signature, 'Source policy function signature');
    raw = { name: input.functionName, type: abiInput.type, stateMutability: abiInput.stateMutability, inputs: abiInput.inputs, outputs: abiInput.outputs, sourceRefs: [referenced], label: input.label, description: input.description, warnings: input.warnings, operation: input.operation };
  }
  onlyKeys(raw, SOURCE_FUNCTION_KEYS, 'Source ABI function');
  const name = requireString(raw.name, 'Source ABI function.name');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error('Source ABI function has invalid name');
  if (raw.type !== undefined && raw.type !== 'function') throw new Error('Only function ABI entries are supported');
  const mutability = raw.stateMutability;
  if (!['pure', 'view', 'nonpayable', 'payable'].includes(String(mutability))) throw new Error(`Unsupported ABI mutability for ${name}`);
  if (!Array.isArray(raw.inputs) || !Array.isArray(raw.outputs)) throw new Error(`Source ABI ${name} requires inputs and outputs`);
  const refs = raw.sourceRefs ?? (raw.sourceId === undefined ? context.familySources : [raw.sourceId]);
  if (raw.sourceRefs !== undefined && raw.sourceId !== undefined) throw new Error(`Source ABI ${name} has ambiguous source references`);
  if (!Array.isArray(refs) || refs.length === 0 || new Set(refs).size !== refs.length || refs.some((ref) => typeof ref !== 'string' || !context.records.has(ref))) throw new Error(`Source ABI ${name} has missing, duplicate, or undeclared source references`);
  const sourceIds = [...new Set(refs as string[])].sort(cmp);
  const source = sourceIds.map((id) => context.records.get(id)!)[0];
  const abi = policyAbi ? policyAbi as unknown as DefiFunctionPolicy['abi'] : { type: 'function' as const, name, stateMutability: mutability as 'pure' | 'view' | 'nonpayable' | 'payable', inputs: raw.inputs as never[], outputs: raw.outputs as never[] };
  const signature = `${name}(${abi.inputs.map((part) => sourceCanonicalType(part as never)).join(',')})`;
  if (expectedSignature !== undefined && expectedSignature !== signature) throw new Error(`Source policy function signature disagrees with ABI for ${name}`);
  const selector = toFunctionSelector(signature).toLowerCase();
  const slug = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stableFamilyVersion = FAMILY_ID_VERSIONS[context.familyId];
  const capabilitySuffix = FAMILY_CAPABILITY_SUFFIX_OVERRIDES[context.familyId]?.[name] ?? slug;
  const capabilityId = stableFamilyVersion
    ? `${context.familyId}:${stableFamilyVersion}:${context.chainId}:${context.address}:${SELECTOR_QUALIFIED_FAMILIES.has(context.familyId) ? selector.slice(2) : capabilitySuffix}`
    : `candidate:${context.familyId}:${context.familyVersion.replace(/[^A-Za-z0-9_-]/g, '-')}:${context.chainId}:${context.address}:${slug}`;
  const candidateStatus = raw.status === undefined || raw.status === 'candidate' || raw.status === 'inactive';
  if (!candidateStatus) throw new Error(`Source ABI ${name} cannot be activated by source assembly`);
  const sourceRef = sourceIds.map((id) => context.records.get(id)!.url).join(' | ');
  const warnings: string[] = Array.isArray(raw.warnings) ? raw.warnings.map((item) => requireString(item, `Source ABI ${name}.warnings`)) : [];
  for (const key of ['label', 'description', 'operation']) if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`Source ABI ${name}.${key} must be a string`);
  if (raw.warnings !== undefined && !Array.isArray(raw.warnings)) throw new Error(`Source ABI ${name}.warnings must be an array`);
  if (mutability === 'payable') warnings.push('Payable ABI: caller-supplied value is not bounded by this catalog entry.');
  if (context.familyId === 'uniswap-v3-position-manager') warnings.push('Only the fixed position lifecycle functions and reviewed helper subset are included; NFT permits, approval/operator, transfer, and unreviewed selectors are excluded. Multicall has a separate exact-child execution scope.');
  if (context.familyId === 'morpho-blue' && ['supply', 'repay', 'supplyCollateral'].includes(name)) warnings.push('This candidate scope permits only empty callback data; it is not a wallet callback handler. Other ABI arguments remain caller controlled.');
  if (/^safeTransferFrom$/.test(name)) warnings.push('ERC-721/ERC-1155 overload and operator semantics require review; this entry does not establish token-standard semantics.');
  if (/^(?:swap|batchSwap|joinPool|exitPool)$/.test(name) && /balancer/i.test(context.familyId)) warnings.push('Balancer Vault calls accept caller-selected pool IDs and userData/callback parameters; the fixed ABI is not a generic wallet-execute call or a validation of those values.');
  if (context.familyId === 'compound-v2') warnings.push('EVM transaction success does not establish the Compound V2 uint error-code return outcome; no return-code interpretation or automatic approval pairing is provided.');
  if (context.familyId === 'compound-v2' && mutability === 'payable' && abi.inputs.length === 0) warnings.push('Native CEther payable lifecycle call; supplied value is not bounded and ABI has no return data.');
  let executionScope: DefiExecutionScope | undefined;
  if (input.executionScope !== undefined) {
    const scope = record(input.executionScope, `Source policy function ${name}.executionScope`);
    executionScope = scope as unknown as DefiExecutionScope;
    executionScopeHash(executionScope);
  }
  const ambientTarget = '0xaaaaaaaaa24eeeb8d57d431224f73832bc34f688';
  const isAmbientRoot = context.familyId === 'ambient' && context.chainId === 1 && context.address === ambientTarget && name === 'userCmd' && signature === 'userCmd(uint16,bytes)';
  if (context.familyId === 'ambient') {
    const expectedAbi = {
      type: 'function', name: 'userCmd', stateMutability: 'payable',
       inputs: [{ name: 'callpath', type: 'uint16', internalType: 'uint16' }, { name: 'cmd', type: 'bytes', internalType: 'bytes' }],
       outputs: [{ name: '', type: 'bytes', internalType: 'bytes' }],
    };
    const expectedScope: DefiExecutionScope = { kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 1 };
    if (!isAmbientRoot || context.familyVersion !== 'coldpath-v1' || !equal(abi, expectedAbi) || !executionScope || !equal(executionScope, expectedScope)) {
      throw new Error('Ambient source requires its exact Ethereum userCmd ABI, target, and mandatory cold-path scope');
    }
  } else if (executionScope !== undefined) {
    throw new Error(`V5 source scope is not defined for this function identity: ${context.familyId}:${signature}`);
  }
  if (input.capabilityId !== undefined && stableFamilyVersion && input.capabilityId !== capabilityId) throw new Error(`Source policy capability ID does not match stable family identity: ${input.capabilityId}`);
  return {
    capabilityId, type: 'contract_call', chainId: context.chainId, contract: context.address,
    functionName: name, signature, abi, abiHash: functionAbiHash({ abi }), status: 'inactive',
    provenance: { sourceRef, verifiedAt: source.retrievedAtUtc, status: 'candidate' },
    label: typeof raw.label === 'string' ? raw.label : name,
    description: typeof raw.description === 'string' ? raw.description : `${context.contractName} ${name} source-qualified fixed ABI.`,
    protocol: context.familyId, operation: typeof raw.operation === 'string' ? raw.operation : capabilitySuffix,
    warnings: [...new Set(warnings)].sort(cmp), inactiveReason: 'Source-qualified candidate; not admitted as active authority.',
    ...(executionScope ? { executionScope } : {}),
  };
}

function sourceFamilies(document: unknown, sourcePath: string): DefiChainPolicy[] {
  assertJsonData(document, sourcePath);
  const root = record(document, sourcePath);
  onlyKeys(root, SOURCE_ROOT_KEYS, sourcePath);
  requireKeys(root, SOURCE_ROOT_KEYS, sourcePath);
  if (root.schemaVersion !== 1 || !Array.isArray(root.families) || !Array.isArray(root.unresolved)) throw new Error(`${sourcePath} has unsupported source schema`);
  const records = sourceList(root.sources, `${sourcePath}.sources`);
  const recordMap = new Map(records.map((item) => [item.sourceId, item]));
  for (const [index, value] of root.unresolved.entries()) {
    const row = record(value, `${sourcePath}.unresolved[${index}]`);
    onlyKeys(row, SOURCE_UNRESOLVED_KEYS, `${sourcePath}.unresolved[${index}]`);
    for (const key of ['candidateId', 'familyId', 'familyVersion', 'address', 'targetAddress', 'contractName', 'functionName', 'signature', 'slug', 'name', 'productId', 'reason', 'description', 'evidence']) {
      if (row[key] !== undefined && typeof row[key] !== 'string') throw new Error(`${sourcePath}.unresolved[${index}].${key} must be a string`);
    }
    if (row.familyId !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(row.familyId as string)) throw new Error(`${sourcePath}.unresolved[${index}] has invalid familyId`);
    if (row.chainId !== undefined && (typeof row.chainId !== 'number' || !SOURCE_CHAIN_IDS.includes(row.chainId))) throw new Error(`${sourcePath}.unresolved[${index}] has unsupported chainId`);
    if (row.chainIds !== undefined && (!Array.isArray(row.chainIds) || row.chainIds.length === 0 || new Set(row.chainIds).size !== row.chainIds.length || row.chainIds.some((id) => typeof id !== 'number' || !SOURCE_CHAIN_IDS.includes(id)))) throw new Error(`${sourcePath}.unresolved[${index}] has unsupported chainIds`);
    if (row.status !== undefined && row.status !== 'candidate' && row.status !== 'inactive') throw new Error(`${sourcePath}.unresolved[${index}] cannot be active`);
    for (const key of ['sourceRefs']) if (row[key] !== undefined && (!Array.isArray(row[key]) || (row[key] as unknown[]).some((id) => typeof id !== 'string' || !recordMap.has(id)))) throw new Error(`${sourcePath}.unresolved[${index}] has undeclared source references`);
  }
  const chains = new Map<number, Map<string, DefiFunctionPolicy[]>>();
  const isV6Source = sourcePath.startsWith('data/defi-catalog/v6/');
  const isV7Source = V7_SOURCE_PATHS.includes(sourcePath);
  const matchedV6Identities = new Set<string>();
  const matchedV7Identities = new Set<string>();
  const add = (familyId: string, familyVersion: string, familySources: readonly string[], chainValue: unknown, addressValue: unknown, nameValue: unknown, refsValue: unknown, functionsValue: unknown, label: string, contractStatus?: unknown) => {
    const chainId = chainValue;
    if (typeof chainId !== 'number' || !SOURCE_CHAIN_IDS.includes(chainId)) throw new Error(`${label} has unsupported chain`);
    const address = normalizeSourceAddress(addressValue, `${label}.address`);
    const contractName = requireString(nameValue, `${label}.contractName`);
    if (contractStatus !== undefined && contractStatus !== 'inactive' && contractStatus !== 'candidate') throw new Error(`${label} cannot promote source contract status`);
    if (!Array.isArray(refsValue) || refsValue.length === 0 || new Set(refsValue).size !== refsValue.length || refsValue.some((ref) => typeof ref !== 'string' || !recordMap.has(ref))) throw new Error(`${label} has missing, duplicate, or undeclared source references`);
    if (!Array.isArray(functionsValue)) throw new Error(`${label} functions must be an array`);
    const entries = functionsValue.map((item, i) => {
      const candidate = makeSourceFunction(record(item, `${label}.functions[${i}]`), { familyId, familyVersion, chainId, address, contractName, familySources, records: recordMap });
      if (isV7Source) {
        const identity = V7_SOURCE_IDENTITIES.find((row) => row.sourcePath === sourcePath && row.familyId === familyId && row.familyVersion === familyVersion && row.chainId === chainId && row.address === address && row.signature === candidate.signature);
        if (!identity || matchedV7Identities.has(identity.capabilityId)) throw new Error(`${sourcePath} has a missing, ambiguous, or duplicate reviewed v7 identity for ${familyId}:${chainId}:${address}:${candidate.signature}`);
        if (identity.abiHash !== functionAbiHash(candidate)) throw new Error(`${sourcePath} ABI does not match reviewed v7 identity ${identity.capabilityId}`);
        const scopeHash = candidate.executionScope ? executionScopeHash(candidate.executionScope) : null;
        if (identity.executionScopeHash !== scopeHash || (identity.executionScope === null) !== (candidate.executionScope === undefined) || identity.executionScope && !equal(identity.executionScope, candidate.executionScope)) throw new Error(`${sourcePath} execution scope does not match reviewed v7 identity ${identity.capabilityId}`);
        matchedV7Identities.add(identity.capabilityId);
        return { ...candidate, capabilityId: identity.capabilityId };
      }
      if (!isV6Source) return candidate;
      const identity = V6_SOURCE_IDENTITIES.find((row) => row.sourcePath === sourcePath && row.familyId === familyId && row.familyVersion === familyVersion && row.chainId === chainId && row.address === address && row.signature === candidate.signature) as { sourcePath: string; familyId: string; familyVersion: string; chainId: number; address: string; signature: string; capabilityId: string; abiHash: string; executionScope?: DefiExecutionScope | null } | undefined;
      if (!identity || matchedV6Identities.has(identity.capabilityId)) throw new Error(`${sourcePath} has a missing, ambiguous, or duplicate reviewed v6 identity for ${familyId}:${chainId}:${address}:${candidate.signature}`);
      if (identity.abiHash !== functionAbiHash(candidate)) throw new Error(`${sourcePath} ABI does not match reviewed v6 identity ${identity.capabilityId}`);
      if (Boolean(identity.executionScope) !== Boolean(candidate.executionScope) || identity.executionScope && !equal(identity.executionScope, candidate.executionScope)) throw new Error(`${sourcePath} execution scope does not match reviewed v6 identity ${identity.capabilityId}`);
      matchedV6Identities.add(identity.capabilityId);
      return { ...candidate, capabilityId: identity.capabilityId };
    });
    const chain = chains.get(chainId) ?? new Map<string, DefiFunctionPolicy[]>();
    const existing = chain.get(address) ?? [];
    for (const entry of entries) {
      const selector = toFunctionSelector(entry.signature).toLowerCase();
      const collision = [...existing, ...entries.filter((item) => item !== entry)].find((item) => toFunctionSelector(item.signature).toLowerCase() === selector);
      if (collision && collision.signature !== entry.signature) throw new Error(`${label} contains a contract selector collision`);
      if ([...existing, ...entries.filter((item) => item !== entry)].some((item) => item.signature === entry.signature)) throw new Error(`${label} contains duplicate function signature ${entry.signature}`);
    }
    chain.set(address, [...existing, ...entries]); chains.set(chainId, chain);
  };
  for (const [familyIndex, familyValue] of root.families.entries()) {
    const family = record(familyValue, `${sourcePath}.families[${familyIndex}]`);
    const familyFormat = Array.isArray(family.contracts) ? 'A' : Array.isArray(family.chains) ? 'B' : 'invalid';
    onlyKeys(family, familyFormat === 'A' ? SOURCE_A_FAMILY_KEYS : SOURCE_B_FAMILY_KEYS, `${sourcePath}.families[${familyIndex}]`);
    requireKeys(family, ['familyId', 'familyVersion', familyFormat === 'A' ? 'contracts' : 'chains'], `${sourcePath}.families[${familyIndex}]`);
    const familyId = requireString(family.familyId, 'familyId');
    const familyVersion = requireString(family.familyVersion, 'familyVersion');
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(familyId) || !/^[A-Za-z0-9._@-]{1,80}$/.test(familyVersion)) throw new Error('Invalid source family identity/version');
    if (sourcePath.startsWith('data/defi-catalog/v5/')) {
      if (V5_FAMILY_VERSIONS[familyId] !== familyVersion) throw new Error(`V5 source family ${familyId} has an unknown or unapproved familyVersion`);
    }
    if (familyFormat === 'A') {
      for (const [index, item] of (family.contracts as unknown[]).entries()) {
        const contract = record(item, `${sourcePath}.families[${familyIndex}].contracts[${index}]`);
        onlyKeys(contract, SOURCE_CONTRACT_KEYS, 'Source contract'); requireKeys(contract, ['chainId', 'address', 'contractName', 'sourceRefs', 'abiFunctions'], 'Source contract');
        add(familyId, familyVersion, contract.sourceRefs as string[], contract.chainId, contract.address, contract.contractName, contract.sourceRefs, contract.abiFunctions, 'Source contract', contract.status);
      }
    } else if (familyFormat === 'B') {
      for (const [ci, chainValue] of (family.chains as unknown[]).entries()) {
        const chain = record(chainValue, `Source family chain[${ci}]`); onlyKeys(chain, SOURCE_B_CHAIN_KEYS, 'Source family chain'); requireKeys(chain, SOURCE_B_CHAIN_KEYS, 'Source family chain');
        if (chain.status !== 'inactive' && chain.status !== 'candidate') throw new Error('Source chain cannot be active');
        if (!Array.isArray(chain.contracts)) throw new Error('Source family chain contracts must be an array');
        for (const [index, contractValue] of chain.contracts.entries()) {
          const contract = record(contractValue, `Source family contract[${index}]`); onlyKeys(contract, isV6Source ? SOURCE_B_CONTRACT_KEYS_V6 : SOURCE_B_CONTRACT_KEYS, 'Source family contract'); requireKeys(contract, ['address', 'status', 'functions'], 'Source family contract');
          if (contract.contractName !== undefined && typeof contract.contractName !== 'string') throw new Error('Source family contract contractName must be a string');
          const refs = isV6Source && contract.sourceRefs !== undefined ? contract.sourceRefs : records.map((item) => item.sourceId);
          add(familyId, familyVersion, refs as string[], chain.chainId, contract.address, contract.contractName ?? familyId, refs, contract.functions, 'Source family contract', contract.status);
        }
      }
    } else throw new Error('Source family must use a supported contracts or chains format');
  }
  if (isV6Source && matchedV6Identities.size !== V6_SOURCE_IDENTITIES.filter((row) => row.sourcePath === sourcePath).length) throw new Error(`${sourcePath} did not consume every reviewed v6 identity binding exactly once`);
  if (isV7Source && matchedV7Identities.size !== V7_SOURCE_IDENTITIES.filter((row) => row.sourcePath === sourcePath).length) throw new Error(`${sourcePath} did not consume every reviewed v7 identity binding exactly once`);
  return [...chains.entries()].sort(([a], [b]) => a - b).map(([chainId, contracts]) => ({ chainId, status: 'inactive' as const, contracts: [...contracts.entries()].sort(([a], [b]) => cmp(a, b)).map(([address, functions]) => ({ address, status: 'inactive' as const, functions: functions.sort((a, b) => cmp(a.capabilityId, b.capabilityId)) })) }));
}

/** Compile the fixed v6 inventory for review only. No source status is promoted and nothing is written. */
export function prepareV6Sources(inputs: readonly SourceCatalogInput[]): V6PreparationReport {
  if (inputs.length !== V6_SOURCE_PATHS.length || inputs.some((input, index) => input.sourcePath !== V6_SOURCE_PATHS[index])) {
    throw new Error('V6 preparation requires every fixed source path exactly once, in canonical order');
  }
  let familyCount = 0; let targetCount = 0; let bindingCount = 0;
  const bindings: V6CompiledBinding[] = [];
  const sourceDigests = inputs.map(({ sourcePath, document }) => {
    const root = record(document, sourcePath);
    // Most v6 candidate snapshots omit the optional unresolved-candidate ledger; normalize only
    // that absent optional field for the existing strict family/ABI compiler.
    const normalized = Object.hasOwn(root, 'unresolved') ? root : { ...root, unresolved: [] };
    const families = sourceFamilies(normalized, sourcePath);
    familyCount += (root.families as unknown[]).length;
    targetCount += families.reduce((n, chain) => n + chain.contracts.length, 0);
    bindingCount += families.reduce((n, chain) => n + chain.contracts.reduce((m, contract) => m + contract.functions.length, 0), 0);
    for (const chain of families) for (const contract of chain.contracts) for (const fn of contract.functions) bindings.push({ sourcePath, familyId: fn.protocol!, familyVersion: (root.families as Array<Record<string, unknown>>).find((family) => family.familyId === fn.protocol)?.familyVersion as string, chainId: chain.chainId, contract: fn.contract, functionName: fn.functionName, signature: fn.signature, selector: toFunctionSelector(fn.signature).toLowerCase(), capabilityId: fn.capabilityId, abiHash: functionAbiHash(fn), executionScope: fn.executionScope ?? null, executionScopeHash: fn.executionScope ? executionScopeHash(fn.executionScope) : null });
    return { sourcePath, canonicalSha256: canonicalSourceSha256(document) };
  });
  return { sourceCount: inputs.length, familyCount, targetCount, bindingCount, sourceDigests, bindings };
}

/** Compile the fixed v7 identity inventory for review. No candidate is activated or written. */
export function prepareV7Sources(inputs: readonly SourceCatalogInput[]): V7PreparationReport {
  if (inputs.length !== V7_SOURCE_PATHS.length || inputs.some((input, index) => input.sourcePath !== V7_SOURCE_PATHS[index])) throw new Error('V7 preparation requires every fixed source path exactly once, in canonical order');
  let familyCount = 0;
  let targetCount = 0;
  const bindings: V7CompiledBinding[] = [];
  const sourceDigests = inputs.map(({ sourcePath, document }) => {
    const normalized = normalizeV7SourceDocument(document, sourcePath);
    const root = record(normalized, sourcePath);
    const families = sourceFamilies(normalized, sourcePath);
    familyCount += (root.families as unknown[]).length;
    targetCount += families.reduce((count, chain) => count + chain.contracts.length, 0);
    for (const chain of families) for (const contract of chain.contracts) for (const fn of contract.functions) {
      const identity = V7_SOURCE_IDENTITIES.find((row) => row.sourcePath === sourcePath && row.capabilityId === fn.capabilityId);
      if (!identity) throw new Error(`${sourcePath} has no exact reviewed v7 identity for ${fn.capabilityId}`);
      bindings.push({ sourcePath, familyId: identity.familyId, familyVersion: identity.familyVersion, chainId: chain.chainId, contract: fn.contract, functionName: fn.functionName, signature: fn.signature, selector: toFunctionSelector(fn.signature).toLowerCase(), capabilityId: fn.capabilityId, abiHash: functionAbiHash(fn), executionScope: fn.executionScope ?? null, executionScopeHash: fn.executionScope ? executionScopeHash(fn.executionScope) : null });
    }
    return { sourcePath, canonicalSha256: canonicalSourceSha256(document) };
  });
  if (bindings.length !== V7_SOURCE_IDENTITIES.length || new Set(bindings.map((binding) => binding.capabilityId)).size !== bindings.length || new Set(bindings.map((binding) => `${binding.sourcePath}:${binding.chainId}:${binding.contract.toLowerCase()}:${binding.selector}`)).size !== bindings.length) throw new Error('V7 preparation did not consume a unique, exact identity inventory');
  return { sourceCount: inputs.length, familyCount, targetCount, bindingCount: bindings.length, sourceDigests, bindings };
}

export function canonicalSourceSha256(document: unknown): string {
  assertJsonData(document, 'Source snapshot');
  return createHash('sha256').update(canonical(document), 'utf8').digest('hex');
}

function validateAdmissions(document: unknown, inputs: readonly SourceCatalogInput[], compiled: readonly { sourcePath: string; sha256: string; chains: readonly DefiChainPolicy[] }[]): Map<string, SourceAdmissionBinding> {
  assertJsonData(document, 'Source admissions');
  const root = record(document, 'Source admissions');
  onlyKeys(root, ['schemaVersion', 'snapshots'], 'Source admissions');
  requireKeys(root, ['schemaVersion', 'snapshots'], 'Source admissions');
  if (root.schemaVersion !== 1 || !Array.isArray(root.snapshots)) throw new Error('Unsupported source-admission schema');
    const expectedPaths = [...inputs.map((item) => item.sourcePath)].sort(cmp);
    const isV3 = expectedPaths.length === 1 && expectedPaths[0] === V3_SOURCE_PATH;
    const isV4 = expectedPaths.length === V4_SOURCE_PATHS.length && expectedPaths.every((path, index) => path === V4_SOURCE_PATHS[index]);
    const isV5 = expectedPaths.length === V5_SOURCE_PATHS.length && expectedPaths.every((path, index) => path === V5_SOURCE_PATHS[index]);
    const isV6 = expectedPaths.length === V6_SOURCE_PATHS.length && expectedPaths.every((path, index) => path === V6_SOURCE_PATHS[index]);
    const isV7 = expectedPaths.length === V7_SOURCE_PATHS.length && expectedPaths.every((path, index) => path === V7_SOURCE_PATHS[index]);
    if (!isV3 && !isV4 && !isV5 && !isV6 && !isV7 && (expectedPaths.length !== ALLOWED_SOURCE_PATHS.length || expectedPaths.some((path, index) => path !== ALLOWED_SOURCE_PATHS[index]))) throw new Error('Admissions require exactly the allowlisted v2 source snapshots, fixed v3 workflow source, fixed v4 source group, or a complete selected v5 plan group');
  if (root.snapshots.length !== expectedPaths.length) throw new Error('Admissions must bind every complete source snapshot');
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const [index, value] of root.snapshots.entries()) {
    const row = record(value, `Source admissions.snapshots[${index}]`);
    onlyKeys(row, ['sourcePath', 'canonicalSha256', 'bindings'], 'Source admission snapshot');
    requireKeys(row, ['sourcePath', 'canonicalSha256', 'bindings'], 'Source admission snapshot');
    const path = requireString(row.sourcePath, 'Source admission sourcePath');
      if (!(isV3 ? path === V3_SOURCE_PATH : isV4 ? V4_SOURCE_PATHS.includes(path) : isV5 ? V5_SOURCE_PATHS.includes(path) : isV6 ? V6_SOURCE_PATHS.includes(path) : isV7 ? V7_SOURCE_PATHS.includes(path) : ALLOWED_SOURCE_PATHS.includes(path)) || snapshots.has(path)) throw new Error('Source admissions contain an unknown or duplicate path');
    if (typeof row.canonicalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.canonicalSha256)) throw new Error('Source admission has invalid canonical SHA-256');
    if (!Array.isArray(row.bindings)) throw new Error('Source admission bindings must be an array');
    snapshots.set(path, row);
  }
  if ([...snapshots.keys()].sort(cmp).some((path, index) => path !== expectedPaths[index])) throw new Error('Source admissions are missing an allowlisted snapshot');

  const admitted = new Map<string, SourceAdmissionBinding>();
  for (const source of compiled) {
    const snapshot = snapshots.get(source.sourcePath)!;
    if (snapshot.canonicalSha256 !== source.sha256) throw new Error(`Source snapshot hash does not match admission: ${source.sourcePath}`);
    const expected = source.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => ({
      familyId: fn.protocol!, chainId: fn.chainId, contract: fn.contract.toLowerCase(), signature: fn.signature,
      ...(isV6 || isV7 ? { selector: toFunctionSelector(fn.signature).toLowerCase() } : {}), abiHash: functionAbiHash(fn), capabilityId: fn.capabilityId,
    })))).sort((a, b) => cmp(`${a.familyId}:${a.chainId}:${a.contract}:${a.signature}`, `${b.familyId}:${b.chainId}:${b.contract}:${b.signature}`));
    if (!isV6 && !isV7 && expected.some((binding) => !FAMILY_ID_VERSIONS[binding.familyId])) throw new Error(`Source admission includes a family without an explicit stable ID version: ${source.sourcePath}`);
    const bindings = snapshot.bindings as unknown[];
    if (bindings.length !== expected.length) throw new Error(`Admission binding count mismatch for ${source.sourcePath}`);
    for (const [index, value] of bindings.entries()) {
      const binding = record(value, `Admission binding[${index}]`);
     onlyKeys(binding, ['familyId', 'chainId', 'contract', 'signature', ...(isV6 || isV7 ? ['selector'] : []), 'abiHash', 'capabilityId', ...(isV3 || isV4 || isV5 || isV6 || isV7 ? ['executionScope', 'executionScopeHash'] : [])], 'Admission binding');
       requireKeys(binding, ['familyId', 'chainId', 'contract', 'signature', ...(isV6 || isV7 ? ['selector', 'executionScope', 'executionScopeHash'] : []), 'abiHash', 'capabilityId'], 'Admission binding');
       if (typeof binding.familyId !== 'string' || typeof binding.chainId !== 'number' || typeof binding.contract !== 'string' || typeof binding.signature !== 'string' || (isV6 || isV7) && typeof binding.selector !== 'string' || typeof binding.abiHash !== 'string' || typeof binding.capabilityId !== 'string' || (isV6 || isV7) && binding.executionScope !== null && (typeof binding.executionScope !== 'object' || Array.isArray(binding.executionScope)) || (isV6 || isV7) && binding.executionScopeHash !== null && typeof binding.executionScopeHash !== 'string') throw new Error('Admission binding has invalid field types');
       const hasVersionedSelector = isV6 || isV7;
       const nullScopePairAllowed = isV6 || isV7;
       const normalized = { familyId: binding.familyId, chainId: binding.chainId, contract: binding.contract.toLowerCase(), signature: binding.signature, ...(hasVersionedSelector ? { selector: (binding.selector as string).toLowerCase() } : {}), abiHash: binding.abiHash, capabilityId: binding.capabilityId };
      if (!equal(normalized, expected[index])) throw new Error(`Admission binding does not match source ABI in ${source.sourcePath}: ${normalized.capabilityId}`);
        if (isV3 || isV4 || isV5 || isV6 || isV7) {
         const candidate = source.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => fn.capabilityId === normalized.capabilityId);
         const candidateScope = candidate?.executionScope;
         const hasScope = Object.hasOwn(binding, 'executionScope');
         const hasScopeHash = Object.hasOwn(binding, 'executionScopeHash');
         const scopeIsNull = binding.executionScope === null;
         const hashIsNull = binding.executionScopeHash === null;
          if (isV6 || isV7) {
            if (!hasScope || !hasScopeHash) throw new Error(`${isV6 ? 'V6' : 'V7'} admission must explicitly bind executionScope and executionScopeHash: ${normalized.capabilityId}`);
            if (scopeIsNull !== hashIsNull) throw new Error(`${isV6 ? 'V6' : 'V7'} admission has an inconsistent null execution-scope pair: ${normalized.capabilityId}`);
         } else if (scopeIsNull || hashIsNull) {
           throw new Error(`Admission execution scope/hash must be omitted rather than null: ${normalized.capabilityId}`);
         }
         if (candidateScope && (binding.executionScope === undefined || binding.executionScope === null || !equal(binding.executionScope, candidateScope))) throw new Error(`Admission execution scope does not match source binding: ${normalized.capabilityId}`);
         if (binding.executionScope !== undefined && binding.executionScope !== null) {
           const rawScope = binding.executionScope;
           if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) throw new Error(`Admission execution scope is malformed: ${normalized.capabilityId}`);
           const scope = rawScope as DefiExecutionScope;
           if (typeof binding.executionScopeHash !== 'string' || binding.executionScopeHash !== executionScopeHash(scope)) throw new Error(`Admission execution-scope hash mismatch: ${normalized.capabilityId}`);
          const ambientScopeRequired = candidate?.protocol === 'ambient' && candidate.chainId === 1
            && candidate.contract.toLowerCase() === '0xaaaaaaaaa24eeeb8d57d431224f73832bc34f688'
            && candidate.signature === 'userCmd(uint16,bytes)' && candidate.functionName === 'userCmd';
          const expectedScopeIndex = (candidate?.protocol === 'uniswap-v3-position-manager' || candidate?.protocol === 'pancakeswap-v3-position-manager') && candidate.signature === 'multicall(bytes[])'
            ? 0
            : candidate?.protocol === 'morpho-blue' && candidate.functionName === 'supplyCollateral' ? 3
              : candidate?.protocol === 'morpho-blue' && ['supply', 'repay'].includes(candidate.functionName) ? 4 : undefined;
          if (!ambientScopeRequired && (expectedScopeIndex === undefined || scope.kind !== 'empty-callback-data-v1' && scope.kind !== 'same-target-multicall-v1')
            || (scope.kind === 'empty-callback-data-v1' && scope.bytesArgIndex !== expectedScopeIndex)
            || (scope.kind === 'same-target-multicall-v1' && (expectedScopeIndex !== 0 || candidate?.signature !== 'multicall(bytes[])'))) {
            throw new Error(`Admission execution scope is not defined for this function identity: ${normalized.capabilityId}`);
           }
           if (ambientScopeRequired && (scope.kind !== 'ambient-coldpath-v1' || !equal(scope, { kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 1 }))) throw new Error(`Admission execution scope is not defined for this Ambient root: ${normalized.capabilityId}`);
          } else if (hasScopeHash && binding.executionScopeHash !== undefined && !(nullScopePairAllowed && scopeIsNull && hashIsNull)) throw new Error(`Admission has execution-scope hash without scope: ${normalized.capabilityId}`);
           const scopeRequired = (candidate?.protocol === 'uniswap-v3-position-manager' || isV4 && candidate?.protocol === 'pancakeswap-v3-position-manager') && candidate.signature === 'multicall(bytes[])'
            || candidate?.protocol === 'morpho-blue' && ['supply', 'repay', 'supplyCollateral'].includes(candidate.functionName)
            || candidate?.protocol === 'ambient' && candidate.chainId === 1 && candidate.contract.toLowerCase() === '0xaaaaaaaaa24eeeb8d57d431224f73832bc34f688' && candidate.signature === 'userCmd(uint16,bytes)';
         if (scopeRequired && (binding.executionScope === undefined || binding.executionScope === null)) throw new Error(`Missing mandatory execution scope binding: ${normalized.capabilityId}`);
       }
      const key = `${source.sourcePath}:${normalized.capabilityId}`;
      if (admitted.has(key)) throw new Error(`Duplicate source admission binding ${key}`);
      admitted.set(key, { ...normalized, ...(binding.executionScope && binding.executionScopeHash ? { executionScope: binding.executionScope as DefiExecutionScope, executionScopeHash: binding.executionScopeHash as string } : {}) });
    }
  }
  return admitted;
}

/** Pure conservative merge. Existing definitions remain byte-semantically pinned; conflicts fail closed. */
export function assembleCatalogFromSources(baseline: DefiRegistryFragment, inputs: readonly SourceCatalogInput[], admissionDocument?: unknown): DefiRegistryFragment {
  const baselineValid = validateCatalogDocument({ schemaVersion: 1, chains: baseline.chains });
  const result = new Map<number, Map<string, DefiFunctionPolicy[]>>();
  for (const chain of baselineValid.chains) {
    const contracts = new Map<string, DefiFunctionPolicy[]>();
    for (const contract of chain.contracts) contracts.set(contract.address.toLowerCase(), [...contract.functions]);
    result.set(chain.chainId, contracts);
  }
  const compiled = inputs.map((input) => {
    const document = record(input.document, input.sourcePath);
    const normalized = input.sourcePath.startsWith('data/defi-catalog/v6/') && !Object.hasOwn(document, 'unresolved') ? { ...document, unresolved: [] } : input.document;
    const sourceDocument = normalizeV7SourceDocument(normalized, input.sourcePath);
    return { sourcePath: input.sourcePath, sha256: canonicalSourceSha256(input.document), chains: sourceFamilies(sourceDocument, input.sourcePath) };
  });
  const admissions = admissionDocument === undefined ? undefined : validateAdmissions(admissionDocument, inputs, compiled);
  for (const [inputIndex, input] of inputs.entries()) {
    const source = compiled[inputIndex];
    for (const chain of source.chains) {
      const contracts = result.get(chain.chainId) ?? new Map<string, DefiFunctionPolicy[]>();
      for (const contract of chain.contracts) {
        const prior = contracts.get(contract.address.toLowerCase()) ?? [];
        for (const sourceCandidate of contract.functions) {
          const bindingKey = `${input.sourcePath}:${sourceCandidate.capabilityId}`;
          const admitted = admissions?.get(bindingKey);
          const candidate: DefiFunctionPolicy = admitted ? {
            ...sourceCandidate,
            status: 'active',
            provenance: { ...sourceCandidate.provenance, status: 'verified' },
            inactiveReason: undefined,
            label: sourceCandidate.functionName,
            description: `${sourceCandidate.protocol} ${sourceCandidate.functionName} admitted from exact source snapshot and ABI binding.`,
            ...(admitted.executionScope ? { executionScope: admitted.executionScope } : {}),
          } : sourceCandidate;
          const selector = toFunctionSelector(candidate.signature).toLowerCase();
          const collision = prior.find((existing) => toFunctionSelector(existing.signature).toLowerCase() === selector);
          if (collision) {
            if (collision.signature !== candidate.signature || collision.type !== candidate.type || collision.contract.toLowerCase() !== candidate.contract.toLowerCase() || collision.chainId !== candidate.chainId || !equal(collision.abi, candidate.abi)) throw new Error(`Source authority conflicts with existing selector at ${chain.chainId}:${contract.address}:${selector}`);
            const priorScopeHash = collision.executionScope ? executionScopeHash(collision.executionScope) : undefined;
            const nextScopeHash = candidate.executionScope ? executionScopeHash(candidate.executionScope) : undefined;
            if (priorScopeHash !== nextScopeHash) throw new Error(`Source execution scope conflicts with existing selector at ${chain.chainId}:${contract.address}:${selector}`);
            continue;
          }
          if (prior.some((existing) => existing.capabilityId === candidate.capabilityId)) throw new Error(`Source capability ID conflicts with existing definition: ${candidate.capabilityId}`);
          prior.push(candidate);
        }
        contracts.set(contract.address.toLowerCase(), prior);
      }
      result.set(chain.chainId, contracts);
    }
  }
  const chains: DefiChainPolicy[] = [...result.entries()].sort(([a], [b]) => a - b).map(([chainId, contracts]) => ({ chainId, status: 'active', contracts: [...contracts.entries()].sort(([a], [b]) => cmp(a, b)).map(([address, functions]) => ({ address: functions[0]?.contract ?? address, status: functions.some((fn) => fn.status === 'active') ? 'active' as const : 'inactive' as const, functions: [...functions].sort((a, b) => cmp(a.capabilityId, b.capabilityId)) })) }));
  const assembled = validateCatalogDocument({ schemaVersion: 1, chains });
  assertBaselinePreserved(assembled, { schemaVersion: 1, baselineManifestHash: BASELINE_MANIFEST_HASH, chains: baselineValid.chains });
  return assembled;
}

/** V6-specific fail-closed entry point; without admissions all added functions remain inactive. */
export function assembleV6SourceCandidates(baseline: DefiRegistryFragment, inputs: readonly SourceCatalogInput[], admissionDocument?: unknown): DefiRegistryFragment {
  prepareV6Sources(inputs);
  return assembleCatalogFromSources(baseline, inputs, admissionDocument);
}

/** Pure v7 preparation/assembly against the complete immutable v6 catalog baseline. */
export function assembleV7SourceCandidates(baseline: DefiRegistryFragment, planValue: unknown, inputs: readonly SourceCatalogInput[], admissionDocument?: unknown): DefiRegistryFragment {
  const plan = validateV7AssemblyPlan(planValue);
  if (inputs.length !== plan.sourcePaths.length || inputs.some((input, index) => input.sourcePath !== plan.sourcePaths[index])) throw new Error('V7 source inputs must exactly match the selected assembly-plan paths');
  const validatedBaseline = validateCatalogDocument({ schemaVersion: 1, chains: baseline.chains });
  const baselineFunctions = buildReviewedManifest([validatedBaseline]).capabilities;
  if (baselineFunctions.length !== 640 || baselineFunctions.filter((fn) => fn.executionScope).length !== 15) throw new Error('V7 preparation requires the frozen 640-definition, 15-scope v6 baseline');
  prepareV7Sources(inputs);
  return assembleCatalogFromSources({ chains: validatedBaseline.chains }, inputs, admissionDocument);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const missing = keys.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
}

function validateAbiParam(value: unknown, label: string): void {
  const param = record(value, label);
  onlyKeys(param, ABI_PARAM_KEYS, label);
  requireKeys(param, ['name', 'type'], label);
  if (typeof param.name !== 'string' || typeof param.type !== 'string') throw new Error(`${label} name/type must be strings`);
  if (param.internalType !== undefined && typeof param.internalType !== 'string') throw new Error(`${label}.internalType must be a string`);
  if (param.components !== undefined) {
    if (!Array.isArray(param.components)) throw new Error(`${label}.components must be an array`);
    param.components.forEach((child, index) => validateAbiParam(child, `${label}.components[${index}]`));
  }
}

function validateFunction(value: unknown, label: string): void {
  const fn = record(value, label);
  onlyKeys(fn, FUNCTION_KEYS, label);
  requireKeys(fn, ['capabilityId', 'type', 'chainId', 'contract', 'functionName', 'signature', 'abi', 'status', 'provenance'], label);
  const abi = record(fn.abi, `${label}.abi`);
  onlyKeys(abi, ABI_KEYS, `${label}.abi`);
  requireKeys(abi, ['type', 'name', 'stateMutability', 'inputs', 'outputs'], `${label}.abi`);
  if (abi.type !== 'function' || typeof abi.name !== 'string' || typeof abi.stateMutability !== 'string' || !['pure', 'view', 'nonpayable', 'payable'].includes(abi.stateMutability)) throw new Error(`${label}.abi has an invalid function declaration`);
  for (const key of ['inputs', 'outputs']) {
    if (!Array.isArray(abi[key])) throw new Error(`${label}.abi.${key} must be an array`);
    (abi[key] as unknown[]).forEach((param, index) => validateAbiParam(param, `${label}.abi.${key}[${index}]`));
  }
  const inputs = (abi.inputs as Array<{ type: string; components?: readonly { type: string; components?: readonly unknown[] }[] }>).map((param) => sourceCanonicalType(param)).join(',');
  const outputs = (abi.outputs as Array<{ type: string; components?: readonly { type: string; components?: readonly unknown[] }[] }>).map((param) => sourceCanonicalType(param)).join(',');
  parseAbiItem(`function ${abi.name}(${inputs}) ${abi.stateMutability}${outputs ? ` returns (${outputs})` : ''}`);
  const provenance = record(fn.provenance, `${label}.provenance`);
  onlyKeys(provenance, PROVENANCE_KEYS, `${label}.provenance`);
  requireKeys(provenance, PROVENANCE_KEYS, `${label}.provenance`);
  if (typeof provenance.sourceRef !== 'string' || typeof provenance.verifiedAt !== 'string' || !['verified', 'candidate'].includes(String(provenance.status))) throw new Error(`${label}.provenance has invalid fields`);
  if (fn.policy !== undefined) {
    const policy = record(fn.policy, `${label}.policy`);
    onlyKeys(policy, POLICY_KEYS, `${label}.policy`);
    requireKeys(policy, POLICY_KEYS, `${label}.policy`);
    if (typeof policy.ref !== 'string' || typeof policy.version !== 'number' || !Number.isSafeInteger(policy.version)) throw new Error(`${label}.policy has invalid fields`);
  }
  for (const key of ['capabilityId', 'contract', 'functionName', 'signature', 'status', 'label', 'description', 'protocol', 'operation', 'inactiveReason', 'abiHash']) {
    if (fn[key] !== undefined && typeof fn[key] !== 'string') throw new Error(`${label}.${key} must be a string`);
  }
  if (fn.type !== 'contract_call' && fn.type !== 'typed_data_sign') throw new Error(`${label}.type is invalid`);
  if (typeof fn.chainId !== 'number' || !Number.isSafeInteger(fn.chainId)) throw new Error(`${label}.chainId must be a safe integer`);
  if (fn.warnings !== undefined && (!Array.isArray(fn.warnings) || fn.warnings.some((item) => typeof item !== 'string'))) throw new Error(`${label}.warnings must be an array of strings`);
  if (fn.executionScope !== undefined) executionScopeHash(fn.executionScope as DefiExecutionScope);
}

export function validateCatalogDocument(document: unknown): DefiRegistryFragment {
  const root = record(document, 'Catalog document');
  onlyKeys(root, TOP_KEYS, 'Catalog document');
  requireKeys(root, TOP_KEYS, 'Catalog document');
  if (root.schemaVersion !== 1) throw new Error('Catalog schemaVersion must be 1');
  if (!Array.isArray(root.chains)) throw new Error('Catalog chains must be an array');
  root.chains.forEach((chainValue, chainIndex) => {
    const chain = record(chainValue, `chains[${chainIndex}]`);
    onlyKeys(chain, CHAIN_KEYS, `chains[${chainIndex}]`);
    requireKeys(chain, CHAIN_KEYS, `chains[${chainIndex}]`);
    if (typeof chain.chainId !== 'number' || !Number.isSafeInteger(chain.chainId) || !['active', 'inactive'].includes(String(chain.status)) || !Array.isArray(chain.contracts)) throw new Error(`chains[${chainIndex}] has invalid fields`);
    chain.contracts.forEach((contractValue, contractIndex) => {
      const label = `chains[${chainIndex}].contracts[${contractIndex}]`;
      const contract = record(contractValue, label);
      onlyKeys(contract, CONTRACT_KEYS, label);
      requireKeys(contract, CONTRACT_KEYS, label);
      if (typeof contract.address !== 'string' || !['active', 'inactive'].includes(String(contract.status)) || !Array.isArray(contract.functions)) throw new Error(`${label} has invalid fields`);
      contract.functions.forEach((fn, functionIndex) => validateFunction(fn, `${label}.functions[${functionIndex}]`));
    });
  });
  const fragment = { chains: root.chains as DefiChainPolicy[] };
  // Reuse the production manifest validator for canonical signatures, verified active provenance,
  // hierarchy consistency, duplicate IDs and contract-local selector collisions.
  buildReviewedManifest([fragment]);
  return fragment;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Catalog contains a non-finite number');
  if (typeof value === 'bigint' || typeof value === 'undefined') throw new Error('Catalog contains unsupported JSON data');
  return JSON.stringify(value);
}

export function stableCatalogJson(fragment: DefiRegistryFragment): string {
  const reviewed = buildReviewedManifest([fragment]);
  const normalized: DefiRegistryFragment = { chains: reviewed.chains };
  return `${canonical({ schemaVersion: 1, chains: normalized.chains })}\n`;
}

export function renderGeneratedModule(fragment: DefiRegistryFragment): string {
  const document = JSON.parse(stableCatalogJson(fragment)) as { chains: DefiChainPolicy[] };
  return `import type { DefiRegistryFragment } from '../defi-manifest.types';\n\nexport const GENERATED_DEFI_REGISTRY: DefiRegistryFragment = ${canonical({ chains: document.chains })};\n`;
}

type BaselineDocument = { schemaVersion: 1; baselineManifestHash: string; chains: readonly DefiChainPolicy[] };

export function validateBaseline(document: unknown): BaselineDocument {
  const root = record(document, 'Baseline fixture');
  onlyKeys(root, ['schemaVersion', 'baselineManifestHash', 'chains'], 'Baseline fixture');
  requireKeys(root, ['schemaVersion', 'baselineManifestHash', 'chains'], 'Baseline fixture');
  if (root.schemaVersion !== 1 || root.baselineManifestHash !== BASELINE_MANIFEST_HASH) throw new Error('Baseline fixture does not match the pinned pre-migration snapshot');
  const fragment = validateCatalogDocument({ schemaVersion: 1, chains: root.chains });
  const hash = buildDefiManifestHash(fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)));
  if (hash !== BASELINE_MANIFEST_HASH) throw new Error('Baseline fixture manifest hash mismatch');
  return { schemaVersion: 1, baselineManifestHash: BASELINE_MANIFEST_HASH, chains: fragment.chains };
}

function flatten(chains: readonly DefiChainPolicy[]): DefiFunctionPolicy[] {
  return chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
}

function equal(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }

export function assertBaselinePreserved(fragment: DefiRegistryFragment, baseline: BaselineDocument): void {
  const currentById = new Map(flatten(fragment.chains).map((fn) => [fn.capabilityId, fn]));
  for (const baselineFn of flatten(baseline.chains)) {
    const current = currentById.get(baselineFn.capabilityId);
    if (!current) throw new Error(`Pinned baseline capability removed: ${baselineFn.capabilityId}`);
    if (!equal(current, baselineFn)) throw new Error(`Pinned baseline definition changed: ${baselineFn.capabilityId}`);
  }
}

export function catalogDiff(before: DefiRegistryFragment, after: DefiRegistryFragment): { added: string[]; removed: string[]; authorityChanged: string[]; abiChanged: string[]; metadataChanged: string[] } {
  const oldFns = new Map(flatten(before.chains).map((fn) => [fn.capabilityId, fn]));
  const newFns = new Map(flatten(after.chains).map((fn) => [fn.capabilityId, fn]));
  const added = [...newFns.keys()].filter((id) => !oldFns.has(id)).sort();
  const removed = [...oldFns.keys()].filter((id) => !newFns.has(id)).sort();
  const authorityChanged: string[] = [];
  const abiChanged: string[] = [];
  const metadataChanged: string[] = [];
  for (const [id, oldFn] of oldFns) {
    const newFn = newFns.get(id);
    if (!newFn) continue;
    const authority = (fn: DefiFunctionPolicy) => ({
      capabilityId: fn.capabilityId,
      type: fn.type,
      chainId: fn.chainId,
      contract: fn.contract.toLowerCase(),
      functionName: fn.functionName,
      signature: fn.signature,
      abi: fn.abi,
      abiHash: fn.abiHash,
      status: fn.status,
      ...(fn.executionScope ? { executionScopeHash: executionScopeHash(fn.executionScope) } : {}),
    });
    const { capabilityId: _id, type: _type, chainId: _chainId, contract: _contract, functionName: _name, signature: oldSignature, abi: oldAbi, abiHash: _hash, status: _status, ...oldMetadata } = oldFn;
    const { capabilityId: _newId, type: _newType, chainId: _newChainId, contract: _newContract, functionName: _newName, signature: newSignature, abi: newAbi, abiHash: _newHash, status: _newStatus, ...newMetadata } = newFn;
    if (!equal(authority(oldFn), authority(newFn))) authorityChanged.push(id);
    if (!equal([oldAbi, oldSignature], [newAbi, newSignature])) abiChanged.push(id);
    if (!equal(oldMetadata, newMetadata)) metadataChanged.push(id);
  }
  return { added, removed, authorityChanged: authorityChanged.sort(), abiChanged: abiChanged.sort(), metadataChanged: metadataChanged.sort() };
}

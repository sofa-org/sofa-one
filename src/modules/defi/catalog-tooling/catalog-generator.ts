import { createHash } from 'node:crypto';
import { parseAbiItem, toFunctionSelector } from 'viem';
import { buildDefiManifestHash, buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';
import { executionScopeHash } from '../execution/scope';
import type { DefiExecutionScope } from '../defi.types';

export const BASELINE_MANIFEST_HASH = '0x43ec3be0b20a32457719d8edb17c8eaa40c93480921d6e7c86e9c2cacdec5897' as const;

const TOP_KEYS = ['schemaVersion', 'chains'];
const CHAIN_KEYS = ['chainId', 'status', 'contracts'];
const CONTRACT_KEYS = ['address', 'status', 'functions'];
const FUNCTION_KEYS = ['capabilityId', 'type', 'chainId', 'contract', 'functionName', 'signature', 'abi', 'abiHash', 'status', 'provenance', 'policy', 'label', 'description', 'protocol', 'operation', 'warnings', 'inactiveReason', 'executionScope'];
const ABI_KEYS = ['type', 'name', 'stateMutability', 'inputs', 'outputs', 'internalType'];
const ABI_PARAM_KEYS = ['name', 'type', 'components', 'internalType'];
const PROVENANCE_KEYS = ['sourceRef', 'verifiedAt', 'status'];
const POLICY_KEYS = ['ref', 'version'];

export type CatalogCliMode = 'generate' | 'check' | 'diff' | 'assemble';
export type CatalogCliOptions = Readonly<{ mode: CatalogCliMode; inputPath: string }>;
export type SourceCatalogInput = Readonly<{ sourcePath: string; document: unknown }>;

export const SOURCE_CHAIN_IDS = Object.freeze([1, 10, 56, 137, 143, 8453, 42161]);

const SOURCE_ROOT_KEYS = ['schemaVersion', 'families', 'sources', 'unresolved'];
const SOURCE_A_FAMILY_KEYS = ['familyId', 'familyVersion', 'contracts'];
const SOURCE_B_FAMILY_KEYS = ['familyId', 'familyVersion', 'chains'];
const SOURCE_CONTRACT_KEYS = ['chainId', 'address', 'contractName', 'sourceRefs', 'abiFunctions'];
const SOURCE_RECORD_KEYS = ['sourceId', 'url', 'retrievedAtUtc', 'evidence'];
const SOURCE_B_CHAIN_KEYS = ['chainId', 'status', 'contracts'];
const SOURCE_B_CONTRACT_KEYS = ['address', 'status', 'contractName', 'functions'];
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
});
const ALLOWED_SOURCE_PATHS = Object.freeze([
  'data/defi-catalog/v2/sources/dex.json',
  'data/defi-catalog/v2/sources/lending-yield.json',
]);
const V3_SOURCE_PATH = 'data/defi-catalog/v3/sources/workflow-extensions.json';

export type SourceAdmissionBinding = Readonly<{ familyId: string; chainId: number; contract: string; signature: string; abiHash: string; capabilityId: string; executionScope?: DefiExecutionScope; executionScopeHash?: string }>;
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
  if (mode !== 'generate' && mode !== 'check' && mode !== 'diff' && mode !== 'assemble') throw new Error('Usage: cli.ts <generate|check|diff|assemble> [--input data/defi-catalog/vN/catalog.json]');
  if (mode === 'assemble' && args.length > 3) throw new Error('assemble accepts at most one fixed v3 input selector');
  let inputPath = 'data/defi-catalog/v1/catalog.json';
  let inputSeen = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--input' || inputSeen || !args[index + 1]) throw new Error('Usage: cli.ts <generate|check|diff> [--input data/defi-catalog/vN/catalog.json]');
    inputSeen = true;
    inputPath = args[++index];
  }
  if (mode === 'assemble') {
    if (inputSeen && inputPath !== 'data/defi-catalog/v3/catalog.json') throw new Error('assemble only accepts the fixed v3 source assembly selector');
    return { mode, inputPath: inputSeen ? 'data/defi-catalog/v3/catalog.json' : 'data/defi-catalog/v2/catalog.json' };
  }
  if (!/^data\/defi-catalog\/v[1-9][0-9]*\/catalog\.json$/.test(inputPath)) throw new Error('Catalog input must be a repository source file at data/defi-catalog/vN/catalog.json');
  return { mode, inputPath };
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
  const capabilityId = stableFamilyVersion
    ? `${context.familyId}:${stableFamilyVersion}:${context.chainId}:${context.address}:${slug}`
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
  return {
    capabilityId, type: 'contract_call', chainId: context.chainId, contract: context.address,
    functionName: name, signature, abi, abiHash: functionAbiHash({ abi }), status: 'inactive',
    provenance: { sourceRef, verifiedAt: source.retrievedAtUtc, status: 'candidate' },
    label: typeof raw.label === 'string' ? raw.label : name,
    description: typeof raw.description === 'string' ? raw.description : `${context.contractName} ${name} source-qualified fixed ABI.`,
    protocol: context.familyId, operation: typeof raw.operation === 'string' ? raw.operation : slug,
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
  const add = (familyId: string, familyVersion: string, familySources: readonly string[], chainValue: unknown, addressValue: unknown, nameValue: unknown, refsValue: unknown, functionsValue: unknown, label: string, contractStatus?: unknown) => {
    const chainId = chainValue;
    if (typeof chainId !== 'number' || !SOURCE_CHAIN_IDS.includes(chainId)) throw new Error(`${label} has unsupported chain`);
    const address = normalizeSourceAddress(addressValue, `${label}.address`);
    const contractName = requireString(nameValue, `${label}.contractName`);
    if (contractStatus !== undefined && contractStatus !== 'inactive' && contractStatus !== 'candidate') throw new Error(`${label} cannot promote source contract status`);
    if (!Array.isArray(refsValue) || refsValue.length === 0 || new Set(refsValue).size !== refsValue.length || refsValue.some((ref) => typeof ref !== 'string' || !recordMap.has(ref))) throw new Error(`${label} has missing, duplicate, or undeclared source references`);
    if (!Array.isArray(functionsValue)) throw new Error(`${label} functions must be an array`);
    const entries = functionsValue.map((item, i) => makeSourceFunction(record(item, `${label}.functions[${i}]`), { familyId, familyVersion, chainId, address, contractName, familySources, records: recordMap }));
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
    if (familyFormat === 'A') {
      for (const [index, item] of (family.contracts as unknown[]).entries()) {
        const contract = record(item, `${sourcePath}.families[${familyIndex}].contracts[${index}]`);
        onlyKeys(contract, SOURCE_CONTRACT_KEYS, 'Source contract'); requireKeys(contract, SOURCE_CONTRACT_KEYS, 'Source contract');
        add(familyId, familyVersion, contract.sourceRefs as string[], contract.chainId, contract.address, contract.contractName, contract.sourceRefs, contract.abiFunctions, 'Source contract');
      }
    } else if (familyFormat === 'B') {
      for (const [ci, chainValue] of (family.chains as unknown[]).entries()) {
        const chain = record(chainValue, `Source family chain[${ci}]`); onlyKeys(chain, SOURCE_B_CHAIN_KEYS, 'Source family chain'); requireKeys(chain, SOURCE_B_CHAIN_KEYS, 'Source family chain');
        if (chain.status !== 'inactive' && chain.status !== 'candidate') throw new Error('Source chain cannot be active');
        if (!Array.isArray(chain.contracts)) throw new Error('Source family chain contracts must be an array');
        for (const [index, contractValue] of chain.contracts.entries()) {
          const contract = record(contractValue, `Source family contract[${index}]`); onlyKeys(contract, SOURCE_B_CONTRACT_KEYS, 'Source family contract'); requireKeys(contract, ['address', 'status', 'functions'], 'Source family contract');
          if (contract.contractName !== undefined && typeof contract.contractName !== 'string') throw new Error('Source family contract contractName must be a string');
          add(familyId, familyVersion, records.map((item) => item.sourceId), chain.chainId, contract.address, contract.contractName ?? familyId, records.map((item) => item.sourceId), contract.functions, 'Source family contract', contract.status);
        }
      }
    } else throw new Error('Source family must use a supported contracts or chains format');
  }
  return [...chains.entries()].sort(([a], [b]) => a - b).map(([chainId, contracts]) => ({ chainId, status: 'inactive' as const, contracts: [...contracts.entries()].sort(([a], [b]) => cmp(a, b)).map(([address, functions]) => ({ address, status: 'inactive' as const, functions: functions.sort((a, b) => cmp(a.capabilityId, b.capabilityId)) })) }));
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
  if (!isV3 && (expectedPaths.length !== ALLOWED_SOURCE_PATHS.length || expectedPaths.some((path, index) => path !== ALLOWED_SOURCE_PATHS[index]))) throw new Error('Admissions require exactly the allowlisted v2 source snapshots or fixed v3 workflow source');
  if (root.snapshots.length !== expectedPaths.length) throw new Error('Admissions must bind every complete source snapshot');
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const [index, value] of root.snapshots.entries()) {
    const row = record(value, `Source admissions.snapshots[${index}]`);
    onlyKeys(row, ['sourcePath', 'canonicalSha256', 'bindings'], 'Source admission snapshot');
    requireKeys(row, ['sourcePath', 'canonicalSha256', 'bindings'], 'Source admission snapshot');
    const path = requireString(row.sourcePath, 'Source admission sourcePath');
    if (!(isV3 ? path === V3_SOURCE_PATH : ALLOWED_SOURCE_PATHS.includes(path)) || snapshots.has(path)) throw new Error('Source admissions contain an unknown or duplicate path');
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
      abiHash: functionAbiHash(fn), capabilityId: fn.capabilityId,
    })))).sort((a, b) => cmp(`${a.familyId}:${a.chainId}:${a.contract}:${a.signature}`, `${b.familyId}:${b.chainId}:${b.contract}:${b.signature}`));
    if (expected.some((binding) => !FAMILY_ID_VERSIONS[binding.familyId])) throw new Error(`Source admission includes a family without an explicit stable ID version: ${source.sourcePath}`);
    const bindings = snapshot.bindings as unknown[];
    if (bindings.length !== expected.length) throw new Error(`Admission binding count mismatch for ${source.sourcePath}`);
    for (const [index, value] of bindings.entries()) {
      const binding = record(value, `Admission binding[${index}]`);
      onlyKeys(binding, ['familyId', 'chainId', 'contract', 'signature', 'abiHash', 'capabilityId', ...(isV3 ? ['executionScope', 'executionScopeHash'] : [])], 'Admission binding');
      requireKeys(binding, ['familyId', 'chainId', 'contract', 'signature', 'abiHash', 'capabilityId'], 'Admission binding');
      if (typeof binding.familyId !== 'string' || typeof binding.chainId !== 'number' || typeof binding.contract !== 'string' || typeof binding.signature !== 'string' || typeof binding.abiHash !== 'string' || typeof binding.capabilityId !== 'string') throw new Error('Admission binding has invalid field types');
      const normalized = { familyId: binding.familyId, chainId: binding.chainId, contract: binding.contract.toLowerCase(), signature: binding.signature, abiHash: binding.abiHash, capabilityId: binding.capabilityId };
      if (!equal(normalized, expected[index])) throw new Error(`Admission binding does not match source ABI in ${source.sourcePath}: ${normalized.capabilityId}`);
      if (isV3) {
        const candidate = source.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => fn.capabilityId === normalized.capabilityId);
        const candidateScope = candidate?.executionScope;
        if (candidateScope && (!binding.executionScope || !equal(binding.executionScope, candidateScope))) throw new Error(`Admission execution scope does not match source binding: ${normalized.capabilityId}`);
        if (binding.executionScope !== undefined) {
          const rawScope = binding.executionScope;
          if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) throw new Error(`Admission execution scope is malformed: ${normalized.capabilityId}`);
          const scope = rawScope as DefiExecutionScope;
          if (typeof binding.executionScopeHash !== 'string' || binding.executionScopeHash !== executionScopeHash(scope)) throw new Error(`Admission execution-scope hash mismatch: ${normalized.capabilityId}`);
          const expectedScopeIndex = candidate?.protocol === 'uniswap-v3-position-manager' && candidate.signature === 'multicall(bytes[])'
            ? 0
            : candidate?.protocol === 'morpho-blue' && candidate.functionName === 'supplyCollateral' ? 3
              : candidate?.protocol === 'morpho-blue' && ['supply', 'repay'].includes(candidate.functionName) ? 4 : undefined;
          if (expectedScopeIndex === undefined || scope.kind !== 'empty-callback-data-v1' && scope.kind !== 'same-target-multicall-v1'
            || (scope.kind === 'empty-callback-data-v1' && scope.bytesArgIndex !== expectedScopeIndex)
            || (scope.kind === 'same-target-multicall-v1' && (expectedScopeIndex !== 0 || candidate?.signature !== 'multicall(bytes[])'))) {
            throw new Error(`Admission execution scope is not defined for this function identity: ${normalized.capabilityId}`);
          }
        } else if (binding.executionScopeHash !== undefined) throw new Error(`Admission has execution-scope hash without scope: ${normalized.capabilityId}`);
        const scopeRequired = candidate?.protocol === 'uniswap-v3-position-manager' && candidate.signature === 'multicall(bytes[])'
          || candidate?.protocol === 'morpho-blue' && ['supply', 'repay', 'supplyCollateral'].includes(candidate.functionName);
        if (scopeRequired && binding.executionScope === undefined) throw new Error(`Missing mandatory execution scope binding: ${normalized.capabilityId}`);
      }
      const key = `${source.sourcePath}:${normalized.capabilityId}`;
      if (admitted.has(key)) throw new Error(`Duplicate source admission binding ${key}`);
      admitted.set(key, { ...normalized, ...(binding.executionScope !== undefined ? { executionScope: binding.executionScope as DefiExecutionScope, executionScopeHash: binding.executionScopeHash as string } : {}) });
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
  const compiled = inputs.map((input) => ({ sourcePath: input.sourcePath, sha256: canonicalSourceSha256(input.document), chains: sourceFamilies(input.document, input.sourcePath) }));
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

import { buildDefiManifestHash, buildReviewedManifest } from '../registry/defi-manifest';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';

export const BASELINE_MANIFEST_HASH = '0x43ec3be0b20a32457719d8edb17c8eaa40c93480921d6e7c86e9c2cacdec5897' as const;

const TOP_KEYS = ['schemaVersion', 'chains'];
const CHAIN_KEYS = ['chainId', 'status', 'contracts'];
const CONTRACT_KEYS = ['address', 'status', 'functions'];
const FUNCTION_KEYS = ['capabilityId', 'type', 'chainId', 'contract', 'functionName', 'signature', 'abi', 'abiHash', 'status', 'provenance', 'policy', 'label', 'description', 'protocol', 'operation', 'warnings', 'inactiveReason'];
const ABI_KEYS = ['type', 'name', 'stateMutability', 'inputs', 'outputs', 'internalType'];
const ABI_PARAM_KEYS = ['name', 'type', 'components', 'internalType', 'indexed'];
const PROVENANCE_KEYS = ['sourceRef', 'verifiedAt', 'status'];
const POLICY_KEYS = ['ref', 'version'];

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
  if (param.indexed !== undefined && typeof param.indexed !== 'boolean') throw new Error(`${label}.indexed must be a boolean`);
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
    });
    const { capabilityId: _id, type: _type, chainId: _chainId, contract: _contract, functionName: _name, signature: oldSignature, abi: oldAbi, abiHash: _hash, status: _status, ...oldMetadata } = oldFn;
    const { capabilityId: _newId, type: _newType, chainId: _newChainId, contract: _newContract, functionName: _newName, signature: newSignature, abi: newAbi, abiHash: _newHash, status: _newStatus, ...newMetadata } = newFn;
    if (!equal(authority(oldFn), authority(newFn))) authorityChanged.push(id);
    if (!equal([oldAbi, oldSignature], [newAbi, newSignature])) abiChanged.push(id);
    if (!equal(oldMetadata, newMetadata)) metadataChanged.push(id);
  }
  return { added, removed, authorityChanged: authorityChanged.sort(), abiChanged: abiChanged.sort(), metadataChanged: metadataChanged.sort() };
}

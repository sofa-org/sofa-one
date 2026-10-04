import { keccak256, stringToHex, toFunctionSelector } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment, ReviewedManifest } from './defi-manifest.types';
import { executionScopeHash, NPM_MULTICALL_CHILD_SIGNATURES } from '../execution/scope';
import { AMBIENT_CHAIN_ID, AMBIENT_SIGNATURE, AMBIENT_TARGET } from '../execution/ambient';

export const DEFI_MANIFEST = Symbol('DEFI_MANIFEST');
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => cmp(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  Object.values(object).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}

export function cloneDefiValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneDefiValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneDefiValue(child)])) as T;
  return value;
}

/** Stable ABI digest: Keccak-256 of recursively key-sorted ABI JSON; arrays retain declared order. */
export function reviewedAbiHash(abi: readonly unknown[]): `0x${string}` {
  return keccak256(stringToHex(canonical(abi))) as `0x${string}`;
}

export function functionAbiHash(fn: Pick<DefiFunctionPolicy, 'abi'>): `0x${string}` {
  return reviewedAbiHash([fn.abi]);
}

function canonicalParamType(param: { type: string; components?: readonly { type: string; components?: readonly unknown[] }[] }): string {
  if (!param.type.startsWith('tuple')) return param.type;
  return `(${(param.components ?? []).map((part) => canonicalParamType(part as never)).join(',')})${param.type.slice(5)}`;
}

function functionIdentity(fn: DefiFunctionPolicy) {
  return {
    capabilityId: fn.capabilityId,
    type: fn.type,
    chainId: fn.chainId,
    contract: fn.contract.toLowerCase(),
    signature: fn.signature,
    abiHash: functionAbiHash(fn),
    status: fn.status,
    ...(fn.executionScope ? { executionScopeHash: executionScopeHash(fn.executionScope) } : {}),
  };
}

export function buildDefiManifestHash(functions: readonly DefiFunctionPolicy[]): `0x${string}` {
  const identity = functions.map(functionIdentity).sort((a, b) => cmp(a.capabilityId, b.capabilityId));
  return keccak256(stringToHex(canonical(identity))) as `0x${string}`;
}

function validateFunction(fn: DefiFunctionPolicy, chain: DefiChainPolicy, contract: DefiChainPolicy['contracts'][number]): void {
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(fn.capabilityId) || (fn.type !== 'contract_call' && fn.type !== 'typed_data_sign')) throw new Error('Invalid DeFi capability identity');
  if (fn.chainId !== chain.chainId || fn.contract.toLowerCase() !== contract.address.toLowerCase()) throw new Error('Inconsistent DeFi catalog hierarchy');
  if (!['active', 'inactive'].includes(fn.status)) throw new Error('Invalid DeFi capability status');
  if (fn.status === 'active' && (chain.status !== 'active' || contract.status !== 'active' || fn.type !== 'contract_call')) throw new Error('Invalid active DeFi capability hierarchy');
  if (!fn.functionName || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fn.functionName) || fn.abi?.type !== 'function' || fn.abi.name !== fn.functionName) throw new Error('Invalid fixed DeFi ABI');
  const abiSignature = `${fn.abi.name}(${fn.abi.inputs.map((input) => canonicalParamType(input as never)).join(',')})`;
  if (abiSignature !== fn.signature || toFunctionSelector(abiSignature) !== toFunctionSelector(fn.signature)) throw new Error('Inconsistent fixed DeFi ABI');
  if (fn.abiHash !== undefined && fn.abiHash !== functionAbiHash(fn)) throw new Error('DeFi ABI identity hash mismatch');
  if (!fn.provenance || typeof fn.provenance.sourceRef !== 'string' || !fn.provenance.sourceRef.trim() || typeof fn.provenance.verifiedAt !== 'string' || !Number.isFinite(Date.parse(fn.provenance.verifiedAt)) || (fn.provenance.status !== 'verified' && fn.provenance.status !== 'candidate')) throw new Error('Invalid DeFi function provenance');
  if (fn.status === 'active' && fn.provenance.status !== 'verified') throw new Error('Active DeFi function requires verified provenance');
  if (fn.policy && (!fn.policy.ref.trim() || fn.policy.ref.length > 120 || !Number.isSafeInteger(fn.policy.version) || fn.policy.version < 1)) throw new Error('Invalid display policy identity');
  if (fn.executionScope) executionScopeHash(fn.executionScope);
  const ambientAddress = chain.chainId === AMBIENT_CHAIN_ID && contract.address.toLowerCase() === AMBIENT_TARGET.toLowerCase();
  const ambientScope = fn.executionScope?.kind === 'ambient-coldpath-v1';
  if (ambientAddress || ambientScope) {
    if (!ambientAddress || fn.signature !== AMBIENT_SIGNATURE || !ambientScope || fn.executionScope.callpathArgIndex !== 0 || fn.executionScope.bytesArgIndex !== 1 || fn.abi.stateMutability !== 'payable' || fn.abi.inputs.length !== 2 || fn.abi.inputs[0].type !== 'uint16' || fn.abi.inputs[1].type !== 'bytes' || fn.abi.outputs.length !== 1 || fn.abi.outputs[0].type !== 'bytes') throw new Error('Invalid Ambient cold-path scope binding');
  }
}

/** Merges nested family catalogs, validates fixed ABI/provenance identities, and freezes the result. */
export function buildReviewedManifest(fragments: readonly DefiRegistryFragment[] = []): ReviewedManifest {
  const chainMap = new Map<number, { chainId: number; status: 'active' | 'inactive'; contracts: Map<string, { address: string; status: 'active' | 'inactive'; functions: DefiFunctionPolicy[] }> }>();
  for (const fragment of fragments) {
    if (!fragment || !Array.isArray(fragment.chains)) throw new Error('Invalid DeFi registry fragment');
    for (const sourceChain of fragment.chains) {
      if (!Number.isSafeInteger(sourceChain.chainId) || sourceChain.chainId <= 0 || !['active', 'inactive'].includes(sourceChain.status)) throw new Error('Invalid DeFi catalog chain');
      let chain = chainMap.get(sourceChain.chainId);
      if (!chain) {
        chain = { chainId: sourceChain.chainId, status: 'inactive', contracts: new Map() };
        chainMap.set(sourceChain.chainId, chain);
      }
      for (const sourceContract of sourceChain.contracts) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(sourceContract.address) || !['active', 'inactive'].includes(sourceContract.status)) throw new Error('Invalid DeFi catalog contract');
        const address = sourceContract.address.toLowerCase();
        let contract = chain.contracts.get(address);
        if (!contract) {
          contract = { address: sourceContract.address, status: 'inactive', functions: [] };
          chain.contracts.set(address, contract);
        }
        for (const sourceFn of sourceContract.functions) {
          const fn = cloneDefiValue(sourceFn);
          validateFunction(fn, sourceChain, sourceContract);
          if (contract.functions.some((other) => other.capabilityId === fn.capabilityId)) throw new Error('Duplicate DeFi capability identity');
          if (contract.functions.some((other) => toFunctionSelector(other.signature).toLowerCase() === toFunctionSelector(fn.signature).toLowerCase())) throw new Error('Ambiguous DeFi selector within contract');
          contract.functions.push(fn);
          if (fn.status === 'active') contract.status = 'active';
        }
        if (sourceContract.status === 'active' && contract.functions.some((fn) => fn.status === 'active')) contract.status = 'active';
      }
      if (chain.status === 'active' && sourceChain.contracts.some((contract: DefiChainPolicy['contracts'][number]) => contract.status === 'active' && contract.functions.some((fn: DefiFunctionPolicy) => fn.status === 'active'))) chain.status = 'active';
    }
  }
  const chains: DefiChainPolicy[] = [...chainMap.values()].sort((a, b) => a.chainId - b.chainId).map((chain) => {
    const contracts = [...chain.contracts.values()].sort((a, b) => cmp(a.address.toLowerCase(), b.address.toLowerCase())).map((contract) => ({
      ...contract,
      functions: contract.functions.sort((a, b) => cmp(a.capabilityId, b.capabilityId)),
    }));
    return { chainId: chain.chainId, status: contracts.some((contract) => contract.status === 'active') ? 'active' : 'inactive', contracts };
  });
  const capabilities = chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const ids = new Set<string>();
  for (const fn of capabilities) {
    if (ids.has(fn.capabilityId)) throw new Error('Duplicate DeFi capability identity');
    ids.add(fn.capabilityId);
  }
  const multicallAllowed = new Set(NPM_MULTICALL_CHILD_SIGNATURES);
  for (const scoped of capabilities.filter((fn) => fn.executionScope)) {
    if (scoped.executionScope?.kind === 'empty-callback-data-v1' && scoped.abi.inputs[scoped.executionScope.bytesArgIndex]?.type !== 'bytes') throw new Error('Invalid DeFi callback-data scope ABI binding');
    if (scoped.executionScope?.kind === 'ambient-coldpath-v1' && (scoped.executionScope.callpathArgIndex !== 0 || scoped.executionScope.bytesArgIndex !== 1)) throw new Error('Invalid Ambient cold-path scope arguments');
  }
  for (const wrapper of capabilities.filter((fn) => fn.executionScope?.kind === 'same-target-multicall-v1')) {
    const scope = wrapper.executionScope;
    if (!scope || scope.kind !== 'same-target-multicall-v1') continue;
    if (wrapper.signature !== 'multicall(bytes[])' || wrapper.abi.inputs.length !== 1 || wrapper.abi.inputs[0].type !== 'bytes[]' || wrapper.abi.outputs?.length !== 1 || wrapper.abi.outputs[0].type !== 'bytes[]' || wrapper.abi.stateMutability !== 'payable') throw new Error('Invalid DeFi multicall wrapper ABI');
    for (const child of scope.allowedChildren) {
      const resolved = capabilities.find((fn) => fn.capabilityId === child.capabilityId);
      if (!resolved || resolved.status !== 'active' || resolved.chainId !== wrapper.chainId || resolved.contract.toLowerCase() !== wrapper.contract.toLowerCase() || resolved.signature !== child.signature || functionAbiHash(resolved) !== child.abiHash.toLowerCase() || !multicallAllowed.has(resolved.signature) || resolved.executionScope) throw new Error('Invalid DeFi execution-scope child binding');
    }
  }
  return deepFreeze(cloneDefiValue({ chains, capabilities, manifestHash: buildDefiManifestHash(capabilities) }));
}

export function reviewedManifestHashValid(manifest: ReviewedManifest): boolean {
  return !!manifest && Array.isArray(manifest.capabilities) && buildDefiManifestHash(manifest.capabilities) === manifest.manifestHash;
}

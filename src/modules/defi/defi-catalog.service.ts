import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isAddress, toFunctionSelector } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { DefiCatalog, DefiChainPolicy, DefiFunctionPolicy, defiPauseScopeKeysForCapability } from './defi.types';

// Product and security review has approved no active deployments.
export const REVIEWED_CATALOG: DefiCatalog = [];
export const DEFI_CATALOG = Symbol('DEFI_CATALOG');

@Injectable()
export class DefiCatalogService {
  private readonly catalog: DefiCatalog;

  constructor(@Inject(DEFI_CATALOG) source: DefiCatalog, private readonly prisma: PrismaService) {
    this.catalog = deepFreeze(cloneCatalog(source));
    validateCatalog(this.catalog);
  }

  async listMetadata(): Promise<{ capabilities: Array<Record<string, unknown>> }> {
    let state;
    try { state = await this.prisma.defiPolicyState.findUnique({ where: { id: 'global' } }); }
    catch { throw unavailable(); }
    if (!state) throw unavailable();
    const paused = new Set(state.pausedScopeKeys);
    const capabilities = this.catalog.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => {
      const active = chain.status === 'active' && contract.status === 'active' && fn.status === 'active' && fn.type === 'contract_call';
      const scopeKeys = defiPauseScopeKeysForCapability(fn);
      return {
        capabilityId: fn.capabilityId,
        type: fn.type,
        chainId: chain.chainId,
        contract: contract.address,
        functionSignature: fn.type === 'contract_call' ? fn.signature : undefined,
        label: fn.capabilityId,
        description: 'Reviewed capability',
        status: active ? (scopeKeys.some((key) => paused.has(key)) ? 'paused' : 'active') : 'inactive',
        policy: fn.policy,
      };
    })));
    return { capabilities };
  }

  chains(): readonly DefiChainPolicy[] { return this.catalog; }
  activeChain(chainId: number): DefiChainPolicy | undefined {
    return this.catalog.find((chain) => chain.chainId === chainId && chain.status === 'active' && chain.contracts.some((contract) => contract.status === 'active' && contract.functions.some((fn) => fn.status === 'active' && fn.type === 'contract_call')));
  }
  functionForCapability(id: string): DefiFunctionPolicy | undefined {
    for (const chain of this.catalog) for (const contract of chain.contracts) for (const fn of contract.functions) if (fn.capabilityId === id) return fn;
    return undefined;
  }
}

function validateCatalog(catalog: DefiCatalog): void {
  const capabilities = new Set<string>();
  const chainIds = new Set<number>();
  for (const chain of catalog) {
    if (!Number.isSafeInteger(chain.chainId) || chain.chainId <= 0 || !validStatus(chain.status)) throw new Error('Invalid DeFi catalog chain');
    if (chainIds.has(chain.chainId)) throw new Error('Duplicate DeFi catalog chain');
    chainIds.add(chain.chainId);
    const addresses = new Set<string>();
    for (const contract of chain.contracts) {
      if (!isAddress(contract.address, { strict: false }) || !validStatus(contract.status)) throw new Error('Invalid DeFi catalog contract');
      const address = contract.address.toLowerCase();
      if (addresses.has(address)) throw new Error('Duplicate DeFi catalog contract');
      addresses.add(address);
      const selectors = new Set<string>();
      for (const fn of contract.functions) {
        if (!/^[A-Za-z0-9:._-]{1,160}$/.test(fn.capabilityId) || capabilities.has(fn.capabilityId)) throw new Error('Duplicate or invalid DeFi capability identity');
        capabilities.add(fn.capabilityId);
        if (fn.chainId !== chain.chainId || fn.contract.toLowerCase() !== contract.address.toLowerCase()) throw new Error('Inconsistent DeFi catalog hierarchy');
        if (!validStatus(fn.status) || (fn.type !== 'contract_call' && fn.type !== 'typed_data_sign')) throw new Error('Invalid DeFi function definition');
        if (fn.status !== 'active') continue;
        if (chain.status !== 'active' || contract.status !== 'active' || fn.type !== 'contract_call') throw new Error('Invalid active DeFi capability hierarchy');
        if (!fn.functionName || !fn.signature || typeof fn.validate !== 'function' || fn.validate.constructor.name === 'AsyncFunction') throw new Error('Invalid active DeFi capability validator');
        if (!fn.policy || !fn.policy.ref.trim() || fn.policy.ref.length > 120 || !Number.isSafeInteger(fn.policy.version) || fn.policy.version < 1) throw new Error('Invalid active DeFi policy identity');
        const abiSig = abiFunctionSignature(fn.abi);
        if (fn.abi.type !== 'function' || fn.abi.name !== fn.functionName || abiSig !== fn.signature || toFunctionSelector(abiSig) !== toFunctionSelector(fn.signature)) throw new Error('Inconsistent fixed DeFi ABI definition');
        const selector = toFunctionSelector(fn.signature).toLowerCase();
        if (selectors.has(selector)) throw new Error('Ambiguous DeFi selector within contract');
        selectors.add(selector);
      }
    }
  }
}

function validStatus(status: unknown): status is 'active' | 'inactive' { return status === 'active' || status === 'inactive'; }

function abiFunctionSignature(fn: DefiFunctionPolicy['abi']): string {
  return `${fn.name}(${fn.inputs.map((input) => canonicalParamType(input)).join(',')})`;
}

function canonicalParamType(param: { type: string; components?: readonly { type: string; components?: readonly unknown[] }[] }): string {
  if (!param.type.startsWith('tuple')) return param.type;
  const suffix = param.type.slice('tuple'.length);
  return `(${(param.components ?? []).map((item) => canonicalParamType(item as never)).join(',')})${suffix}`;
}

function cloneCatalog(catalog: DefiCatalog): DefiChainPolicy[] {
  return catalog.map((chain) => ({ ...chain, contracts: chain.contracts.map((contract) => ({ ...contract, functions: contract.functions.map((fn) => ({ ...fn, abi: cloneValue(fn.abi), policy: { ...fn.policy } })) })) }));
}
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function unavailable(): ServiceUnavailableException { return new ServiceUnavailableException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy is unavailable' }); }

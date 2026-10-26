import { keccak256, stringToHex } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { UNISWAP_DEPLOYMENTS, UNISWAP_ROUTER_ABI, UNISWAP_V4_POSITION_ABI } from './uniswap-deployments';

export type UniswapScopeKind = 'uniswap-universal-router-2.1.2-v1' | 'uniswap-v4-position-manager-v1';

export function uniswapIdentityKind(fn: Pick<DefiFunctionPolicy, 'chainId' | 'contract'>): UniswapScopeKind | undefined {
  const deployment = UNISWAP_DEPLOYMENTS[fn.chainId];
  if (deployment?.router === fn.contract.toLowerCase()) return 'uniswap-universal-router-2.1.2-v1';
  if (deployment?.positionManager === fn.contract.toLowerCase()) return 'uniswap-v4-position-manager-v1';
  return undefined;
}

/** The reviewed entrypoints may never fall through to outer-ABI-only authorization. */
export function validateUniswapBinding(fn: DefiFunctionPolicy): void {
  const identity = uniswapIdentityKind(fn);
  const kind = fn.executionScope?.kind;
  if (!identity && kind !== 'uniswap-universal-router-2.1.2-v1' && kind !== 'uniswap-v4-position-manager-v1') return;
  const abi = identity === 'uniswap-universal-router-2.1.2-v1' ? UNISWAP_ROUTER_ABI : UNISWAP_V4_POSITION_ABI;
  const signature = identity === 'uniswap-universal-router-2.1.2-v1' ? 'execute(bytes,bytes[],uint256)' : 'modifyLiquidities(bytes,uint256)';
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
    return JSON.stringify(value);
  };
  if (!identity || kind !== identity || fn.type !== 'contract_call' || fn.signature !== signature || fn.functionName !== abi.name
    || keccak256(stringToHex(canonical(fn.abi))) !== keccak256(stringToHex(canonical(abi)))) throw new TypeError('Invalid Uniswap deployment/ABI/mandatory scope binding');
}

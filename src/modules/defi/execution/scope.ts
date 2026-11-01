import { keccak256, stringToHex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES } from './enso-identity';

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const NPM_MULTICALL_CHILD_SIGNATURES = Object.freeze([
  'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
  'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))',
  'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  'collect((uint256,address,uint128,uint128))', 'burn(uint256)', 'refundETH()',
  'unwrapWETH9(uint256,address)', 'sweepToken(address,uint256,address)',
]);

export const ROUTER_MULTICALL_CHILD_SIGNATURES: readonly string[] = Object.freeze([
  'exactInput((bytes,address,uint256,uint256))',
  'exactInput((bytes,address,uint256,uint256,uint256))',
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'exactOutput((bytes,address,uint256,uint256))',
  'exactOutput((bytes,address,uint256,uint256,uint256))',
  'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'increaseLiquidity((address,address,uint256,uint256,uint256))',
  'mint((address,address,uint24,int24,int24,uint256,uint256,address))',
  'pull(address,uint256)',
  'refundETH()',
  'swapExactTokensForTokens(uint256,uint256,address[],address)',
  'swapTokensForExactTokens(uint256,uint256,address[],address)',
  'sweepToken(address,uint256)',
  'sweepToken(address,uint256,address)',
  'sweepTokenWithFee(address,uint256,address,uint256,address)',
  'sweepTokenWithFee(address,uint256,uint256,address)',
  'unwrapWETH9(uint256)',
  'unwrapWETH9(uint256,address)',
  'unwrapWETH9WithFee(uint256,address,uint256,address)',
  'unwrapWETH9WithFee(uint256,uint256,address)',
  'wrapETH(uint256)',
]);

/** Exact self-delegatecall root shapes; overload metadata is not caller-selectable. */
export function isRouterMulticallBinding(fn: DefiFunctionPolicy): boolean {
  const scope = fn.executionScope;
  if (scope?.kind !== 'same-target-router-multicall-v1' || fn.type !== 'contract_call'
    || fn.functionName !== 'multicall' || fn.abi.type !== 'function' || fn.abi.name !== 'multicall'
    || fn.abi.stateMutability !== 'payable' || fn.abi.outputs?.length !== 1 || fn.abi.outputs[0].type !== 'bytes[]') return false;
  if (fn.signature === 'multicall(bytes[])') return scope.bytesArrayArgIndex === 0 && fn.abi.inputs.length === 1 && fn.abi.inputs[0].type === 'bytes[]';
  const prefix = fn.signature === 'multicall(uint256,bytes[])' ? 'uint256' : fn.signature === 'multicall(bytes32,bytes[])' ? 'bytes32' : undefined;
  return prefix !== undefined && scope.bytesArrayArgIndex === 1 && fn.abi.inputs.length === 2 && fn.abi.inputs[0].type === prefix && fn.abi.inputs[1].type === 'bytes[]';
}

/** Canonical semantic identity for the finite execution language. */
export function executionScopeHash(scope: DefiExecutionScope): `0x${string}` {
  if (!scope || typeof scope !== 'object') throw new TypeError('Invalid DeFi execution scope');
  let normalized: unknown;
  if (scope.kind === 'empty-callback-data-v1') {
    if (Object.keys(scope).sort().join(',') !== 'bytesArgIndex,kind' || !Number.isSafeInteger(scope.bytesArgIndex) || scope.bytesArgIndex < 0) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, bytesArgIndex: scope.bytesArgIndex };
  } else if (scope.kind === 'ambient-coldpath-v1') {
    if (Object.keys(scope).sort().join(',') !== 'bytesArgIndex,callpathArgIndex,kind' || scope.callpathArgIndex !== 0 || scope.bytesArgIndex !== 1) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, callpathArgIndex: 0, bytesArgIndex: 1 };
  } else if (scope.kind === 'same-target-multicall-v1' || scope.kind === 'same-target-router-multicall-v1') {
    const router = scope.kind === 'same-target-router-multicall-v1';
    if (Object.keys(scope).sort().join(',') !== 'allowedChildren,bytesArrayArgIndex,kind' || (router ? scope.bytesArrayArgIndex !== 0 && scope.bytesArrayArgIndex !== 1 : scope.bytesArrayArgIndex !== 0) || !Array.isArray(scope.allowedChildren)) throw new TypeError('Invalid DeFi execution scope');
    const children = scope.allowedChildren.map((child) => {
      if (!child || Object.keys(child).sort().join(',') !== 'abiHash,capabilityId,signature' || typeof child.capabilityId !== 'string' || !child.capabilityId || typeof child.signature !== 'string' || typeof child.abiHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(child.abiHash)) throw new TypeError('Invalid DeFi execution scope');
      return { capabilityId: child.capabilityId, signature: child.signature, abiHash: child.abiHash.toLowerCase() };
    }).sort((a, b) => cmp(a.capabilityId, b.capabilityId) || cmp(a.signature, b.signature) || cmp(a.abiHash, b.abiHash));
    if (new Set(children.map((child) => child.capabilityId)).size !== children.length || new Set(children.map((child) => child.signature)).size !== children.length) throw new TypeError('Invalid DeFi execution scope');
    if (router) {
      if (children.some((child) => !ROUTER_MULTICALL_CHILD_SIGNATURES.includes(child.signature))
        || !children.some((child) => /^(?:exactInput|exactInputSingle|exactOutput|exactOutputSingle|swapExactTokensForTokens|swapTokensForExactTokens)\(/.test(child.signature))) throw new TypeError('Invalid DeFi execution scope');
    } else if (children.length !== NPM_MULTICALL_CHILD_SIGNATURES.length || NPM_MULTICALL_CHILD_SIGNATURES.some((signature) => !children.some((child) => child.signature === signature))) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, bytesArrayArgIndex: scope.bytesArrayArgIndex, allowedChildren: children };
  } else if (scope.kind === 'enso-static-weiroll-v1') {
    if (Object.keys(scope).sort().join(',') !== 'allowedChildren,kind' || !Array.isArray(scope.allowedChildren)) throw new TypeError('Invalid DeFi execution scope');
    const children = scope.allowedChildren.map((child) => {
      if (!child || Object.keys(child).sort().join(',') !== 'abiHash,capabilityId,chainId,contract,signature'
        || !Number.isSafeInteger(child.chainId) || child.chainId <= 0
        || typeof child.contract !== 'string' || !/^0x[0-9a-f]{40}$/i.test(child.contract)
        || typeof child.capabilityId !== 'string' || !child.capabilityId
        || typeof child.signature !== 'string' || !child.signature
        || typeof child.abiHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(child.abiHash)) throw new TypeError('Invalid DeFi execution scope');
      const literal = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.find((identity) => identity.capabilityId === child.capabilityId);
      if (!literal || child.chainId !== literal.chainId || child.contract.toLowerCase() !== literal.contract || child.signature !== literal.signature || child.abiHash.toLowerCase() !== literal.abiHash) throw new TypeError('Invalid DeFi execution scope');
      return { chainId: child.chainId, contract: child.contract.toLowerCase(), capabilityId: child.capabilityId, signature: child.signature, abiHash: child.abiHash.toLowerCase() };
    }).sort((a, b) => cmp(a.capabilityId, b.capabilityId));
    if (children.length !== ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.length || new Set(children.map((child) => child.capabilityId)).size !== children.length) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, allowedChildren: children };
  } else if (scope.kind === 'uniswap-universal-router-2.1.2-v1' || scope.kind === 'uniswap-v4-position-manager-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid Uniswap execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'polymarket-pusd-wrap-v1') {
    if (Object.keys(scope).sort().join(',') !== 'asset,kind,recipientPolicy' || scope.asset !== '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' || scope.recipientPolicy !== 'withdrawal-allowlist-v1') throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, asset: scope.asset, recipientPolicy: scope.recipientPolicy };
  } else throw new TypeError('Invalid DeFi execution scope');
  return keccak256(stringToHex(JSON.stringify(normalized)));
}

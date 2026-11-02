import { keccak256, stringToHex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy, FiniteMulticallScope, FinancialMulticallChildBinding } from '../defi.types';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES } from './enso-identity';
import { FINANCIAL_MULTICALL_CHILD_SIGNATURES, PENDLE_MULTICALL_CHILD_SIGNATURES } from './financial-multicall-signatures';

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

export function isFiniteMulticallScope(scope: DefiExecutionScope | undefined): scope is FiniteMulticallScope {
  return scope?.kind === 'same-target-financial-multicall-v1' || scope?.kind === 'pendle-router-multicall-v1' || scope?.kind === 'uniswap-v4-position-manager-multicall-v1';
}

/** Only the three exact source-reviewed root ABIs, never caller-supplied selector rules. */
export function isFiniteMulticallBinding(fn: DefiFunctionPolicy): boolean {
  const scope = fn.executionScope;
  if (!isFiniteMulticallScope(scope) || fn.type !== 'contract_call' || fn.functionName !== 'multicall' || fn.abi.type !== 'function' || fn.abi.name !== 'multicall' || fn.abi.inputs.length !== 1) return false;
  if (scope.kind === 'pendle-router-multicall-v1') {
    const tuple = (param: typeof fn.abi.inputs[number], first: string): boolean => param.type === 'tuple[]' && 'components' in param
      && param.components.length === 2 && param.components[0].type === first && param.components[1].type === 'bytes';
    return fn.signature === 'multicall((bool,bytes)[])' && fn.abi.stateMutability === 'payable'
      && tuple(fn.abi.inputs[0], 'bool') && fn.abi.outputs.length === 1 && tuple(fn.abi.outputs[0], 'bool');
  }
  if (fn.signature !== 'multicall(bytes[])' || fn.abi.inputs[0].type !== 'bytes[]') return false;
  const returnsBytes = fn.abi.outputs.length === 1 && fn.abi.outputs[0].type === 'bytes[]';
  return scope.kind === 'same-target-financial-multicall-v1'
    ? scope.bytesArrayArgIndex === 0 && (fn.abi.stateMutability === 'payable' || fn.abi.stateMutability === 'nonpayable') && (fn.abi.outputs.length === 0 || returnsBytes)
    : fn.abi.stateMutability === 'payable' && returnsBytes;
}

/** These payload grammars belong only to the independently bound adapter deployments. */
export function isFinancialAdapterBinding(fn: DefiFunctionPolicy): boolean {
  const scope = fn.executionScope;
  if ((scope?.kind !== 'morpho-market-adapter-v1' && scope?.kind !== 'maple-adapter-exit-v1') || fn.type !== 'contract_call' || fn.abi.stateMutability !== 'nonpayable') return false;
  const contract = fn.contract.toLowerCase();
  const expected = scope.kind === 'morpho-market-adapter-v1'
    ? fn.chainId === 1 && contract === '0x04422053addbc9bb2759b248b574e3fca76bc145' ? '0x7ca32dcd9269b0beb21a4f364ded5cffcb7b3635'
      : fn.chainId === 8453 && contract === '0x050ce30b927da55177a4914ec73480238bad56f0' ? '0x2fecd40f436ca170d2478a58da898fce93988eef' : undefined
    : fn.chainId === 1 && contract === '0xa5cdee01aa7a5e0620df5f27f26e552fdf7f5f20' ? '0x896d345123642d85750291625ea89c65648e4e0c' : undefined;
  if (!expected || scope.adapter.toLowerCase() !== expected) return false;
  if (scope.kind === 'morpho-market-adapter-v1') return fn.signature === 'forceDeallocate(address,bytes,uint256,address)'
    ? fn.abi.outputs.length === 1 && fn.abi.outputs[0].type === 'uint256'
    : (fn.signature === 'allocate(address,bytes,uint256)' || fn.signature === 'deallocate(address,bytes,uint256)') && fn.abi.outputs.length === 0;
  return (fn.signature === 'deallocate(address,bytes,uint256)' || fn.signature === 'deallocateAsync(address,bytes,uint256)') && fn.abi.outputs.length === 0;
}

/** Hash arguments come from the actual resolved child, not its advertised descriptor. */
export function isFiniteMulticallChildBinding(scope: FiniteMulticallScope, wrapper: DefiFunctionPolicy, child: DefiFunctionPolicy, abiHash: `0x${string}`): boolean {
  if (child.status !== 'active' || child.type !== 'contract_call' || child.provenance.status !== 'verified'
    || child.chainId !== wrapper.chainId || child.contract.toLowerCase() !== wrapper.contract.toLowerCase()) return false;
  const binding: FinancialMulticallChildBinding | undefined = scope.allowedChildren.find((entry) => entry.capabilityId === child.capabilityId && entry.signature === child.signature && entry.abiHash.toLowerCase() === abiHash);
  if (!binding) return false;
  if (scope.kind === 'uniswap-v4-position-manager-multicall-v1') return child.signature === 'modifyLiquidities(bytes,uint256)'
    && child.executionScope?.kind === 'uniswap-v4-position-manager-v1' && binding.executionScopeHash?.toLowerCase() === executionScopeHash(child.executionScope);
  if (!(scope.kind === 'pendle-router-multicall-v1' ? PENDLE_MULTICALL_CHILD_SIGNATURES : FINANCIAL_MULTICALL_CHILD_SIGNATURES).includes(child.signature)) return false;
  if (scope.kind === 'pendle-router-multicall-v1' && child.abi.stateMutability !== 'nonpayable') return false;
  const emptyIndex = child.signature === 'safeTransferFrom(address,address,uint256,bytes)' || child.signature === 'take(address,uint256,address,bytes)' ? 3
    : child.signature === 'remove(uint256,address,bytes)' ? 2
      : child.signature === 'createAndInitializePoolIfNecessary(address,address,address,uint160,bytes)' ? 4 : undefined;
  if (emptyIndex !== undefined && (child.executionScope?.kind !== 'empty-callback-data-v1' || child.executionScope.bytesArgIndex !== emptyIndex)) return false;
  if (child.signature === 'liquidate((uint256,uint256,uint256,address,bytes,uint256))'
    && (child.executionScope?.kind !== 'empty-tuple-bytes-v1' || child.executionScope.tupleArgIndex !== 0 || child.executionScope.bytesComponentIndex !== 4)) return false;
  if ((child.signature === 'forceDeallocate(address,bytes,uint256,address)' || child.signature === 'allocate(address,bytes,uint256)') && child.executionScope?.kind !== 'morpho-market-adapter-v1') return false;
  if (child.signature === 'deallocate(address,bytes,uint256)' && child.executionScope?.kind !== 'morpho-market-adapter-v1' && child.executionScope?.kind !== 'maple-adapter-exit-v1') return false;
  if (child.signature === 'deallocateAsync(address,bytes,uint256)' && child.executionScope?.kind !== 'maple-adapter-exit-v1') return false;
  if (!child.executionScope) return binding.executionScopeHash === undefined;
  if (scope.kind !== 'same-target-financial-multicall-v1' || binding.executionScopeHash?.toLowerCase() !== executionScopeHash(child.executionScope)) return false;
  if (child.executionScope.kind === 'empty-callback-data-v1') return child.abi.inputs[child.executionScope.bytesArgIndex]?.type === 'bytes';
  if (child.executionScope.kind === 'empty-tuple-bytes-v1') {
    const tuple = child.abi.inputs[child.executionScope.tupleArgIndex];
    return tuple?.type === 'tuple' && 'components' in tuple && tuple.components[child.executionScope.bytesComponentIndex]?.type === 'bytes';
  }
  return isFinancialAdapterBinding(child);
}

/** Canonical semantic identity for the finite execution language. */
export function executionScopeHash(scope: DefiExecutionScope): `0x${string}` {
  if (!scope || typeof scope !== 'object') throw new TypeError('Invalid DeFi execution scope');
  let normalized: unknown;
  if (scope.kind === 'empty-callback-data-v1') {
    if (Object.keys(scope).sort().join(',') !== 'bytesArgIndex,kind' || !Number.isSafeInteger(scope.bytesArgIndex) || scope.bytesArgIndex < 0) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, bytesArgIndex: scope.bytesArgIndex };
  } else if (scope.kind === 'empty-tuple-bytes-v1') {
    if (Object.keys(scope).sort().join(',') !== 'bytesComponentIndex,kind,tupleArgIndex'
      || !Number.isSafeInteger(scope.tupleArgIndex) || scope.tupleArgIndex < 0
      || !Number.isSafeInteger(scope.bytesComponentIndex) || scope.bytesComponentIndex < 0) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, tupleArgIndex: scope.tupleArgIndex, bytesComponentIndex: scope.bytesComponentIndex };
  } else if (scope.kind === 'morpho-market-adapter-v1' || scope.kind === 'maple-adapter-exit-v1') {
    if (Object.keys(scope).sort().join(',') !== 'adapter,kind' || typeof scope.adapter !== 'string' || !/^0x[0-9a-f]{40}$/i.test(scope.adapter)) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, adapter: scope.adapter.toLowerCase() };
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
  } else if (isFiniteMulticallScope(scope)) {
    const financial = scope.kind === 'same-target-financial-multicall-v1';
    const v4 = scope.kind === 'uniswap-v4-position-manager-multicall-v1';
    if (Object.keys(scope).sort().join(',') !== (financial ? 'allowedChildren,bytesArrayArgIndex,kind,nativeValuePolicy' : 'allowedChildren,kind')
      || !Array.isArray(scope.allowedChildren) || scope.allowedChildren.length === 0
      || financial && (scope.bytesArrayArgIndex !== 0 || scope.nativeValuePolicy !== 'inherit' && scope.nativeValuePolicy !== 'zero')) throw new TypeError('Invalid DeFi execution scope');
    const children = scope.allowedChildren.map((child: FinancialMulticallChildBinding) => {
      const scoped = child?.executionScopeHash !== undefined;
      if (!child || Object.keys(child).sort().join(',') !== (scoped ? 'abiHash,capabilityId,executionScopeHash,signature' : 'abiHash,capabilityId,signature')
        || typeof child.capabilityId !== 'string' || !child.capabilityId || typeof child.signature !== 'string'
        || typeof child.abiHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(child.abiHash)
        || scoped && (typeof child.executionScopeHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(child.executionScopeHash))
        || v4 && (!scoped || child.signature !== 'modifyLiquidities(bytes,uint256)')
        || !v4 && (!(financial ? FINANCIAL_MULTICALL_CHILD_SIGNATURES : PENDLE_MULTICALL_CHILD_SIGNATURES).includes(child.signature) || !financial && scoped)) throw new TypeError('Invalid DeFi execution scope');
      return { capabilityId: child.capabilityId, signature: child.signature, abiHash: child.abiHash.toLowerCase(), ...(scoped ? { executionScopeHash: child.executionScopeHash!.toLowerCase() } : {}) };
    }).sort((a, b) => cmp(a.capabilityId, b.capabilityId) || cmp(a.signature, b.signature));
    if (new Set(children.map((child) => child.capabilityId)).size !== children.length || new Set(children.map((child) => child.signature)).size !== children.length || v4 && children.length !== 1) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, ...(financial ? { bytesArrayArgIndex: 0, nativeValuePolicy: scope.nativeValuePolicy } : {}), allowedChildren: children };
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
  } else if (scope.kind === 'merkl-empty-claim-data-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid Merkl execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'zero-ex-nft-settlement-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid 0x NFT execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'umami-zero-request-callback-v1' || scope.kind === 'flexa-preauthorized-stake-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid financial request/stake execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'velora-empty-permit-settlement-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid Velora execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'revert-empty-lending-permit-v1' || scope.kind === 'napier-zero-deadline-collect-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid lender/collector execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'uniswap-universal-router-2.1.2-v1' || scope.kind === 'uniswap-v4-position-manager-v1' || scope.kind === 'uniswap-v4-position-manager-primitive-v1') {
    if (Object.keys(scope).join(',') !== 'kind') throw new TypeError('Invalid Uniswap execution scope');
    normalized = { kind: scope.kind };
  } else if (scope.kind === 'polymarket-pusd-wrap-v1') {
    if (Object.keys(scope).sort().join(',') !== 'asset,kind,recipientPolicy' || scope.asset !== '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' || scope.recipientPolicy !== 'withdrawal-allowlist-v1') throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, asset: scope.asset, recipientPolicy: scope.recipientPolicy };
  } else throw new TypeError('Invalid DeFi execution scope');
  return keccak256(stringToHex(JSON.stringify(normalized)));
}

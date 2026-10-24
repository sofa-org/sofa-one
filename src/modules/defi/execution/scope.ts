import { keccak256, stringToHex } from 'viem';
import type { DefiExecutionScope } from '../defi.types';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES } from './enso-identity';

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const NPM_MULTICALL_CHILD_SIGNATURES = Object.freeze([
  'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
  'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))',
  'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  'collect((uint256,address,uint128,uint128))', 'burn(uint256)', 'refundETH()',
  'unwrapWETH9(uint256,address)', 'sweepToken(address,uint256,address)',
]);

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
  } else if (scope.kind === 'same-target-multicall-v1') {
    if (Object.keys(scope).sort().join(',') !== 'allowedChildren,bytesArrayArgIndex,kind' || scope.bytesArrayArgIndex !== 0 || !Array.isArray(scope.allowedChildren)) throw new TypeError('Invalid DeFi execution scope');
    const children = scope.allowedChildren.map((child) => {
      if (!child || Object.keys(child).sort().join(',') !== 'abiHash,capabilityId,signature' || typeof child.capabilityId !== 'string' || !child.capabilityId || typeof child.signature !== 'string' || !/^0x[0-9a-f]{64}$/i.test(child.abiHash)) throw new TypeError('Invalid DeFi execution scope');
      return { capabilityId: child.capabilityId, signature: child.signature, abiHash: child.abiHash.toLowerCase() };
    }).sort((a, b) => cmp(a.capabilityId, b.capabilityId) || cmp(a.signature, b.signature) || cmp(a.abiHash, b.abiHash));
    if (children.length !== NPM_MULTICALL_CHILD_SIGNATURES.length || new Set(children.map((child) => child.capabilityId)).size !== children.length || new Set(children.map((child) => child.signature)).size !== children.length || NPM_MULTICALL_CHILD_SIGNATURES.some((signature) => !children.some((child) => child.signature === signature))) throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, bytesArrayArgIndex: 0, allowedChildren: children };
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
  } else if (scope.kind === 'polymarket-pusd-wrap-v1') {
    if (Object.keys(scope).sort().join(',') !== 'asset,kind,recipientPolicy' || scope.asset !== '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' || scope.recipientPolicy !== 'withdrawal-allowlist-v1') throw new TypeError('Invalid DeFi execution scope');
    normalized = { kind: scope.kind, asset: scope.asset, recipientPolicy: scope.recipientPolicy };
  } else throw new TypeError('Invalid DeFi execution scope');
  return keccak256(stringToHex(JSON.stringify(normalized)));
}

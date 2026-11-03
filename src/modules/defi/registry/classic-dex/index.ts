import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const provenance = 'docs/defi-research/expansion-dex-provenance.md (official deployment manifests and IRouter interfaces; snapshot 2026-10-03)';
const routers = [
  { chainId: 8453, protocol: 'aerodrome', address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' },
  { chainId: 10, protocol: 'velodrome', address: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858' },
] as const;
const route = { name: 'routes', type: 'tuple[]', components: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'stable', type: 'bool' }, { name: 'factory', type: 'address' },
] } as const;
const specs: readonly { name: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; operation: string }[] = [
  { name: 'swapExactTokensForTokens', mutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, route, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], operation: 'swap-exact-tokens-for-tokens' },
  { name: 'swapExactETHForTokens', mutability: 'payable', inputs: [{ name: 'amountOutMin', type: 'uint256' }, route, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], operation: 'swap-exact-eth-for-tokens' },
  { name: 'swapExactTokensForETH', mutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, route, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }], operation: 'swap-exact-tokens-for-eth' },
  { name: 'addLiquidity', mutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'stable', type: 'bool' }, { name: 'amountADesired', type: 'uint256' }, { name: 'amountBDesired', type: 'uint256' }, { name: 'amountAMin', type: 'uint256' }, { name: 'amountBMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }], operation: 'add-liquidity' },
  { name: 'addLiquidityETH', mutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'stable', type: 'bool' }, { name: 'amountTokenDesired', type: 'uint256' }, { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountETHMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }], operation: 'add-liquidity-eth' },
  { name: 'removeLiquidity', mutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'stable', type: 'bool' }, { name: 'liquidity', type: 'uint256' }, { name: 'amountAMin', type: 'uint256' }, { name: 'amountBMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }], operation: 'remove-liquidity' },
  { name: 'removeLiquidityETH', mutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'stable', type: 'bool' }, { name: 'liquidity', type: 'uint256' }, { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountETHMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }], operation: 'remove-liquidity-eth' },
];

const functions: DefiFunctionPolicy[] = routers.flatMap((router) => specs.map((spec) => {
  const signature = `${spec.name}(${spec.inputs.map((input) => input.type === 'tuple[]' ? '(address,address,bool,address)[]' : input.type).join(',')})`;
  return {
    capabilityId: `${router.protocol}:classic:${router.chainId}:${router.address.toLowerCase()}:${spec.operation}`,
    type: 'contract_call' as const, chainId: router.chainId, contract: router.address,
    functionName: spec.name, signature,
    abi: { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] },
    status: 'active' as const,
    provenance: { sourceRef: provenance, verifiedAt: '2026-10-03', status: 'verified' as const },
    protocol: router.protocol, operation: spec.operation, label: `${router.protocol} Classic ${spec.name}`,
    warnings: ['Caller controls assets, factory, amounts, recipient, minimums, deadline and payable native value.'],
  };
}));

const chains: DefiChainPolicy[] = routers.map((router) => ({ chainId: router.chainId, status: 'active', contracts: [{
  address: router.address, status: 'active', functions: functions.filter((fn) => fn.chainId === router.chainId),
}] }));

export function buildClassicDexRegistry(): DefiRegistryFragment { return { chains }; }

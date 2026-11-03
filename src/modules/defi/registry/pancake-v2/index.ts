import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 56;
const router = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const sourceRef = 'docs/defi-research/expansion-dex-provenance.md (official PancakeSwap documentation deployment link and periphery interfaces at commit d769a6d136b74fde82502ec2f9334acc1afc0732; snapshot 2026-10-03)';

type Spec = { name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs'] };
const path = { name: 'path', type: 'address' } as const;
const addressTo = { name: 'to', type: 'address' } as const;
const deadline = { name: 'deadline', type: 'uint256' } as const;
const amounts = [{ name: 'amounts', type: 'uint256[]' }] as const;
const liquidityOutputs = [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }] as const;
const specs: readonly Spec[] = [
  { name: 'swapExactTokensForTokens', operation: 'swap-exact-tokens-for-tokens', mutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { ...path, type: 'address[]' }, addressTo, deadline], outputs: amounts },
  { name: 'swapTokensForExactTokens', operation: 'swap-tokens-for-exact-tokens', mutability: 'nonpayable', inputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'amountInMax', type: 'uint256' }, { ...path, type: 'address[]' }, addressTo, deadline], outputs: amounts },
  { name: 'swapExactETHForTokens', operation: 'swap-exact-eth-for-tokens', mutability: 'payable', inputs: [{ name: 'amountOutMin', type: 'uint256' }, { ...path, type: 'address[]' }, addressTo, deadline], outputs: amounts },
  { name: 'swapTokensForExactETH', operation: 'swap-tokens-for-exact-eth', mutability: 'nonpayable', inputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'amountInMax', type: 'uint256' }, { ...path, type: 'address[]' }, addressTo, deadline], outputs: amounts },
  { name: 'swapExactTokensForETH', operation: 'swap-exact-tokens-for-eth', mutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { ...path, type: 'address[]' }, addressTo, deadline], outputs: amounts },
  { name: 'swapETHForExactTokens', operation: 'swap-eth-for-exact-tokens', mutability: 'payable', inputs: [{ name: 'amountOut', type: 'uint256' }, { ...path, type: 'address[]' }, addressTo, deadline], outputs: amounts },
  { name: 'addLiquidity', operation: 'add-liquidity', mutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, ...['amountADesired', 'amountBDesired', 'amountAMin', 'amountBMin'].map((name) => ({ name, type: 'uint256' as const })), addressTo, deadline], outputs: liquidityOutputs },
  { name: 'addLiquidityETH', operation: 'add-liquidity-eth', mutability: 'payable', inputs: [{ name: 'token', type: 'address' }, ...['amountTokenDesired', 'amountTokenMin', 'amountETHMin'].map((name) => ({ name, type: 'uint256' as const })), addressTo, deadline], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }] },
  { name: 'removeLiquidity', operation: 'remove-liquidity', mutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, ...['liquidity', 'amountAMin', 'amountBMin'].map((name) => ({ name, type: 'uint256' as const })), addressTo, deadline], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }] },
  { name: 'removeLiquidityETH', operation: 'remove-liquidity-eth', mutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, ...['liquidity', 'amountTokenMin', 'amountETHMin'].map((name) => ({ name, type: 'uint256' as const })), addressTo, deadline], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }] },
];

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
  const signature = `${spec.name}(${spec.inputs.map((input) => input.type).join(',')})`;
  return {
    capabilityId: `pancakeswap-v2:v2:${chainId}:${router.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: router, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-03', status: 'verified' },
    protocol: 'pancakeswap-v2', operation: spec.operation, label: `PancakeSwap V2 ${spec.name}`,
    warnings: ['Caller controls assets, path, amounts, recipient, minimums, deadline and payable native value.'],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] }];

export function buildPancakeV2Registry(): DefiRegistryFragment { return { chains }; }

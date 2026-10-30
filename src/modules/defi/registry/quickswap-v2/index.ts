import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';
const chainId = 137;
const router = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
const sourceRef = 'docs/defi-research/expansion55-quickswap-v5.md (official deployment documentation and QuickSwap-periphery interfaces at commit 522a94168b0814d0776d834119df377f03898807; snapshot 2026-10-04)';
type Spec = { name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs'] };
const path = { name: 'path', type: 'address[]' } as const;
const to = { name: 'to', type: 'address' } as const;
const deadline = { name: 'deadline', type: 'uint256' } as const;
const amounts = [{ name: 'amounts', type: 'uint256[]' }] as const;
const specs: readonly Spec[] = [
 { name: 'swapExactTokensForTokens', operation: 'swap-exact-tokens-for-tokens', mutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, path, to, deadline], outputs: amounts },
 { name: 'swapTokensForExactTokens', operation: 'swap-tokens-for-exact-tokens', mutability: 'nonpayable', inputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'amountInMax', type: 'uint256' }, path, to, deadline], outputs: amounts },
 { name: 'swapExactETHForTokens', operation: 'swap-exact-eth-for-tokens', mutability: 'payable', inputs: [{ name: 'amountOutMin', type: 'uint256' }, path, to, deadline], outputs: amounts },
 { name: 'swapTokensForExactETH', operation: 'swap-tokens-for-exact-eth', mutability: 'nonpayable', inputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'amountInMax', type: 'uint256' }, path, to, deadline], outputs: amounts },
 { name: 'swapExactTokensForETH', operation: 'swap-exact-tokens-for-eth', mutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, path, to, deadline], outputs: amounts },
 { name: 'swapETHForExactTokens', operation: 'swap-eth-for-exact-tokens', mutability: 'payable', inputs: [{ name: 'amountOut', type: 'uint256' }, path, to, deadline], outputs: amounts },
 { name: 'addLiquidity', operation: 'add-liquidity', mutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, ...['amountADesired', 'amountBDesired', 'amountAMin', 'amountBMin'].map((name) => ({ name, type: 'uint256' as const })), to, deadline], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }] },
 { name: 'addLiquidityETH', operation: 'add-liquidity-eth', mutability: 'payable', inputs: [{ name: 'token', type: 'address' }, ...['amountTokenDesired', 'amountTokenMin', 'amountETHMin'].map((name) => ({ name, type: 'uint256' as const })), to, deadline], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }] },
 { name: 'removeLiquidity', operation: 'remove-liquidity', mutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, ...['liquidity', 'amountAMin', 'amountBMin'].map((name) => ({ name, type: 'uint256' as const })), to, deadline], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }] },
 { name: 'removeLiquidityETH', operation: 'remove-liquidity-eth', mutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, ...['liquidity', 'amountTokenMin', 'amountETHMin'].map((name) => ({ name, type: 'uint256' as const })), to, deadline], outputs: [{ name: 'amountToken', type: 'uint256' }, { name: 'amountETH', type: 'uint256' }] },
];
const functions: DefiFunctionPolicy[] = specs.map((spec) => {
 const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
 const signature = `${spec.name}(${spec.inputs.map((input) => input.type).join(',')})`;
 return { capabilityId: `quickswap-v2:v2:${chainId}:${router.toLowerCase()}:${spec.operation}`, type: 'contract_call', chainId, contract: router, functionName: spec.name, signature, abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'QuickSwap V2', operation: spec.operation, label: `QuickSwap V2 ${spec.name}`, warnings: ['Caller chooses assets, path, amounts, minimums, recipient, deadline, and payable native value; none are financially constrained here.', 'Pool availability, route validity, execution outcome, and liquidity are not guaranteed.'] };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] }];
export function buildQuickSwapV2Registry(): DefiRegistryFragment { return { chains }; }

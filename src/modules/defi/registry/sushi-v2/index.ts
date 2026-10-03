import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const sourceRef = 'docs/defi-research/expansion-2-sushi-provenance.md (official sushi-labs/sushi SDK at commit 5082d90dc76a87aaf731e9f3668384869ddf885b; snapshot 2026-10-03)';
const deployments = [
  { chainId: 1, router: '0xd9E1CE17F2641F24AE83637ab66a2cca9C378B9F' },
  { chainId: 8453, router: '0x6bDed42c6dA8FBf0d2Ba55B2fa120C5e0C8D7891' },
  { chainId: 137, router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' },
  { chainId: 42161, router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' },
  { chainId: 10, router: '0x2ABf469074DC0b54D793850807E6eB5fAF2625b1' },
  { chainId: 56, router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' },
] as const;

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

export function buildSushiV2Registry(): DefiRegistryFragment {
  const chains: DefiChainPolicy[] = deployments.map(({ chainId, router }) => {
    const functions: DefiFunctionPolicy[] = specs.map((spec) => {
      const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
      const signature = `${spec.name}(${spec.inputs.map((input) => input.type).join(',')})`;
      return {
        capabilityId: `sushiswap-v2:v2:${chainId}:${router.toLowerCase()}:${spec.operation}`,
        type: 'contract_call', chainId, contract: router, functionName: spec.name, signature, abi, status: 'active',
        provenance: { sourceRef, verifiedAt: '2026-10-03', status: 'verified' },
        protocol: 'SushiSwap V2', operation: spec.operation, label: `SushiSwap V2 ${spec.name}`,
        warnings: ['Caller chooses assets and path, amounts, minimums, recipient, deadline, and payable native value; none are financially constrained here.', 'Pool availability, route validity, execution outcome, and liquidity are not guaranteed.'],
      };
    });
    return { chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] };
  });
  return { chains };
}

import { toFunctionSelector } from 'viem';
import { buildApprovalFragment } from './approvals';

describe('independent ERC-20 approval capabilities', () => {
  it('contains 18 separately grantable source-addressed approval functions', () => {
    const fragment = buildApprovalFragment();
    const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(functions).toHaveLength(18);
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(functions.every((fn) => fn.signature === 'approve(address,uint256)' && fn.warnings?.some((warning) => warning.includes('any spender')))).toBe(true);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}`)).size).toBe(18);
    expect(new Set(functions.map((fn) => toFunctionSelector(fn.signature))).size).toBe(1);
  });

  it('preserves Arbitrum native USDC separately from USDC.e and records USDT no-return ABI', () => {
    const functions = buildApprovalFragment().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    const arbUsdc = functions.filter((fn) => fn.chainId === 42161);
    expect(arbUsdc.map((fn) => fn.contract.toLowerCase()).sort()).toEqual([
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    ]);
    const usdt = functions.find((fn) => fn.chainId === 1 && fn.contract.toLowerCase() === '0xdac17f958d2ee523a2206206994597c13d831ec7')!;
    expect(usdt.abi.outputs).toEqual([]);
  });
});

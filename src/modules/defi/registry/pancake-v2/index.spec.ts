import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildPancakeV2Registry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('PancakeSwap V2 registry', () => {
  const fragment = buildPancakeV2Registry();
  const chains = fragment.chains;
  const functions = chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (name: string) => functions.find((fn) => fn.functionName === name)!;

  it('publishes exactly ten active, verified BNB router calls with unique selectors', () => {
    expect(chains.map((chain) => chain.chainId)).toEqual([56]);
    expect(chains[0].contracts.map((contract) => contract.address)).toEqual(['0x10ED43C718714eb63d5aA57B78B54704E256024E']);
    expect(functions).toHaveLength(10);
    expect(functions.filter((fn) => fn.functionName.startsWith('swap'))).toHaveLength(6);
    expect(functions.filter((fn) => fn.functionName.startsWith('add') || fn.functionName.startsWith('remove'))).toHaveLength(4);
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03')).toBe(true);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract}:${toFunctionSelector(fn.signature)}`)).size).toBe(10);
    expect(functions.filter((fn) => fn.abi.stateMutability === 'payable').map((fn) => fn.functionName).sort()).toEqual(['addLiquidityETH', 'swapETHForExactTokens', 'swapExactETHForTokens'].sort());
  });

  it('matches exact address[] path swap ABI signatures and outputs', () => {
    for (const name of ['swapExactTokensForTokens', 'swapTokensForExactTokens', 'swapExactETHForTokens', 'swapTokensForExactETH', 'swapExactTokensForETH', 'swapETHForExactTokens']) {
      expect(find(name).abi.outputs).toEqual([{ name: 'amounts', type: 'uint256[]' }]);
      expect(find(name).abi.inputs.find((input) => input.name === 'path')).toEqual({ name: 'path', type: 'address[]' });
    }
    expect(find('swapExactTokensForTokens').signature).toBe('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)');
    expect(find('swapTokensForExactTokens').signature).toBe('swapTokensForExactTokens(uint256,uint256,address[],address,uint256)');
    expect(find('swapETHForExactTokens').signature).toBe('swapETHForExactTokens(uint256,address[],address,uint256)');
  });

  it('has exact liquidity output shapes and payable declarations', () => {
    expect(find('addLiquidity').abi.outputs.map((item) => item.name)).toEqual(['amountA', 'amountB', 'liquidity']);
    expect(find('addLiquidityETH').abi.outputs.map((item) => item.name)).toEqual(['amountToken', 'amountETH', 'liquidity']);
    expect(find('removeLiquidity').abi.outputs.map((item) => item.name)).toEqual(['amountA', 'amountB']);
    expect(find('removeLiquidityETH').abi.outputs.map((item) => item.name)).toEqual(['amountToken', 'amountETH']);
    expect(find('addLiquidityETH').abi.stateMutability).toBe('payable');
    expect(find('swapExactETHForTokens').abi.stateMutability).toBe('payable');
    expect(find('swapETHForExactTokens').abi.stateMutability).toBe('payable');
  });

  it('uses distinct stable Pancake V2 capability identities', () => {
    expect(functions.map((fn) => fn.capabilityId)).toContain('pancakeswap-v2:v2:56:0x10ed43c718714eb63d5aa57b78b54704e256024e:swap-exact-tokens-for-tokens');
    expect(functions.every((fn) => fn.capabilityId.startsWith('pancakeswap-v2:v2:56:'))).toBe(true);
  });

  it('authorizes granted arbitrary caller parameters via the actual catalog and policy', async () => {
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(fragment.chains, prisma as never, manifest);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const fn = find('swapExactTokensForTokens');
    const data = encode(fn, [1n << 255n, 0n, [A, B, C], C, 1n]);
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(56, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    const payable = find('swapExactETHForTokens');
    await expect(policy.authorizeContractCalls([{ to: payable.contract, data: encode(payable, [0n, [A, B], C, 1n]), value: '17' }], context(56, [payable.capabilityId]))).resolves.toBeDefined();
  });

  it('rejects wrong chain, destination, selector, missing grant and value on nonpayable calls', async () => {
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
    const fn = find('swapExactTokensForTokens');
    const data = encode(fn, [1n, 0n, [A, B], C, 1n]);
    const deny = (call: { to: string; data: string; value?: string | number | bigint }, ctx = context(56, [fn.capabilityId])) => policy.authorizeContractCalls([call], ctx);
    await expect(deny({ to: fn.contract, data }, context(10, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(deny({ to: A, data })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: '0xdeadbeef' })).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data }, context(56, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(deny({ to: fn.contract, data, value: '1' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});

function encode(fn: DefiFunctionPolicy, args: readonly unknown[]): `0x${string}` {
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
}

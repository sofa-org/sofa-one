import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiInteraction } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildClassicDexRegistry } from './index';

const methods = ['swapExactTokensForTokens', 'swapExactETHForTokens', 'swapExactTokensForETH', 'addLiquidity', 'addLiquidityETH', 'removeLiquidity', 'removeLiquidityETH'];
const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('classic DEX registry', () => {
  const chains = buildClassicDexRegistry().chains;
  const functions = chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  it('publishes exactly fourteen verified router calls with source-specific addresses and unique selectors', () => {
    expect(functions).toHaveLength(14);
    expect(chains.map((chain) => chain.chainId)).toEqual([8453, 10]);
    expect(chains.map((chain) => chain.contracts[0].address)).toEqual(['0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858']);
    expect(functions.map((fn) => fn.functionName).sort()).toEqual([...methods, ...methods].sort());
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03')).toBe(true);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract}:${toFunctionSelector(fn.signature)}`)).size).toBe(14);
    expect(functions.filter((fn) => fn.abi.stateMutability === 'payable').map((fn) => fn.functionName).sort()).toEqual(['addLiquidityETH', 'swapExactETHForTokens', 'addLiquidityETH', 'swapExactETHForTokens'].sort());
    expect(functions.find((fn) => fn.functionName === 'swapExactTokensForTokens')?.signature).toBe('swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)');
  });

  it('round-trips the canonical four-field routes ABI, not a path array', () => {
    const fn = functions.find((item) => item.functionName === 'swapExactTokensForTokens')!;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [9n, 1n, [[A, B, true, C]], B, 99n] });
    expect(decodeFunctionData({ abi: [fn.abi], data }).args).toEqual([9n, 1n, [{ from: A, to: B, stable: true, factory: C }], B, 99n]);
    expect(fn.abi.inputs[2]).toMatchObject({ type: 'tuple[]', components: [{ name: 'from' }, { name: 'to' }, { name: 'stable' }, { name: 'factory' }] });
  });

  it('authorizes granted calls through catalog and policy without caller-argument caps', async () => {
    const fragment = buildClassicDexRegistry();
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(fragment.chains, prisma as never, manifest);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const fn = functions.find((item) => item.chainId === 8453 && item.functionName === 'swapExactTokensForTokens')!;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [1n << 255n, 0n, [[A, B, false, C]], C, 1n] });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], ctx(8453, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    const payable = functions.find((item) => item.chainId === 8453 && item.functionName === 'swapExactETHForTokens')!;
    const payableData = encodeFunctionData({ abi: [payable.abi], functionName: payable.functionName, args: [0n, [[A, B, false, C]], C, 1n] });
    await expect(policy.authorizeContractCalls([{ to: payable.contract, data: payableData, value: '17' }], ctx(8453, [payable.capabilityId]))).resolves.toBeDefined();
    const deny = (interaction: DefiInteraction, context = ctx(8453, [fn.capabilityId])) => policy.authorizeContractCalls([interaction], context);
    await expect(deny({ to: fn.contract, data }, ctx(8453, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(deny({ to: fn.contract, data }, ctx(10, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(deny({ to: A, data })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: '0xdeadbeef' })).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: `${data}00` })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(deny({ to: fn.contract, data, value: '1' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const wrongFamily = { ...fn.abi, inputs: [...fn.abi.inputs.slice(0, 2), { name: 'routes', type: 'address[]' as const }, ...fn.abi.inputs.slice(3)] };
    const wrongData = encodeFunctionData({ abi: [wrongFamily], functionName: fn.functionName, args: [1n, 0n, [A, B], C, 1n] as never });
    expect(wrongData.slice(0, 10)).not.toBe(data.slice(0, 10));
  });
});

import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildSushiV2Registry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
const deployments = [
  [1, '0xd9E1CE17F2641F24AE83637ab66a2cca9C378B9F'], [8453, '0x6bDed42c6dA8FBf0d2Ba55B2fa120C5e0C8D7891'],
  [137, '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'], [42161, '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'],
  [10, '0x2ABf469074DC0b54D793850807E6eB5fAF2625b1'], [56, '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'],
] as const;

describe('SushiSwap V2 registry', () => {
  const fragment = buildSushiV2Registry();
  const chains = fragment.chains;
  const functions = chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (chainId: number, name: string) => functions.find((fn) => fn.chainId === chainId && fn.functionName === name)!;

  it('publishes exactly ten verified methods on six explicit chain/address rows', () => {
    expect(chains.map(({ chainId }) => chainId)).toEqual(deployments.map(([id]) => id));
    expect(chains.map((chain) => [chain.chainId, chain.contracts[0].address])).toEqual(deployments);
    expect(functions).toHaveLength(60);
    expect(functions.filter((fn) => fn.functionName.startsWith('swap'))).toHaveLength(36);
    expect(functions.filter((fn) => fn.functionName.startsWith('add') || fn.functionName.startsWith('remove'))).toHaveLength(24);
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03')).toBe(true);
    expect(new Set(functions.map((fn) => fn.capabilityId)).size).toBe(60);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract}:${toFunctionSelector(fn.signature)}`)).size).toBe(60);
    expect(functions.filter((fn) => fn.abi.stateMutability === 'payable').map((fn) => fn.functionName)).toHaveLength(18);
    expect(functions.every((fn) => fn.capabilityId.startsWith(`sushiswap-v2:v2:${fn.chainId}:${fn.contract.toLowerCase()}:`))).toBe(true);
  });

  it('preserves exact address[] paths, outputs, and caller-controlled argument semantics', () => {
    for (const chainId of chains.map(({ chainId }) => chainId)) {
      for (const name of ['swapExactTokensForTokens', 'swapTokensForExactTokens', 'swapExactETHForTokens', 'swapTokensForExactETH', 'swapExactTokensForETH', 'swapETHForExactTokens']) {
        expect(find(chainId, name).abi.inputs.find(({ name: input }) => input === 'path')).toEqual({ name: 'path', type: 'address[]' });
        expect(find(chainId, name).abi.outputs).toEqual([{ name: 'amounts', type: 'uint256[]' }]);
      }
    }
    expect(find(1, 'swapExactTokensForTokens').signature).toBe('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)');
    expect(find(1, 'swapETHForExactTokens').abi.stateMutability).toBe('payable');
    expect(find(1, 'addLiquidityETH').abi.stateMutability).toBe('payable');
    expect(find(1, 'swapExactETHForTokens').abi.stateMutability).toBe('payable');
    expect(functions.every((fn) => fn.warnings?.some((warning) => warning.includes('not guaranteed')))).toBe(true);
  });

  it('authorizes every granted source function across all six chains and positive value for all payable functions', async () => {
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
    for (const fn of functions) {
      const args = fn.functionName.startsWith('swap')
        ? fn.functionName.includes('ExactETHForTokens') ? [0n, [A, B], C, 1n]
          : fn.functionName === 'swapETHForExactTokens' ? [1n, [A, B], C, 1n]
            : [1n, 0n, [A, B], C, 1n]
        : fn.functionName === 'addLiquidity' ? [A, B, 1n, 2n, 0n, 0n, C, 1n]
          : fn.functionName === 'addLiquidityETH' ? [A, 1n, 0n, 0n, C, 1n]
            : fn.functionName === 'removeLiquidity' ? [A, B, 1n, 0n, 0n, C, 1n]
              : [A, 1n, 0n, 0n, C, 1n];
      const data = encode(fn, args);
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(fn.abi.stateMutability === 'payable' ? { value: '17' } : {}) }], context(fn.chainId, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    }
  });

  it('denies absent grants, cross-chain grants, unknown targets/selectors, malformed data, and value on nonpayable methods', async () => {
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
    const fn = find(137, 'swapExactTokensForTokens');
    const data = encode(fn, [1n, 0n, [A, B], C, 1n]);
    const deny = (call: { to: string; data: string; value?: string | number | bigint }, ctx = context(137, [fn.capabilityId])) => policy.authorizeContractCalls([call], ctx);
    await expect(deny({ to: fn.contract, data }, context(137, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(deny({ to: fn.contract, data }, context(42161, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(deny({ to: A, data })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: '0xdeadbeef' })).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: `${data}00` })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(deny({ to: fn.contract, data, value: '1' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});

function encode(fn: DefiFunctionPolicy, args: readonly unknown[]): `0x${string}` {
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
}

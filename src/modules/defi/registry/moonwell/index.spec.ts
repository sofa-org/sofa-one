import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildMoonwellRegistry, MOONWELL_CAPABILITIES } from './index';

const chains = buildMoonwellRegistry().chains;
const manifest = buildReviewedManifest([{ chains }]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const context = (allowedCapabilityIds: string[] = MOONWELL_CAPABILITIES.map((fn) => fn.capabilityId), chainId = 8453): DefiExecutionContext => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
const policy = () => new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(chains, prisma as never, manifest));
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

describe('Moonwell registry fixture', () => {
  it('declares the exact 17 source-qualified, verified, fixed nonpayable capabilities', () => {
    expect(chains.map(({ chainId }) => chainId)).toEqual([8453]);
    expect(MOONWELL_CAPABILITIES).toHaveLength(17);
    expect(MOONWELL_CAPABILITIES.filter(({ contract }) => contract !== '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C')).toHaveLength(15);
    expect(MOONWELL_CAPABILITIES.filter(({ contract }) => contract === '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C').map(({ functionName }) => functionName)).toEqual(['enterMarkets', 'exitMarket']);
    expect(MOONWELL_CAPABILITIES.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-04' && fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(new Set(MOONWELL_CAPABILITIES.map(({ capabilityId }) => capabilityId)).size).toBe(17);
    expect(MOONWELL_CAPABILITIES.map(({ functionName }) => functionName)).toEqual([
      'mint', 'redeem', 'redeemUnderlying', 'borrow', 'repayBorrow',
      'mint', 'redeem', 'redeemUnderlying', 'borrow', 'repayBorrow',
      'mint', 'redeem', 'redeemUnderlying', 'borrow', 'repayBorrow',
      'enterMarkets', 'exitMarket',
    ]);
    expect(MOONWELL_CAPABILITIES.slice(0, 15).every(({ abi }) => abi.outputs[0]?.name === '' && abi.outputs[0]?.type === 'uint256')).toBe(true);
    expect(MOONWELL_CAPABILITIES.find(({ functionName }) => functionName === 'enterMarkets')?.abi.outputs).toEqual([{ name: '', type: 'uint256[]' }]);
  });

  it.each(MOONWELL_CAPABILITIES)('authorizes explicitly granted $functionName with caller-selected values', async (fn) => {
    const args: readonly unknown[] = fn.functionName === 'enterMarkets'
      ? [[address(91), address(92)]]
      : fn.functionName === 'exitMarket' ? [address(93)] : [(1n << 256n) - 1n];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('requires exact grants, target, chain, selector and canonical nonpayable calldata', async () => {
    const fn = MOONWELL_CAPABILITIES[0];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [1n] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId], 1))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy().authorizeContractCalls([{ to: address(99), data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: `${data}00` }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: 1n }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('does not share a grant across mToken targets or function scopes', async () => {
    const usdcMint = MOONWELL_CAPABILITIES[0];
    const wethMint = MOONWELL_CAPABILITIES[5];
    const mintData = encodeFunctionData({ abi: [usdcMint.abi], functionName: 'mint', args: [1n] });
    await expect(policy().authorizeContractCalls([{ to: wethMint.contract, data: mintData }], context([usdcMint.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const borrow = MOONWELL_CAPABILITIES[3];
    const borrowData = encodeFunctionData({ abi: [borrow.abi], functionName: 'borrow', args: [1n] });
    await expect(policy().authorizeContractCalls([{ to: borrow.contract, data: borrowData }], context([usdcMint.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });
});

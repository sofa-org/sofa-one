import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildApprovalFragment } from '../approvals';
import { buildExpansionTokenApprovalRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const OTHER = '0x0000000000000000000000000000000000000004';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('expansion token approval registry', () => {
  const fragment = buildExpansionTokenApprovalRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (symbol: string) => functions.find((fn) => fn.label === `${symbol} approve`)!;
  const makePolicy = () => {
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    return new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  };
  const encode = (fn: DefiFunctionPolicy, spender: string, amount: bigint) => encodeFunctionData({ abi: [fn.abi], functionName: 'approve', args: [spender, amount] });

  it('defines precisely three distinct standard ERC-20 approvals, separate from every baseline approval', () => {
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([1, 56]);
    expect(functions.map((fn) => [fn.chainId, fn.contract, fn.label])).toEqual([
      [1, '0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI approve'],
      [56, '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB approve'],
      [56, '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH approve'],
    ]);
    expect(new Set(functions.map((fn) => fn.capabilityId)).size).toBe(3);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(3);
    expect(functions.every((fn) => fn.capabilityId === `erc20:${fn.chainId}:${fn.contract.toLowerCase()}:approve`)).toBe(true);
    expect(functions.every((fn) => fn.abi.stateMutability === 'nonpayable' && fn.signature === 'approve(address,uint256)' && JSON.stringify(fn.abi.outputs) === JSON.stringify([{ name: '', type: 'bool' }]))).toBe(true);
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03')).toBe(true);
    const baseline = buildApprovalFragment().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(baseline).toHaveLength(18);
    expect(functions.every((fn) => !baseline.some((existing) => existing.capabilityId === fn.capabilityId))).toBe(true);
    expect(functions.map((fn) => fn.capabilityId)).not.toContain('erc20:56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d:approve');
    expect(functions.map((fn) => fn.capabilityId)).not.toContain('erc20:56:0x55d398326f99059ff775485246999027b3197955:approve');
    expect(find('BTCB').warnings?.some((warning) => warning.includes('not individually runtime-proven'))).toBe(true);
    expect(find('ETH').warnings?.some((warning) => warning.includes('not individually runtime-proven'))).toBe(true);
  });

  it('authorizes caller-selected spender and zero or maximum amount without requiring paired actions', async () => {
    const policy = makePolicy();
    for (const fn of functions) {
      for (const [spender, amount] of [[A, 0n], [OTHER, (1n << 256n) - 1n]] as const) {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encode(fn, spender, amount) }], context(fn.chainId, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      }
    }
  });

  it('denies empty grant, wrong chain, unknown target, positive nonpayable value and malformed calldata', async () => {
    const policy = makePolicy();
    const fn = find('DAI');
    const data = encode(fn, A, 0n);
    const deny = (call: { to: string; data: string; value?: string }, ctx = context(1, [fn.capabilityId])) => policy.authorizeContractCalls([call], ctx);
    await expect(deny({ to: fn.contract, data }, context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(deny({ to: fn.contract, data }, context(56, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(deny({ to: OTHER, data })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data, value: '1' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(deny({ to: fn.contract, data: `${data}00` })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(deny({ to: fn.contract, data: '0xdeadbeef' })).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });
});

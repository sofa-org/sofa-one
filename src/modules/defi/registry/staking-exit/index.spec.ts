import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildStakingExitRegistry, STAKING_EXIT_CAPABILITIES } from './index';

const catalog = buildStakingExitRegistry().chains;
const manifest = buildReviewedManifest([{ chains: catalog }]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const context = (allowedCapabilityIds: string[] = STAKING_EXIT_CAPABILITIES.map((fn) => fn.capabilityId), chainId = 1): DefiExecutionContext => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
const policy = () => new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(catalog, prisma as never, manifest));

describe('Lido staking exit registry', () => {
  it('has exactly three active, verified, canonical nonpayable queue definitions on Ethereum', () => {
    expect(catalog.map((chain) => chain.chainId)).toEqual([1]);
    expect(STAKING_EXIT_CAPABILITIES).toHaveLength(3);
    expect(STAKING_EXIT_CAPABILITIES.map((fn) => [fn.capabilityId, fn.signature, fn.operation])).toEqual([
      ['lido-withdrawal-queue:v1:1:0x889edc2edab5f40e902b864ad4d7ade8e412f9b1:requestWithdrawals', 'requestWithdrawals(uint256[],address)', 'request-withdrawal'],
      ['lido-withdrawal-queue:v1:1:0x889edc2edab5f40e902b864ad4d7ade8e412f9b1:requestWithdrawalsWstETH', 'requestWithdrawalsWstETH(uint256[],address)', 'request-withdrawal'],
      ['lido-withdrawal-queue:v1:1:0x889edc2edab5f40e902b864ad4d7ade8e412f9b1:claimWithdrawals', 'claimWithdrawals(uint256[],uint256[])', 'claim'],
    ]);
    expect(STAKING_EXIT_CAPABILITIES.every((fn) => fn.contract === '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1' && fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03' && fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(STAKING_EXIT_CAPABILITIES[0].abi.inputs).toEqual([{ name: '_amounts', type: 'uint256[]' }, { name: '_owner', type: 'address' }]);
    expect(STAKING_EXIT_CAPABILITIES[0].abi.outputs).toEqual([{ name: 'requestIds', type: 'uint256[]' }]);
    expect(STAKING_EXIT_CAPABILITIES[1].abi.outputs).toEqual([{ name: 'requestIds', type: 'uint256[]' }]);
    expect(STAKING_EXIT_CAPABILITIES[2].abi.inputs).toEqual([{ name: '_requestIds', type: 'uint256[]' }, { name: '_hints', type: 'uint256[]' }]);
    expect(STAKING_EXIT_CAPABILITIES[2].abi.outputs).toEqual([]);
    expect(STAKING_EXIT_CAPABILITIES[2].warnings?.join(' ')).toMatch(/msg.sender/);
  });

  it.each(['requestWithdrawals', 'requestWithdrawalsWstETH'] as const)('authorizes %s with arbitrary amounts and caller-selected owner for an explicit grant', async (name) => {
    const fn = STAKING_EXIT_CAPABILITIES.find((row) => row.functionName === name)!;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: name, args: [[1n, (1n << 255n)], '0x0000000000000000000000000000000000000009'] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('authorizes arbitrary request IDs and hints while keeping msg.sender as protocol claim recipient', async () => {
    const fn = STAKING_EXIT_CAPABILITIES[2];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'claimWithdrawals', args: [[(1n << 255n), 99n], [0n, (1n << 255n)]] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('denies ungranted calls, unsupported chain, unknown target or selector, noncanonical calldata, and payable value', async () => {
    const fn = STAKING_EXIT_CAPABILITIES[0];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'requestWithdrawals', args: [[1n], '0x0000000000000000000000000000000000000002'] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context(undefined, 8453))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy().authorizeContractCalls([{ to: '0x0000000000000000000000000000000000000009', data }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: `${data}00` }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: 1n }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});

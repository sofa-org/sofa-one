import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildMorphoBlueRegistry, MORPHO_BLUE_CAPABILITIES } from './index';

const catalog = buildMorphoBlueRegistry().chains;
const manifest = buildReviewedManifest([{ chains: catalog }]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const context = (allowedCapabilityIds: string[] = MORPHO_BLUE_CAPABILITIES.map((fn) => fn.capabilityId), chainId = 1): DefiExecutionContext => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
const policy = () => new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(catalog, prisma as never, manifest));
const params = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003', '0x0000000000000000000000000000000000000004', 860000000000000000n] as const;

describe('Morpho Blue registry', () => {
  it('contains exactly six active verified chain-specific direct method definitions', () => {
    expect(catalog.map((chain) => chain.chainId)).toEqual([1, 8453]);
    expect(MORPHO_BLUE_CAPABILITIES).toHaveLength(6);
    expect(MORPHO_BLUE_CAPABILITIES.map((fn) => [fn.chainId, fn.functionName])).toEqual([[1, 'withdraw'], [1, 'withdrawCollateral'], [1, 'borrow'], [8453, 'withdraw'], [8453, 'withdrawCollateral'], [8453, 'borrow']]);
    expect(MORPHO_BLUE_CAPABILITIES.every((fn) => fn.contract === '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' && fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03' && fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(MORPHO_BLUE_CAPABILITIES[0].abi.inputs[0]).toMatchObject({ type: 'tuple', components: [{ name: 'loanToken' }, { name: 'collateralToken' }, { name: 'oracle' }, { name: 'irm' }, { name: 'lltv' }] });
    expect(MORPHO_BLUE_CAPABILITIES[0].abi.outputs).toEqual([{ name: 'assetsWithdrawn', type: 'uint256' }, { name: 'sharesWithdrawn', type: 'uint256' }]);
    expect(MORPHO_BLUE_CAPABILITIES[1].abi.outputs).toEqual([]);
    expect(MORPHO_BLUE_CAPABILITIES[2].signature).toBe('borrow((address,address,address,address,uint256),uint256,uint256,address,address)');
    expect(MORPHO_BLUE_CAPABILITIES[2].abi.outputs).toEqual([{ name: 'assetsBorrowed', type: 'uint256' }, { name: 'sharesBorrowed', type: 'uint256' }]);
  });

  it.each([1, 8453])('encodes exact tuple argument order and authorizes caller-selected params, recipient, and amount on chain %i', async (chainId) => {
    const fn = MORPHO_BLUE_CAPABILITIES.find((row) => row.chainId === chainId && row.functionName === 'withdraw')!;
    const args = [params, 0n, (1n << 255n), '0x0000000000000000000000000000000000000005', '0x0000000000000000000000000000000000000006'] as const;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'withdraw', args });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId], chainId))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId, chainId }] });
  });

  it('authorizes caller-selected collateral owner/receiver and amount without imposing validator', async () => {
    const fn = MORPHO_BLUE_CAPABILITIES.find((row) => row.functionName === 'withdrawCollateral')!;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'withdrawCollateral', args: [params, (1n << 255n), '0x0000000000000000000000000000000000000007', '0x0000000000000000000000000000000000000008'] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('authorizes directly granted borrow with arbitrary caller-selected debt quantity, owner, and receiver', async () => {
    const fn = MORPHO_BLUE_CAPABILITIES.find((row) => row.functionName === 'borrow')!;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'borrow', args: [params, (1n << 255n), 0n, '0x0000000000000000000000000000000000000009', '0x000000000000000000000000000000000000000a'] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('rejects missing grant, unknown chain, contract, selector and nonpayable value', async () => {
    const fn = MORPHO_BLUE_CAPABILITIES[0];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'withdraw', args: [params, 1n, 0n, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context(undefined, 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy().authorizeContractCalls([{ to: '0x0000000000000000000000000000000000000009', data }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: 1n }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});

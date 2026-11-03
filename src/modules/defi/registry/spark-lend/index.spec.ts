import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildSparkLendRegistry, SPARK_LEND_CAPABILITIES } from './index';

const catalog = buildSparkLendRegistry().chains;
const manifest = buildReviewedManifest([{ chains: catalog }]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const context = (allowedCapabilityIds: string[] = SPARK_LEND_CAPABILITIES.map((fn) => fn.capabilityId), chainId = 1): DefiExecutionContext => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
const policy = () => new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(catalog, prisma as never, manifest));
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

describe('SparkLend registry', () => {
  it('declares exactly four active, verified, fixed nonpayable Ethereum Pool functions', () => {
    expect(catalog.map((chain) => chain.chainId)).toEqual([1]);
    expect(SPARK_LEND_CAPABILITIES).toHaveLength(4);
    expect(SPARK_LEND_CAPABILITIES.map((fn) => fn.functionName)).toEqual(['supply', 'withdraw', 'borrow', 'repay']);
    expect(SPARK_LEND_CAPABILITIES.every((fn) => fn.contract === '0xC13e21B648A5Ee794902342038FF3aDAB66BE987' && fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03' && fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(new Set(SPARK_LEND_CAPABILITIES.map((fn) => fn.capabilityId)).size).toBe(4);
    expect(SPARK_LEND_CAPABILITIES.map((fn) => fn.abi.outputs)).toEqual([[], [{ name: '', type: 'uint256' }], [], [{ name: '', type: 'uint256' }]]);
  });

  it.each(SPARK_LEND_CAPABILITIES)('authorizes granted caller-selected $functionName ABI arguments without financial constraints', async (fn) => {
    let args: readonly unknown[];
    if (fn.functionName === 'supply') args = [address(2), (1n << 256n) - 1n, address(3), 99];
    else if (fn.functionName === 'withdraw') args = [address(2), (1n << 256n) - 1n, address(4)];
    else if (fn.functionName === 'borrow') args = [address(2), (1n << 256n) - 1n, (1n << 256n) - 1n, 99, address(5)];
    else args = [address(2), (1n << 256n) - 1n, (1n << 256n) - 1n, address(6)];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('denies missing grant, unknown chain/contract/selector, trailing bytes, and native value', async () => {
    const fn = SPARK_LEND_CAPABILITIES[0];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'supply', args: [address(2), 1n, address(3), 99] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context(undefined, 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy().authorizeContractCalls([{ to: address(9), data }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: `${data}00` }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: 1n }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});

import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildStakingRegistry, STAKING_CAPABILITIES } from './index';

const catalog = buildStakingRegistry().chains;
const manifest = buildReviewedManifest([{ chains: catalog }]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const context = (allowedCapabilityIds: string[] = STAKING_CAPABILITIES.map((fn) => fn.capabilityId), chainId = 1): DefiExecutionContext => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
const policy = () => new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(catalog, prisma as never, manifest));

describe('Lido staking registry', () => {
  it('contains exactly three actions and two independent active verified approval definitions', () => {
    expect(catalog).toHaveLength(1);
    expect(STAKING_CAPABILITIES).toHaveLength(5);
    expect(STAKING_CAPABILITIES.slice(0, 3).map((fn) => [fn.functionName, fn.signature])).toEqual([['submit', 'submit(address)'], ['wrap', 'wrap(uint256)'], ['unwrap', 'unwrap(uint256)']]);
    expect(STAKING_CAPABILITIES.map((fn) => fn.contract.toLowerCase())).toEqual(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0']);
    expect(STAKING_CAPABILITIES.slice(0, 3).map((fn) => fn.abi.stateMutability)).toEqual(['payable', 'nonpayable', 'nonpayable']);
    expect(STAKING_CAPABILITIES.slice(3).map((fn) => [fn.capabilityId, fn.abi.outputs])).toEqual([
      ['erc20:1:0xae7ab96520de3a18e5e111b5eaab095312d7fe84:approve', [{ name: '', type: 'bool' }]],
      ['erc20:1:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0:approve', [{ name: '', type: 'bool' }]],
    ]);
    expect(STAKING_CAPABILITIES.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03')).toBe(true);
  });

  it('authorizes caller-chosen referral and arbitrary native stake value for an explicit grant', async () => {
    const fn = STAKING_CAPABILITIES[0];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'submit', args: ['0x0000000000000000000000000000000000000002'] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: '123456789' }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });

  it('denies missing grants and nonzero value for nonpayable wraps', async () => {
    const fn = STAKING_CAPABILITIES[1];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'wrap', args: [99n] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: 1n }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('authorizes a separately granted approval for any spender and maximum uint256 without an action grant', async () => {
    const fn = STAKING_CAPABILITIES[3];
    const data = encodeFunctionData({ abi: [fn.abi], functionName: 'approve', args: ['0x0000000000000000000000000000000000000000', (1n << 256n) - 1n] });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    expect(fn.warnings?.join(' ')).toMatch(/Independent explicit grant/);
  });
});

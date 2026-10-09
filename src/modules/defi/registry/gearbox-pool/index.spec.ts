import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildGearboxPoolRegistry, GEARBOX_POOL_CAPABILITIES } from './index';

const pool = '0xC155444481854c60e7a29f4150373f479988F32D';
const receiver = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const max = (1n << 256n) - 1n;
const args = (fn: DefiFunctionPolicy): readonly unknown[] => fn.functionName === 'deposit' || fn.functionName === 'mint'
  ? [max, receiver]
  : [max, receiver, owner];
const call = (fn: DefiFunctionPolicy) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args(fn) as never }),
});

const fragment = buildGearboxPoolRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({
  userId: 'gearbox-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet',
  chainId, executionMode: 'session_key', executionOwner: receiver, allowedCapabilityIds: grants,
});

describe('Gearbox Pool V3.10 Ethereum fixed-selector fixture', () => {
  it('binds exactly four inactive source declarations to their complete ABI objects, hashes, and source references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/gearbox.json', 'utf8'));
    const family = source.families[0];
    const rawContracts = family.contracts;
    const rawFunctions = rawContracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract, abi })));
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('gearbox-pool');
    expect(family.familyVersion).toBe('v3-10');
    expect(rawContracts).toHaveLength(1);
    expect(rawContracts[0]).toMatchObject({ chainId: 1, address: pool, status: 'inactive' });
    expect(rawFunctions).toHaveLength(4);
    expect(GEARBOX_POOL_CAPABILITIES).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(GEARBOX_POOL_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.capabilityId, fn.abi.stateMutability])).toEqual([
      ['deposit', 'deposit(uint256,address)', 'gearbox-pool:versionv3-10:1:0xc155444481854c60e7a29f4150373f479988f32d:deposit', 'nonpayable'],
      ['mint', 'mint(uint256,address)', 'gearbox-pool:versionv3-10:1:0xc155444481854c60e7a29f4150373f479988f32d:mint', 'nonpayable'],
      ['withdraw', 'withdraw(uint256,address,address)', 'gearbox-pool:versionv3-10:1:0xc155444481854c60e7a29f4150373f479988f32d:withdraw', 'nonpayable'],
      ['redeem', 'redeem(uint256,address,address)', 'gearbox-pool:versionv3-10:1:0xc155444481854c60e7a29f4150373f479988f32d:redeem', 'nonpayable'],
    ]);
    for (const fn of GEARBOX_POOL_CAPABILITIES) {
      const rawContract = rawContracts.find((contract: any) => contract.address.toLowerCase() === fn.contract.toLowerCase());
      const raw = rawContract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(rawContract.sourceRefs).toContain(sourceId);
      expect(rawContract.sourceRefs).toContain('gearbox-sdk-pool-test');
      expect(rawContract.sourceRefs).toContain('gearbox-core-pool-interface');
      expect(fn.status).toBe('active');
      expect(fn.provenance.status).toBe('verified');
    }
    expect(rawFunctions.map(({ abi }: any) => abi.name).sort()).toEqual(['deposit', 'mint', 'redeem', 'withdraw']);
    expect(new Set(GEARBOX_POOL_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(4);
  });

  it('authorizes all four functions only under their exact grant; empty grants deny and every positive value is rejected', async () => {
    for (const fn of GEARBOX_POOL_CAPABILITIES) {
      const request = call(fn);
      await expect(policy.authorizeContractCalls([request], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([request], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...request, value: 1n }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('keeps selector, target, and chain authority isolated while accepting ABI-maximum caller amounts', async () => {
    for (const fn of GEARBOX_POOL_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toBeDefined();
    }
    const deposit = GEARBOX_POOL_CAPABILITIES.find((fn) => fn.functionName === 'deposit')!;
    const mint = GEARBOX_POOL_CAPABILITIES.find((fn) => fn.functionName === 'mint')!;
    await expect(policy.authorizeContractCalls([call(mint)], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(deposit), to: '0x3333333333333333333333333333333333333333' }], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit)], context([deposit.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  });

  it('rejects noncanonical calldata with trailing bytes and selector substitution', async () => {
    const fn = GEARBOX_POOL_CAPABILITIES.find((item) => item.functionName === 'withdraw')!;
    const valid = call(fn);
    await expect(policy.authorizeContractCalls([{ ...valid, data: `${valid.data}00` }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...valid, data: `0xdeadbeef${valid.data.slice(10)}` }], context([fn.capabilityId]))).rejects.toBeDefined();
  });
});

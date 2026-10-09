import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildEthenaRegistry, ETHENA_CAPABILITIES } from './index';

const target = '0x9d39a5de30e57443bff2a8307a4256c8797a3497';
const arbitrary = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const max = (1n << 256n) - 1n;
function args(fn: DefiFunctionPolicy): readonly unknown[] {
  switch (fn.functionName) {
    case 'deposit': return [max, arbitrary];
    case 'mint': return [max, arbitrary];
    case 'cooldownAssets': return [max];
    case 'cooldownShares': return [max];
    case 'unstake': return [arbitrary];
    case 'withdraw': return [max, arbitrary, other];
    case 'redeem': return [max, arbitrary, other];
    default: throw new Error(`Unexpected Ethena method ${fn.functionName}`);
  }
}
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args(fn) as never }),
  ...(value === undefined ? {} : { value }),
});

const fragment = buildEthenaRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({
  userId: 'ethena-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet',
  chainId, executionMode: 'session_key', executionOwner: arbitrary, allowedCapabilityIds: grants,
});

describe('Ethena Ethereum sUSDe V2 fixed-selector fixture', () => {
  it('binds exactly seven inactive source ABIs, hashes, signatures, IDs, and references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/ethena.json', 'utf8'));
    const family = source.families[0];
    const rawContracts = family.contracts;
    const rawFunctions = rawContracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract, abi })));
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('ethena');
    expect(family.familyVersion).toBe('staked-usde-v2');
    expect(rawContracts).toHaveLength(1);
    expect(rawContracts[0]).toMatchObject({ chainId: 1, address: target, status: 'inactive' });
    expect(rawFunctions).toHaveLength(7);
    expect(ETHENA_CAPABILITIES).toHaveLength(7);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(ETHENA_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.capabilityId, fn.abi.stateMutability])).toEqual([
      ['deposit', 'deposit(uint256,address)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:deposit', 'nonpayable'],
      ['mint', 'mint(uint256,address)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:mint', 'nonpayable'],
      ['cooldownAssets', 'cooldownAssets(uint256)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:cooldown-assets', 'nonpayable'],
      ['cooldownShares', 'cooldownShares(uint256)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:cooldown-shares', 'nonpayable'],
      ['unstake', 'unstake(address)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:unstake', 'nonpayable'],
      ['withdraw', 'withdraw(uint256,address,address)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:withdraw', 'nonpayable'],
      ['redeem', 'redeem(uint256,address,address)', 'ethena:staked-usde-v2:1:0x9d39a5de30e57443bff2a8307a4256c8797a3497:redeem', 'nonpayable'],
    ]);
    for (const fn of ETHENA_CAPABILITIES) {
      const rawContract = rawContracts.find((contract: any) => contract.address.toLowerCase() === fn.contract.toLowerCase());
      const raw = rawContract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(rawContract.sourceRefs).toContain(sourceId);
      for (const ref of ['ethena-key-addresses', 'ethena-staking-usde']) expect(rawContract.sourceRefs).toContain(ref);
      expect(fn.status).toBe('active');
      expect(fn.provenance.status).toBe('verified');
    }
    expect(new Set(ETHENA_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(7);
    expect(rawFunctions.map(({ abi }: any) => abi.name).sort()).toEqual(['cooldownAssets', 'cooldownShares', 'deposit', 'mint', 'redeem', 'unstake', 'withdraw']);
    expect(ETHENA_CAPABILITIES.find((fn) => fn.functionName === 'deposit')?.abi.outputs).toEqual([{ name: '', type: 'uint256', internalType: 'uint256' }]);
    expect(ETHENA_CAPABILITIES.find((fn) => fn.functionName === 'unstake')?.abi.outputs).toEqual([]);
  });

  it('authorizes all seven methods under exact grants only and rejects positive native value', async () => {
    for (const fn of ETHENA_CAPABILITIES) {
      const request = call(fn);
      await expect(policy.authorizeContractCalls([request], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([request], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('isolates methods, target, and chain while allowing maximum ABI amounts and unrelated receivers/owners', async () => {
    for (const fn of ETHENA_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toBeDefined();
    }
    const deposit = ETHENA_CAPABILITIES.find((fn) => fn.functionName === 'deposit')!;
    const mint = ETHENA_CAPABILITIES.find((fn) => fn.functionName === 'mint')!;
    await expect(policy.authorizeContractCalls([call(mint)], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(deposit), to: other }], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit)], context([deposit.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  });

  it('rejects noncanonical address padding and trailing calldata', async () => {
    const fn = ETHENA_CAPABILITIES.find((item) => item.functionName === 'deposit')!;
    const valid = call(fn);
    const addressWord = 10 + 64;
    const noncanonicalAddress = `${valid.data.slice(0, addressWord)}${'1'.repeat(24)}${valid.data.slice(addressWord + 24)}` as `0x${string}`;
    for (const data of [noncanonicalAddress, `${valid.data}00`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});

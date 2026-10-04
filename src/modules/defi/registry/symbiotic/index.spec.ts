import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildSymbioticRegistry, SYMBIOTIC_CAPABILITIES } from './index';

const vault = '0x007e0B8E99c6134E81A1eAAE754460E3202cB671';
const recipient = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
function args(fn: DefiFunctionPolicy): readonly unknown[] {
  switch (fn.functionName) {
    case 'deposit': return [recipient, max];
    case 'withdraw': return [recipient, max];
    case 'redeem': return [recipient, max];
    case 'claim': return [recipient, max];
    case 'claimBatch': return [recipient, [max, max - 1n, 0n]];
    default: throw new Error(`Unexpected Symbiotic method ${fn.functionName}`);
  }
}
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args(fn) as never }),
  ...(value === undefined ? {} : { value }),
});

const fragment = buildSymbioticRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({
  userId: 'symbiotic-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet',
  chainId, executionMode: 'session_key', executionOwner: recipient, allowedCapabilityIds: grants,
});

describe('Symbiotic Ethereum vault fixed-selector fixture', () => {
  it('binds exactly five inactive source declarations to fixture ABI hashes, stable IDs, and provenance references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/symbiotic.json', 'utf8'));
    const family = source.families[0];
    const rawContracts = family.contracts;
    const rawFunctions = rawContracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract, abi })));
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('symbiotic');
    expect(family.familyVersion).toBe('vault@83a3a9ab');
    expect(rawContracts).toHaveLength(1);
    expect(rawContracts[0]).toMatchObject({ chainId: 1, address: vault, status: 'inactive' });
    expect(rawFunctions).toHaveLength(5);
    expect(SYMBIOTIC_CAPABILITIES).toHaveLength(5);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(SYMBIOTIC_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.capabilityId, fn.abi.stateMutability])).toEqual([
      ['deposit', 'deposit(address,uint256)', 'symbiotic:v1:1:0x007e0b8e99c6134e81a1eaae754460e3202cb671:deposit', 'nonpayable'],
      ['withdraw', 'withdraw(address,uint256)', 'symbiotic:v1:1:0x007e0b8e99c6134e81a1eaae754460e3202cb671:withdraw', 'nonpayable'],
      ['redeem', 'redeem(address,uint256)', 'symbiotic:v1:1:0x007e0b8e99c6134e81a1eaae754460e3202cb671:redeem', 'nonpayable'],
      ['claim', 'claim(address,uint256)', 'symbiotic:v1:1:0x007e0b8e99c6134e81a1eaae754460e3202cb671:claim', 'nonpayable'],
      ['claimBatch', 'claimBatch(address,uint256[])', 'symbiotic:v1:1:0x007e0b8e99c6134e81a1eaae754460e3202cb671:claim-batch', 'nonpayable'],
    ]);
    for (const fn of SYMBIOTIC_CAPABILITIES) {
      const rawContract = rawContracts.find((contract: any) => contract.address.toLowerCase() === fn.contract.toLowerCase());
      const raw = rawContract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(rawContract.sourceRefs).toContain(sourceId);
      for (const ref of ['symbiotic-mainnet-vault-metadata', 'symbiotic-vault-implementation', 'symbiotic-vault-factory']) {
        expect(rawContract.sourceRefs).toContain(ref);
      }
      expect(fn.status).toBe('active');
      expect(fn.provenance.status).toBe('verified');
    }
    expect(new Set(SYMBIOTIC_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(5);
    expect(rawFunctions.map(({ abi }: any) => abi.name).sort()).toEqual(['claim', 'claimBatch', 'deposit', 'redeem', 'withdraw']);
  });

  it('authorizes each of five operations with its exact grant; empty grants and positive native value deny', async () => {
    for (const fn of SYMBIOTIC_CAPABILITIES) {
      const request = call(fn);
      await expect(policy.authorizeContractCalls([request], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([request], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('isolates method, chain, and target while permitting ABI-maximum caller financial arguments', async () => {
    for (const fn of SYMBIOTIC_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toBeDefined();
    }
    const deposit = SYMBIOTIC_CAPABILITIES.find((fn) => fn.functionName === 'deposit')!;
    const withdraw = SYMBIOTIC_CAPABILITIES.find((fn) => fn.functionName === 'withdraw')!;
    await expect(policy.authorizeContractCalls([call(withdraw)], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(deposit), to: '0x2222222222222222222222222222222222222222' }], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit)], context([deposit.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  });

  it('enforces canonical dynamic-array encoding and rejects trailing calldata or selector changes', async () => {
    const fn = SYMBIOTIC_CAPABILITIES.find((item) => item.functionName === 'claimBatch')!;
    const valid = call(fn);
    const badOffset = `${valid.data.slice(0, 10 + 64)}${'0'.repeat(62)}60${valid.data.slice(10 + 64 + 64)}` as `0x${string}`;
    const badLength = `${valid.data.slice(0, 10 + 64 + 64 + 63)}2${valid.data.slice(10 + 64 + 64 + 64)}` as `0x${string}`;
    for (const data of [badOffset, badLength, `${valid.data}00`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    await expect(policy.authorizeContractCalls([{ ...valid, data: `0xdeadbeef${valid.data.slice(10)}` }], context([fn.capabilityId]))).rejects.toBeDefined();
  });
});

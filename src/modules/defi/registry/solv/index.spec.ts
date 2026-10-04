import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildSolvRouterV2Registry, SOLV_ROUTER_V2_CAPABILITIES } from './index';

const proxy = '0x3d93B9e8F0886358570646dAd9421564C5fE6334';
const receiptImplementation = '0xeEdFBda83be3D1ADeB6f5A3D48933A372AcB7C9C';
const listedImplementation = '0x1D8595e194Eaaff37496a9A5F3F509f5EEA9C70b';
const other = '0x1111111111111111111111111111111111111111';
const another = '0x2222222222222222222222222222222222222222';
const max = (1n << 256n) - 1n;
const max64 = (1n << 64n) - 1n;
const fragment = buildSolvRouterV2Registry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'solv-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy): readonly (bigint | `0x${string}`)[] => {
  switch (fn.functionName) {
    case 'deposit': return [other, another, max, max, max64];
    case 'withdrawRequest': return [other, another, max];
    case 'cancelWithdrawRequest': return [other, another, max];
    default: throw new Error(`Unexpected Solv operation ${fn.functionName}`);
  }
};
const call = (fn: DefiFunctionPolicy, value?: bigint, args = argsFor(fn)) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), ...(value === undefined ? {} : { value }) });

describe('SolvBTC Router V2 Ethereum proxy fixture', () => {
  it('binds three inactive source declarations to full ABI hashes, stable IDs and strict resolved refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/solv.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'solv', familyVersion: 'router-v2' });
    expect(contract).toMatchObject({ chainId: 1, address: proxy, status: 'inactive', contractName: 'SolvBTC Router V2 user proxy' });
    expect(source.sources).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.sourceRefs).toEqual(expect.arrayContaining([...sourceIds]));
    expect(contract.abiFunctions).toHaveLength(3);
    expect(SOLV_ROUTER_V2_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['deposit', `solv:router-v2:1:${proxy.toLowerCase()}:deposit`, 'deposit(address,address,uint256,uint256,uint64)', 'nonpayable'],
      ['withdrawRequest', `solv:router-v2:1:${proxy.toLowerCase()}:withdraw-request`, 'withdrawRequest(address,address,uint256)', 'nonpayable'],
      ['cancelWithdrawRequest', `solv:router-v2:1:${proxy.toLowerCase()}:cancel-withdraw-request`, 'cancelWithdrawRequest(address,address,uint256)', 'nonpayable'],
    ]);
    for (const fn of SOLV_ROUTER_V2_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    const withdrawal = SOLV_ROUTER_V2_CAPABILITIES.find((fn) => fn.functionName === 'withdrawRequest')!;
    expect(withdrawal.abi.outputs).toEqual([{ name: '', type: 'address', internalType: 'address' }, { name: '', type: 'uint256', internalType: 'uint256' }]);
    expect(new Set(SOLV_ROUTER_V2_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(3);
    expect(contract.address.toLowerCase()).not.toBe(receiptImplementation.toLowerCase());
    expect(contract.address.toLowerCase()).not.toBe(listedImplementation.toLowerCase());
  });

  it('allows only each exact grant, denies empty grants, accepts max ABI values and rejects native value', async () => {
    for (const fn of SOLV_ROUTER_V2_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates function, selector, proxy target and chain', async () => {
    for (const fn of SOLV_ROUTER_V2_CAPABILITIES) {
      const anotherFunction = SOLV_ROUTER_V2_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([anotherFunction.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: listedImplementation }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: receiptImplementation }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects noncanonical address padding, uint64 high bits, trailing and truncated calldata', async () => {
    const deposit = SOLV_ROUTER_V2_CAPABILITIES.find((fn) => fn.functionName === 'deposit')!;
    const valid = call(deposit);
    const badAddress = `${valid.data.slice(0, 10)}${'1'.repeat(24)}${valid.data.slice(34)}`;
    const uint64Start = 10 + 4 * 64;
    const badUint64 = `${valid.data.slice(0, uint64Start)}${'1'.repeat(24)}${valid.data.slice(uint64Start + 24)}`;
    for (const data of [badAddress, badUint64, `${valid.data}00`, valid.data.slice(0, -2)]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([deposit.capabilityId]))).rejects.toBeDefined();
    }
  });
});

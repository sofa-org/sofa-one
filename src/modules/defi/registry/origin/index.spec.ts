import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildOriginOethRegistry, ORIGIN_OETH_CAPABILITIES } from './index';

const proxy = '0x39254033945AA2E4809Cc2977E7087BEE48bd7Ab';
const implementation = '0x0E979edF516f88119fa2843fA3f08A9643F8e575';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildOriginOethRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'origin-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy): readonly (bigint | bigint[])[] => fn.functionName === 'claimWithdrawals' ? [[max, 0n, 42n]] : [max];
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn) as never }), ...(value === undefined ? {} : { value }) });

describe('Origin OETH Ethereum user-proxy fixture', () => {
  it('binds four inactive deployment ABI declarations to fixture hashes, IDs and strict source references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/origin.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'origin', familyVersion: 'oeth-v1@1d7e1dcb' });
    expect(contract).toMatchObject({ chainId: 1, address: proxy, status: 'inactive', contractName: 'Origin OETH Vault user proxy' });
    expect(source.sources).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.abiFunctions).toHaveLength(4);
    expect(ORIGIN_OETH_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['mint', `origin:oeth-v1:1:${proxy.toLowerCase()}:mint`, 'mint(uint256)', 'nonpayable'],
      ['requestWithdrawal', `origin:oeth-v1:1:${proxy.toLowerCase()}:request-withdrawal`, 'requestWithdrawal(uint256)', 'nonpayable'],
      ['claimWithdrawal', `origin:oeth-v1:1:${proxy.toLowerCase()}:claim-withdrawal`, 'claimWithdrawal(uint256)', 'nonpayable'],
      ['claimWithdrawals', `origin:oeth-v1:1:${proxy.toLowerCase()}:claim-withdrawals`, 'claimWithdrawals(uint256[])', 'nonpayable'],
    ]);
    for (const fn of ORIGIN_OETH_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(ORIGIN_OETH_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(4);
    expect(contract.address.toLowerCase()).not.toBe(implementation.toLowerCase());
  });

  it('allows only exact grants, denies empty grants, accepts max uint financial/request arguments and rejects native value', async () => {
    for (const fn of ORIGIN_OETH_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates chain, target, selector and function grants, including implementation-address calls', async () => {
    for (const fn of ORIGIN_OETH_CAPABILITIES) {
      const otherFunction = ORIGIN_OETH_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([otherFunction.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: implementation }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects malformed dynamic-array offsets, padding, trailing data and unknown selectors', async () => {
    const fn = ORIGIN_OETH_CAPABILITIES.find((candidate) => candidate.functionName === 'claimWithdrawals')!;
    const valid = call(fn);
    const offset = `${valid.data.slice(0, 10)}${'0'.repeat(63)}21${valid.data.slice(74)}`;
    for (const data of [offset, `${valid.data}00`, `0xdeadbeef${valid.data.slice(10)}`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
    }
    await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId]))).resolves.toBeDefined();
  });
});

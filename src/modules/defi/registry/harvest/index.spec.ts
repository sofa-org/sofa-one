import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildHarvestRegistry, HARVEST_CAPABILITIES } from './index';

const target = '0xf0358e8c3CD5Fa238a29301d0bEa3D63A17bEdBE';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildHarvestRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'harvest-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const call = (fn: DefiFunctionPolicy, amount = max, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [amount] }), ...(value === undefined ? {} : { value }) });

describe('Harvest fUSDC Ethereum vault fixture', () => {
  it('binds exactly two inactive source declarations to full ABI hashes, IDs and valid references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/harvest.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('harvest');
    expect(family.familyVersion).toBe('v1@14420a44');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Harvest Ethereum fUSDC Vault' });
    expect(source.sources).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.abiFunctions).toHaveLength(2);
    expect(HARVEST_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability, fn.abi.outputs])).toEqual([
      ['deposit', `harvest:v1:1:${target.toLowerCase()}:deposit`, 'deposit(uint256)', 'nonpayable', []],
      ['withdraw', `harvest:v1:1:${target.toLowerCase()}:withdraw`, 'withdraw(uint256)', 'nonpayable', []],
    ]);
    for (const fn of HARVEST_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.abi.inputs).toEqual([{ name: fn.functionName === 'deposit' ? 'amountWei' : 'numberOfShares', type: 'uint256', internalType: 'uint256' }]);
      expect(fn.status).toBe('active');
    }
    expect(new Set(HARVEST_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(2);
  });

  it('allows only the exact explicit function grant; empty grants deny, uint256 maximum is accepted, and value is rejected', async () => {
    for (const fn of HARVEST_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates the two methods, chain and exact contract target', async () => {
    for (const fn of HARVEST_CAPABILITIES) {
      const otherFunction = HARVEST_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([otherFunction.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects unknown selectors and noncanonical trailing or truncated calldata', async () => {
    const fn = HARVEST_CAPABILITIES[0];
    const valid = call(fn);
    for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });
});

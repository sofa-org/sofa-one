import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildLombardStakedLbtcRegistry, LOMBARD_STAKED_LBTC_CAPABILITIES } from './index';

const proxy = '0x8236a87084f8B84306F72007F36F2618A5634494';
const implementation = '0x072072317469ebB6C340a47e41561C9C3b782BD9';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const sampleScript = `0x0014${'12'.repeat(20)}` as const;
const fragment = buildLombardStakedLbtcRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'lombard-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy, script: `0x${string}` = sampleScript): readonly (`0x${string}` | bigint)[] => fn.functionName === 'redeemForBtc' ? [script, max] : [max];
const call = (fn: DefiFunctionPolicy, value?: bigint, args = argsFor(fn)) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), ...(value === undefined ? {} : { value }) });

describe('Lombard Ethereum LBTC proxy fixture', () => {
  it('binds two inactive source declarations to exact ABI hashes, stable IDs and strict resolved references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/lombard.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'lombard', familyVersion: 'staked-lbtc-v1' });
    expect(contract).toMatchObject({ chainId: 1, address: proxy, status: 'inactive', contractName: 'Lombard LBTC proxy' });
    expect(source.sources).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.sourceRefs).toEqual(expect.arrayContaining([...sourceIds]));
    expect(contract.abiFunctions).toHaveLength(2);
    expect(LOMBARD_STAKED_LBTC_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['redeemForBtc', `lombard:staked-lbtc-v1:1:${proxy.toLowerCase()}:redeem-for-btc`, 'redeemForBtc(bytes,uint256)', 'nonpayable'],
      ['redeem', `lombard:staked-lbtc-v1:1:${proxy.toLowerCase()}:redeem`, 'redeem(uint256)', 'nonpayable'],
    ]);
    for (const fn of LOMBARD_STAKED_LBTC_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(LOMBARD_STAKED_LBTC_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).toEqual(['0x30b93d85', '0xdb006a75']);
    expect(contract.address.toLowerCase()).not.toBe(implementation.toLowerCase());
  });

  it('allows only exact grants, denies empty grants, accepts max uint and rejects native value', async () => {
    for (const fn of LOMBARD_STAKED_LBTC_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates method, chain and exact proxy target, and rejects the implementation target', async () => {
    for (const fn of LOMBARD_STAKED_LBTC_CAPABILITIES) {
      const another = LOMBARD_STAKED_LBTC_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([another.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: implementation }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('accepts ABI-valid max amounts with varied caller-selected Bitcoin script bytes', async () => {
    const fn = LOMBARD_STAKED_LBTC_CAPABILITIES.find((candidate) => candidate.functionName === 'redeemForBtc')!;
    for (const script of [sampleScript, '0xdeadbeef', '0x'] as const) {
      await expect(policy.authorizeContractCalls([call(fn, undefined, [script, max])], context([fn.capabilityId]))).resolves.toBeDefined();
    }
    const redeem = LOMBARD_STAKED_LBTC_CAPABILITIES.find((candidate) => candidate.functionName === 'redeem')!;
    await expect(policy.authorizeContractCalls([call(redeem)], context([redeem.capabilityId]))).resolves.toBeDefined();
  });

  it('rejects malformed bytes offsets, nonzero dynamic padding, trailing/truncated data and unknown selectors', async () => {
    const fn = LOMBARD_STAKED_LBTC_CAPABILITIES.find((candidate) => candidate.functionName === 'redeemForBtc')!;
    const valid = call(fn);
    const invalidOffset = `${valid.data.slice(0, 10)}${'0'.repeat(62)}60${valid.data.slice(74)}`;
    const invalidPadding = `${valid.data.slice(0, -2)}01`;
    for (const data of [invalidOffset, invalidPadding, `${valid.data}00`, valid.data.slice(0, -2), `0xdeadbeef${valid.data.slice(10)}`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });
});

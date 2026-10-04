import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildIdleRegistry, IDLE_CAPABILITIES } from './index';

const target = '0x493C57C4763932315A328269E1ADaD09653B9081';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildIdleRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'idle-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy) => fn.functionName === 'mintIdleToken' ? [max, true, other] as const : [max] as const;
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn) as never }), ...(value === undefined ? {} : { value }) });

describe('Idle iDAI Ethereum fixture', () => {
  it('binds exactly the two source declarations to full ABI hashes, stable IDs and valid references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/idle.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'idle', familyVersion: 'v3-1@70b31e6e' });
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Idle Ethereum iDAI' });
    expect(source.sources).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.abiFunctions).toHaveLength(2);
    expect(IDLE_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['mintIdleToken', `idle:v3-1:1:${target.toLowerCase()}:mint-idle-token`, 'mintIdleToken(uint256,bool,address)', 'nonpayable'],
      ['redeemIdleToken', `idle:v3-1:1:${target.toLowerCase()}:redeem-idle-token`, 'redeemIdleToken(uint256)', 'nonpayable'],
    ]);
    for (const fn of IDLE_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(IDLE_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(2);
  });

  it('allows only exact grants, denies empty grants, accepts max uint and rejects native value', async () => {
    for (const fn of IDLE_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates function, chain and exact contract target', async () => {
    for (const fn of IDLE_CAPABILITIES) {
      const otherFunction = IDLE_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([otherFunction.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects noncanonical bool/address words and trailing calldata while permitting arbitrary referral', async () => {
    const fn = IDLE_CAPABILITIES[0];
    const valid = call(fn);
    await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId]))).resolves.toBeDefined();
    const noncanonicalBool = `${valid.data.slice(0, 74)}${'0'.repeat(63)}2${valid.data.slice(138)}`;
    const noncanonicalAddress = `${valid.data.slice(0, 138)}${'1'.repeat(24)}${valid.data.slice(162)}`;
    for (const data of [noncanonicalBool, noncanonicalAddress, `${valid.data}00`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });
});

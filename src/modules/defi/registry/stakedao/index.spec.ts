import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildStakeDaoCrvDepositorRegistry, STAKEDAO_CRV_DEPOSITOR_CAPABILITIES } from './index';

const target = '0xc1e3Ca8A3921719bE0aE3690A0e036feB4f69191';
const gauge = '0x7f50786A0b15723D741727882ee99a0BF34e3466';
const other = '0x1111111111111111111111111111111111111111';
const arbitraryUser = '0x2222222222222222222222222222222222222222';
const max = (1n << 256n) - 1n;
const fragment = buildStakeDaoCrvDepositorRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'stakedao-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy, lock = true, stake = true, user: `0x${string}` = arbitraryUser): readonly (bigint | boolean | `0x${string}`)[] => fn.functionName === 'deposit' ? [max, lock, stake, user] : [lock, stake, user];
const call = (fn: DefiFunctionPolicy, args = argsFor(fn), value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), ...(value === undefined ? {} : { value }) });

describe('StakeDAO CRV Depositor Ethereum fixture', () => {
  it('binds the two selected declarations to exact full ABI hashes, stable IDs, inactive source and resolved strict refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/stakedao.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'stakedao', familyVersion: 'crv-depositor-v1' });
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'StakeDAO CRV Depositor' });
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.abiFunctions).toHaveLength(2);
    expect(contract.sourceRefs).toEqual(expect.arrayContaining([...sourceIds]));
    expect(STAKEDAO_CRV_DEPOSITOR_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['deposit', `stakedao:crv-depositor-v1:1:${target.toLowerCase()}:deposit`, 'deposit(uint256,bool,bool,address)', 'nonpayable'],
      ['depositAll', `stakedao:crv-depositor-v1:1:${target.toLowerCase()}:deposit-all`, 'depositAll(bool,bool,address)', 'nonpayable'],
    ]);
    for (const fn of STAKEDAO_CRV_DEPOSITOR_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(STAKEDAO_CRV_DEPOSITOR_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(2);
    expect(contract.address.toLowerCase()).not.toBe(gauge.toLowerCase());
  });

  it('requires each exact explicit grant, denies empty grants and rejects native value', async () => {
    for (const fn of STAKEDAO_CRV_DEPOSITOR_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, argsFor(fn), 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates method, chain, exact target and selector', async () => {
    for (const fn of STAKEDAO_CRV_DEPOSITOR_CAPABILITIES) {
      const otherFunction = STAKEDAO_CRV_DEPOSITOR_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([otherFunction.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: gauge }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('accepts max amounts, all boolean choices and caller-selected nonzero beneficiaries', async () => {
    for (const fn of STAKEDAO_CRV_DEPOSITOR_CAPABILITIES) {
      for (const lock of [false, true]) for (const stake of [false, true]) {
        const args = argsFor(fn, lock, stake, arbitraryUser);
        await expect(policy.authorizeContractCalls([call(fn, args)], context([fn.capabilityId]))).resolves.toBeDefined();
      }
      const otherBeneficiary = argsFor(fn, false, false, '0x3333333333333333333333333333333333333333');
      await expect(policy.authorizeContractCalls([call(fn, otherBeneficiary)], context([fn.capabilityId]))).resolves.toBeDefined();
    }
  });

  it('rejects noncanonical bool/address padding and trailing calldata', async () => {
    const fn = STAKEDAO_CRV_DEPOSITOR_CAPABILITIES[0];
    const valid = call(fn);
    const invalidLock = `${valid.data.slice(0, 74)}${'0'.repeat(63)}2${valid.data.slice(138)}`;
    const invalidAddress = `${valid.data.slice(0, 202)}${'1'.repeat(24)}${valid.data.slice(226)}`;
    for (const data of [invalidLock, invalidAddress, `${valid.data}00`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });
});

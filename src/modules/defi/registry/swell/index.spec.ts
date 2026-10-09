import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildSwellRegistry, SWELL_CAPABILITIES } from './index';

const swETH = '0xf951E335afb289353dc249e82926178EaC7DEd78';
const rswETH = '0xfAe103DC9cf190eD75350761e95403b7b8aFa6c0';
const referral = '0x1111111111111111111111111111111111111111';
const arbitraryReferral = '0x00000000000000000000000000000000000000c3';
const fragment = buildSwellRegistry();
const contracts = fragment.chains[0].contracts;
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'swell-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: referral, allowedCapabilityIds: grants });
const call = (fn: DefiFunctionPolicy, args: readonly unknown[] = fn.functionName === 'deposit' ? [] : [referral], value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), ...(value === undefined ? {} : { value }) });

describe('Swell Ethereum deposit fixture', () => {
  it('matches all four inactive source ABIs, hashes, deployment/interface references and stable IDs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/swell.json', 'utf8'));
    const family = source.families[0];
    const rawContracts = family.contracts;
    const rawFunctions = rawContracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract, abi })));
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('swell');
    expect(family.familyVersion).toBe('v3-core@5827c4f1');
    expect(rawContracts.map((contract: any) => contract.address)).toEqual([swETH, rswETH]);
    expect(rawContracts.every((contract: any) => contract.chainId === 1 && contract.status === 'inactive')).toBe(true);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(SWELL_CAPABILITIES).toHaveLength(4);
    expect(rawFunctions).toHaveLength(4);
    expect(contracts.map((contract) => contract.address)).toEqual([swETH, rswETH]);
    expect(SWELL_CAPABILITIES.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    for (const fn of SWELL_CAPABILITIES) {
      const rawContract = rawContracts.find((contract: any) => contract.address.toLowerCase() === fn.contract.toLowerCase());
      const raw = rawContract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(rawContract.sourceRefs).toContain('swell-official-deployments');
      expect(rawContract.sourceRefs).toContain(sourceId);
      expect(fn.abi.stateMutability).toBe('payable');
      expect(fn.abi.outputs).toEqual([]);
      expect(fn.capabilityId).toBe(`swell:v1:1:${fn.contract.toLowerCase()}:${fn.functionName === 'deposit' ? 'deposit' : 'deposit-with-referral'}`);
      expect(fn.signature).toBe(fn.functionName === 'deposit' ? 'deposit()' : 'depositWithReferral(address)');
    }
    expect(SWELL_CAPABILITIES.map((fn) => [fn.contract, fn.functionName])).toEqual([
      [swETH, 'deposit'], [swETH, 'depositWithReferral'], [rswETH, 'deposit'], [rswETH, 'depositWithReferral'],
    ]);
    expect(SWELL_CAPABILITIES.find((fn) => fn.contract === swETH && fn.functionName === 'depositWithReferral')?.abi.inputs).toEqual([{ name: 'referral', type: 'address', internalType: 'address' }]);
    expect(new Set(SWELL_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(4);
  });

  it('requires each exact grant and permits payable value and arbitrary ABI-valid referral independently', async () => {
    for (const fn of SWELL_CAPABILITIES) {
      const args = fn.functionName === 'deposit' ? [] : [arbitraryReferral];
      await expect(policy.authorizeContractCalls([call(fn, args, 17n)], context([fn.capabilityId]))).resolves.toMatchObject({
        matches: [{ capabilityId: fn.capabilityId }], interactions: [{ value: '17' }], executionPlan: [{ path: [0] }],
      });
      await expect(policy.authorizeContractCalls([call(fn, args, 17n)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });

  it('does not share grants across targets, overloads, or chains', async () => {
    const swDeposit = SWELL_CAPABILITIES.find((fn) => fn.contract === swETH && fn.functionName === 'deposit')!;
    const rswDeposit = SWELL_CAPABILITIES.find((fn) => fn.contract === rswETH && fn.functionName === 'deposit')!;
    const swReferral = SWELL_CAPABILITIES.find((fn) => fn.contract === swETH && fn.functionName === 'depositWithReferral')!;
    const rswReferral = SWELL_CAPABILITIES.find((fn) => fn.contract === rswETH && fn.functionName === 'depositWithReferral')!;
    await expect(policy.authorizeContractCalls([call(rswDeposit)], context([swDeposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(swReferral)], context([swDeposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(swDeposit)], context([swReferral.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(rswReferral)], context([swReferral.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(swDeposit)], context([swDeposit.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  });

  it('rejects unknown selectors, noncanonical address padding, and trailing bytes', async () => {
    const fn = SWELL_CAPABILITIES.find((item) => item.contract === swETH && item.functionName === 'depositWithReferral')!;
    const valid = call(fn);
    const malformedAddress = `${valid.data.slice(0, 10)}${'f'.repeat(24)}${valid.data.slice(34)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...valid, data: `0xdeadbeef${valid.data.slice(10)}` }], context([fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...valid, data: malformedAddress }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...valid, data: `${valid.data}00` }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});

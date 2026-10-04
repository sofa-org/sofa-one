import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildLiquityV2Registry, LIQUITY_V2_CAPABILITIES } from './index';

const borrower = '0x372abd1810eaf23cb9d941bbe7596dfb2c46bc65';
const stability = '0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf';
const anyone = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const fragment = buildLiquityV2Registry();
const contracts = fragment.chains[0].contracts;
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'liquity-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: anyone, allowedCapabilityIds: grants });
function args(fn: DefiFunctionPolicy): readonly unknown[] {
  switch (fn.functionName) {
    case 'openTrove': return [other, maxUint256, maxUint256, maxUint256, maxUint256, maxUint256, maxUint256, maxUint256, anyone, other, anyone];
    case 'addColl': case 'withdrawColl': case 'repayBold': return [maxUint256, maxUint256];
    case 'withdrawBold': return [maxUint256, maxUint256, maxUint256];
    case 'adjustTrove': return [maxUint256, maxUint256, true, maxUint256, false, maxUint256];
    case 'closeTrove': return [maxUint256];
    case 'provideToSP': case 'withdrawFromSP': return [maxUint256, true];
    case 'claimAllCollGains': return [];
    default: throw new Error(`Unexpected Liquity method ${fn.functionName}`);
  }
}
function call(fn: DefiFunctionPolicy, values = args(fn), value?: bigint) { return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), ...(value === undefined ? {} : { value }) }; }

describe('Liquity V2 Ethereum WETH-branch fixture', () => {
  it('matches all ten raw inactive ABIs, source refs, IDs and signatures', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/liquity.json', 'utf8'));
    const family = source.families[0];
    const raw = family.contracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract: contract.address, abi })));
    expect(family.familyId).toBe('liquity-v2');
    expect(family.familyVersion).toBe('v2-weth');
    expect(family.contracts.map((c: any) => c.address)).toEqual([borrower, stability]);
    expect(family.contracts.every((c: any) => c.status === 'inactive')).toBe(true);
    expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(raw).toHaveLength(10);
    expect(LIQUITY_V2_CAPABILITIES).toHaveLength(10);
    for (const fn of LIQUITY_V2_CAPABILITIES) {
      const contract = family.contracts.find((c: any) => c.address === fn.contract)!;
      const entry = contract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      const { sourceId, ...abi } = entry;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(source.sources.some((s: any) => s.sourceId === sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.capabilityId).toBe(`liquity-v2:v2-weth:1:${fn.contract.toLowerCase()}:${fn.operation}`);
      expect(fn.signature).toBe(`${fn.functionName}(${fn.abi.inputs.map(({ type }) => type).join(',')})`);
      expect([...fn.abi.inputs, ...fn.abi.outputs].every((p) => p.internalType === p.type)).toBe(true);
      expect(fn.abi.stateMutability).toBe('nonpayable');
    }
    expect(LIQUITY_V2_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.abi.outputs])).toEqual([
      ['openTrove', 'openTrove(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,address)', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['addColl', 'addColl(uint256,uint256)', []], ['withdrawColl', 'withdrawColl(uint256,uint256)', []],
      ['withdrawBold', 'withdrawBold(uint256,uint256,uint256)', []], ['repayBold', 'repayBold(uint256,uint256)', []],
      ['adjustTrove', 'adjustTrove(uint256,uint256,bool,uint256,bool,uint256)', []], ['closeTrove', 'closeTrove(uint256)', []],
      ['provideToSP', 'provideToSP(uint256,bool)', []], ['withdrawFromSP', 'withdrawFromSP(uint256,bool)', []], ['claimAllCollGains', 'claimAllCollGains()', []],
    ]);
    expect(new Set(LIQUITY_V2_CAPABILITIES.map((fn) => fn.capabilityId)).size).toBe(10);
    expect(new Set(LIQUITY_V2_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(10);
  });
  it('authorizes each method only under its exact explicit grant and accepts caller-selected ABI extremes', async () => {
    for (const fn of LIQUITY_V2_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, args(fn), 1n)], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
  it('isolates method, target and chain grants', async () => {
    const open = LIQUITY_V2_CAPABILITIES.find((fn) => fn.functionName === 'openTrove')!;
    const deposit = LIQUITY_V2_CAPABILITIES.find((fn) => fn.functionName === 'provideToSP')!;
    await expect(policy.authorizeContractCalls([call(deposit)], context([open.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(open)], context([open.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...call(open), to: stability }], context([open.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(open), data: `0xdeadbeef${call(open).data.slice(10)}` }], context([open.capabilityId]))).rejects.toBeDefined();
  });
  it('requires canonical ABI encoding and rejects address padding, trailing and truncated calldata', async () => {
    const fn = LIQUITY_V2_CAPABILITIES.find((item) => item.functionName === 'openTrove')!;
    const valid = call(fn);
    const badAddressPadding = `${valid.data.slice(0, 10)}${'f'.repeat(24)}${valid.data.slice(34)}` as `0x${string}`;
    for (const data of [`${valid.data}00`, valid.data.slice(0, -2), badAddressPadding]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});

import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildExactlyRegistry, EXACTLY_CAPABILITIES } from './index';

const marketUSDC = '0x6926B434CCe9b5b7966aE1BfEef6D0A7DCF3A8bb';
const marketWETH = '0xc4d4500326981eacD020e20A81b1c479c161c7EF';
const auditor = '0xaEb62e6F27BC103702E7BC879AE98bceA56f027E';
const receiver = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const max = maxUint256;
const expectedMethods = [
  ['deposit', 'deposit(uint256,address)', [['assets', 'uint256'], ['receiver', 'address']], [['shares', 'uint256']]],
  ['mint', 'mint(uint256,address)', [['shares', 'uint256'], ['receiver', 'address']], [['assets', 'uint256']]],
  ['withdraw', 'withdraw(uint256,address,address)', [['assets', 'uint256'], ['receiver', 'address'], ['owner', 'address']], [['shares', 'uint256']]],
  ['redeem', 'redeem(uint256,address,address)', [['shares', 'uint256'], ['receiver', 'address'], ['owner', 'address']], [['assets', 'uint256']]],
  ['borrow', 'borrow(uint256,address,address)', [['assets', 'uint256'], ['receiver', 'address'], ['borrower', 'address']], [['borrowShares', 'uint256']]],
  ['repay', 'repay(uint256,address)', [['assets', 'uint256'], ['borrower', 'address']], [['actualRepay', 'uint256'], ['borrowShares', 'uint256']]],
  ['depositAtMaturity', 'depositAtMaturity(uint256,uint256,uint256,address)', [['maturity', 'uint256'], ['assets', 'uint256'], ['minAssetsRequired', 'uint256'], ['receiver', 'address']], [['positionAssets', 'uint256']]],
  ['borrowAtMaturity', 'borrowAtMaturity(uint256,uint256,uint256,address,address)', [['maturity', 'uint256'], ['assets', 'uint256'], ['maxAssets', 'uint256'], ['receiver', 'address'], ['borrower', 'address']], [['assetsOwed', 'uint256']]],
  ['withdrawAtMaturity', 'withdrawAtMaturity(uint256,uint256,uint256,address,address)', [['maturity', 'uint256'], ['positionAssets', 'uint256'], ['minAssetsRequired', 'uint256'], ['receiver', 'address'], ['owner', 'address']], [['assetsDiscounted', 'uint256']]],
  ['repayAtMaturity', 'repayAtMaturity(uint256,uint256,uint256,address)', [['maturity', 'uint256'], ['positionAssets', 'uint256'], ['maxAssets', 'uint256'], ['borrower', 'address']], [['actualRepayAssets', 'uint256']]],
] as const;

const fragment = buildExactlyRegistry();
const contracts = fragment.chains[0].contracts;
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 10): DefiExecutionContext => ({ userId: 'exactly-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: receiver, allowedCapabilityIds: grants });
const marketFunctions = (contract: string) => contracts.find((item) => item.address === contract)!.functions;
function args(fn: DefiFunctionPolicy): readonly unknown[] {
  switch (fn.functionName) {
    case 'deposit': case 'mint': return [max, receiver];
    case 'withdraw': case 'redeem': return [max, receiver, owner];
    case 'borrow': return [max, receiver, owner];
    case 'repay': return [max, owner];
    case 'depositAtMaturity': return [max, max, max, receiver];
    case 'borrowAtMaturity': return [max, max, max, receiver, owner];
    case 'withdrawAtMaturity': return [max, max, max, receiver, owner];
    case 'repayAtMaturity': return [max, max, max, owner];
    case 'enterMarket': case 'exitMarket': return [marketWETH];
    default: throw new Error(`Unexpected Exactly method ${fn.functionName}`);
  }
}
function call(fn: DefiFunctionPolicy, values: readonly unknown[] = args(fn), value?: bigint) {
  return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), ...(value === undefined ? {} : { value }) };
}

describe('Exactly OP Mainnet source-qualified fixture', () => {
  it('binds all 22 inactive source declarations, exact ABI hashes, target provenance, IDs, and return units', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/exactly.json', 'utf8'));
    const family = source.families[0];
    const rawContracts = family.contracts;
    const rawFunctions = rawContracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract: contract.address, abi })));
    const sources = new Map(source.sources.map((record: any) => [record.sourceId, record]));
    expect(family.familyId).toBe('exactly');
    expect(family.familyVersion).toBe('protocol@4b5fec78');
    expect(rawContracts.map((contract: any) => contract.address)).toEqual([marketUSDC, marketWETH, auditor]);
    expect(rawContracts.every((contract: any) => contract.status === 'inactive')).toBe(true);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(source.sources.every((record: any) => /^https:\/\//.test(record.url))).toBe(true);
    expect(EXACTLY_CAPABILITIES).toHaveLength(22);
    expect(rawFunctions).toHaveLength(22);
    expect(contracts.map((contract) => contract.address)).toEqual([marketUSDC, marketWETH, auditor]);
    for (const fixture of EXACTLY_CAPABILITIES) {
      const contract = rawContracts.find((item: any) => item.address.toLowerCase() === fixture.contract.toLowerCase());
      const raw = contract.abiFunctions.find((item: any) => item.name === fixture.functionName);
      expect(fixture.status).toBe('active');
      expect(fixture.provenance.status).toBe('verified');
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fixture.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fixture));
      expect(sources.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fixture.abi.stateMutability).toBe('nonpayable');
      expect(fixture.capabilityId).toBe(`exactly:v1:10:${fixture.contract.toLowerCase()}:${fixture.operation}`);
      expect(fixture.signature).toBe(`${fixture.functionName}(${fixture.abi.inputs.map(({ type }) => type).join(',')})`);
    }
    for (const target of [marketUSDC, marketWETH]) {
      const methods = marketFunctions(target);
      expect(methods).toHaveLength(10);
      expect(methods.map((fn) => [fn.functionName, fn.signature])).toEqual(expectedMethods.map(([name, signature]) => [name, signature]));
      for (const [name, , inputPairs, outputPairs] of expectedMethods) {
        const fn = methods.find((item) => item.functionName === name)!;
        expect(fn.abi.inputs.map(({ name: n, type }) => [n, type])).toEqual(inputPairs);
        expect(fn.abi.outputs.map(({ name: n, type }) => [n, type])).toEqual(outputPairs);
        expect(fn.abi.inputs.every((param) => param.internalType === param.type)).toBe(true);
        expect(fn.abi.outputs.every((param) => param.internalType === param.type)).toBe(true);
      }
    }
    const auditorMethods = contracts[2].functions;
    expect(auditorMethods.map((fn) => [fn.functionName, fn.signature, fn.abi.outputs])).toEqual([
      ['enterMarket', 'enterMarket(address)', []], ['exitMarket', 'exitMarket(address)', []],
    ]);
    expect(auditorMethods.every((fn) => fn.abi.inputs[0].internalType === 'contract Market')).toBe(true);
    expect(new Set(EXACTLY_CAPABILITIES.map((fn) => fn.capabilityId)).size).toBe(22);
    expect(new Set(EXACTLY_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(22);
  });

  it('authorizes every one of the 22 functions only with its exact explicit grant and accepts caller-selected maxuint values', async () => {
    for (const fn of EXACTLY_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, args(fn), 1n)], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('does not share same-selector market grants or function grants and denies wrong chain/target/selector', async () => {
    const usdcDeposit = marketFunctions(marketUSDC).find((fn) => fn.functionName === 'deposit')!;
    const wethDeposit = marketFunctions(marketWETH).find((fn) => fn.functionName === 'deposit')!;
    await expect(policy.authorizeContractCalls([call(wethDeposit)], context([usdcDeposit.capabilityId]))).rejects.toBeDefined();
    const borrow = marketFunctions(marketUSDC).find((fn) => fn.functionName === 'borrow')!;
    await expect(policy.authorizeContractCalls([call(borrow)], context([usdcDeposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(usdcDeposit)], context([usdcDeposit.capabilityId], 1))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...call(usdcDeposit), to: receiver }], context([usdcDeposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(usdcDeposit), data: `0xdeadbeef${call(usdcDeposit).data.slice(10)}` }], context([usdcDeposit.capabilityId]))).rejects.toBeDefined();
  });

  it('requires canonical calldata including address padding and rejects trailing or truncated bytes', async () => {
    const fn = marketFunctions(marketUSDC).find((item) => item.functionName === 'deposit')!;
    const valid = call(fn);
    const data = valid.data;
    const badAddressPadding = `${data.slice(0, 10 + 64)}${'f'.repeat(24)}${data.slice(10 + 64 + 24)}` as `0x${string}`;
    for (const malformed of [`${data}00`, data.slice(0, -2), badAddressPadding]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data: malformed }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});

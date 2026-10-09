import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { AJNA_ERC20_POOL_CAPABILITIES, buildAjnaErc20PoolRegistry } from './index';

const pool = '0x9cdb48fcbd8241bb75887af04d3b1302c410f671';
const factory = '0x6146DD43C5622bB6D12A5240ab9CF4de14eDC625';
const borrower = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const max = (1n << 256n) - 1n;
const fragment = buildAjnaErc20PoolRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'ajna-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy): readonly (bigint | `0x${string}`)[] => {
  switch (fn.functionName) {
    case 'addQuoteToken': case 'addCollateral': return [max, max, max];
    case 'removeQuoteToken': case 'removeCollateral': return [max, max];
    case 'drawDebt': return [borrower, max, max, max];
    case 'repayDebt': return [borrower, max, max, recipient, max];
    default: throw new Error(`Unexpected Ajna operation ${fn.functionName}`);
  }
};
const call = (fn: DefiFunctionPolicy, value?: bigint, args = argsFor(fn)) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), ...(value === undefined ? {} : { value }) });

describe('Ajna Ethereum rETH/DAI ERC20 pool fixture', () => {
  it('binds six inactive source declarations to exact ABI hashes, stable IDs and strict resolved references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/ajna.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'ajna', familyVersion: 'erc20-v1' });
    expect(contract).toMatchObject({ chainId: 1, address: pool, status: 'inactive', contractName: 'Ajna Ethereum rETH/DAI ERC20 Pool' });
    expect(source.sources).toHaveLength(5);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.sourceRefs).toEqual(expect.arrayContaining([...sourceIds]));
    expect(contract.abiFunctions).toHaveLength(6);
    expect(AJNA_ERC20_POOL_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['addQuoteToken', `ajna:erc20-v1:1:${pool}:add-quote-token`, 'addQuoteToken(uint256,uint256,uint256)', 'nonpayable'],
      ['removeQuoteToken', `ajna:erc20-v1:1:${pool}:remove-quote-token`, 'removeQuoteToken(uint256,uint256)', 'nonpayable'],
      ['addCollateral', `ajna:erc20-v1:1:${pool}:add-collateral`, 'addCollateral(uint256,uint256,uint256)', 'nonpayable'],
      ['removeCollateral', `ajna:erc20-v1:1:${pool}:remove-collateral`, 'removeCollateral(uint256,uint256)', 'nonpayable'],
      ['drawDebt', `ajna:erc20-v1:1:${pool}:draw-debt`, 'drawDebt(address,uint256,uint256,uint256)', 'nonpayable'],
      ['repayDebt', `ajna:erc20-v1:1:${pool}:repay-debt`, 'repayDebt(address,uint256,uint256,address,uint256)', 'nonpayable'],
    ]);
    for (const fn of AJNA_ERC20_POOL_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    const repay = AJNA_ERC20_POOL_CAPABILITIES.find((fn) => fn.functionName === 'repayDebt')!;
    expect(repay.abi.inputs[3]).toEqual({ name: 'collateralReceiver_', type: 'address', internalType: 'address' });
    expect(repay.abi.inputs[3].name).not.toBe('recipient_');
    expect(new Set(AJNA_ERC20_POOL_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(6);
  });

  it('requires each exact grant, denies empty grants, accepts max uint values and rejects native value', async () => {
    for (const fn of AJNA_ERC20_POOL_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates exact function, selector, pool target and chain; factory itself is not authorized', async () => {
    for (const fn of AJNA_ERC20_POOL_CAPABILITIES) {
      const another = AJNA_ERC20_POOL_CAPABILITIES.find((candidate) => candidate.functionName !== fn.functionName)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([another.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: factory }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('keeps borrower and repayment recipient caller-selected without owner coupling', async () => {
    const draw = AJNA_ERC20_POOL_CAPABILITIES.find((fn) => fn.functionName === 'drawDebt')!;
    const repay = AJNA_ERC20_POOL_CAPABILITIES.find((fn) => fn.functionName === 'repayDebt')!;
    const arbitraryBorrower = [recipient, max, max, max] as const;
    const arbitraryRepayment = [recipient, max, max, borrower, max] as const;
    await expect(policy.authorizeContractCalls([call(draw, undefined, arbitraryBorrower)], context([draw.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(repay, undefined, arbitraryRepayment)], context([repay.capabilityId]))).resolves.toBeDefined();
  });

  it('rejects noncanonical address padding, trailing/truncated calldata and unknown selectors', async () => {
    for (const fnName of ['drawDebt', 'repayDebt']) {
      const fn = AJNA_ERC20_POOL_CAPABILITIES.find((candidate) => candidate.functionName === fnName)!;
      const valid = call(fn);
      const addressWord = fnName === 'drawDebt' ? 10 : 202;
      const invalidAddress = `${valid.data.slice(0, addressWord)}${'1'.repeat(24)}${valid.data.slice(addressWord + 24)}`;
      for (const data of [invalidAddress, `${valid.data}00`, valid.data.slice(0, -2), `0xdeadbeef${valid.data.slice(10)}`]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});

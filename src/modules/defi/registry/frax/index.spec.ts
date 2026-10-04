import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildFraxRegistry, FRAX_CAPABILITIES } from './index';

const minter = '0x7Bc6bad540453360F744666D625fec0ee1320cA3';
const vault = '0xac3E018457B222d93114458476f3E3416Abbe38F';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildFraxRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'frax-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });

function argsFor(fn: DefiFunctionPolicy, amount = max): readonly unknown[] {
  if (fn.contract === minter) {
    if (fn.functionName === 'mintFrxEth') return [];
    return [other];
  }
  if (fn.functionName === 'deposit' || fn.functionName === 'mint') return [amount, other];
  return [amount, other, other];
}
const call = (fn: DefiFunctionPolicy, amount = max, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn, amount) as never }), ...(value === undefined ? {} : { value }) });

describe('Frax frxETH v2 Ethereum fixture', () => {
  it('binds all seven inactive source functions to full ABI hashes, IDs and references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/frax.json', 'utf8'));
    const family = source.families[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('frax');
    expect(family.familyVersion).toBe('frxeth-v2@83dfe93b');
    expect(family.contracts.map((contract: any) => [contract.address, contract.chainId, contract.status])).toEqual([
      [minter, 1, 'inactive'], [vault, 1, 'inactive'],
    ]);
    expect(source.sources).toHaveLength(4);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(FRAX_CAPABILITIES).toHaveLength(7);
    expect(FRAX_CAPABILITIES.map((fn) => [fn.contract, fn.functionName, fn.signature, fn.abi.stateMutability, fn.abi.outputs])).toEqual([
      [minter, 'mintFrxEth', 'mintFrxEth()', 'payable', []],
      [minter, 'mintFrxEthAndGive', 'mintFrxEthAndGive(address)', 'payable', []],
      [minter, 'submitAndDeposit', 'submitAndDeposit(address)', 'payable', [{ name: '_shares', type: 'uint256', internalType: 'uint256' }]],
      [vault, 'deposit', 'deposit(uint256,address)', 'nonpayable', [{ name: 'shares', type: 'uint256', internalType: 'uint256' }]],
      [vault, 'mint', 'mint(uint256,address)', 'nonpayable', [{ name: 'assets', type: 'uint256', internalType: 'uint256' }]],
      [vault, 'withdraw', 'withdraw(uint256,address,address)', 'nonpayable', [{ name: 'shares', type: 'uint256', internalType: 'uint256' }]],
      [vault, 'redeem', 'redeem(uint256,address,address)', 'nonpayable', [{ name: 'assets', type: 'uint256', internalType: 'uint256' }]],
    ]);
    for (const fn of FRAX_CAPABILITIES) {
      const contract = family.contracts.find((candidate: any) => candidate.address === fn.contract);
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName && entry.inputs.length === fn.abi.inputs.length);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(FRAX_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(7);
  });

  it('requires exact grants, accepts payable minter calls and rejects value on nonpayable vault calls', async () => {
    for (const fn of FRAX_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, max)], context([fn.capabilityId]))).resolves.toBeDefined();
      if (fn.abi.stateMutability === 'payable') {
        await expect(policy.authorizeContractCalls([call(fn, max, 17n)], context([fn.capabilityId]))).resolves.toMatchObject({ interactions: [{ value: '17' }] });
      } else {
        await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });

  it('isolates every function, target and chain', async () => {
    for (const fn of FRAX_CAPABILITIES) {
      for (const otherFn of FRAX_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      const wrongTarget = fn.contract === minter ? vault : minter;
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: wrongTarget }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects noncanonical address padding, unknown selectors, trailing bytes and truncated calldata', async () => {
    for (const fn of FRAX_CAPABILITIES.filter((candidate) => candidate.abi.inputs.some((input) => input.type === 'address'))) {
      const valid = call(fn);
      const addressWordIndex = fn.contract === vault ? 74 : 10;
      const malformedAddress = `${valid.data.slice(0, addressWordIndex)}${'1'.repeat(24)}${valid.data.slice(addressWordIndex + 24)}`;
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2), malformedAddress]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
    const noArgs = FRAX_CAPABILITIES.find((fn) => fn.functionName === 'mintFrxEth')!;
    await expect(policy.authorizeContractCalls([{ ...call(noArgs), data: `${call(noArgs).data}00` }], context([noArgs.capabilityId]))).rejects.toBeDefined();
  });
});

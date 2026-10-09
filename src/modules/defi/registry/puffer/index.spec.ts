import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildPufferRegistry, PUFFER_CAPABILITIES } from './index';

const vault = '0xD9A442856C234a39a81a089C06451EBAa4306a72';
const manager = '0xDdA0483184E75a5579ef9635ED14BacCf9d50283';
const receiver = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const fragment = buildPufferRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'puffer-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: receiver, allowedCapabilityIds: grants });
function args(fn: DefiFunctionPolicy): readonly unknown[] {
  switch (fn.functionName) {
    case 'deposit': case 'mint': case 'depositStETH': return [maxUint256, receiver];
    case 'depositETH': return [receiver];
    case 'withdraw': case 'redeem': return [maxUint256, receiver, owner];
    case 'requestWithdrawal': return [(1n << 128n) - 1n, owner];
    default: throw new Error(`Unexpected Puffer method ${fn.functionName}`);
  }
}
function call(fn: DefiFunctionPolicy, values = args(fn), value?: bigint) { return { to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), ...(value === undefined ? {} : { value }) }; }

describe('Puffer Ethereum listed-implementation test fixture', () => {
  it('matches all seven raw candidate ABIs, refs, IDs and selectors exactly', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/puffer.json', 'utf8'));
    const family = source.families[0];
    const raw = family.contracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract: contract.address, abi })));
    expect(family.familyVersion).toBe('listed-impl-v5');
    expect(family.contracts.map((c: any) => c.address)).toEqual([vault, manager]);
    expect(family.contracts.every((c: any) => c.status === 'inactive')).toBe(true);
    expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(PUFFER_CAPABILITIES).toHaveLength(7);
    expect(raw).toHaveLength(7);
    for (const fn of PUFFER_CAPABILITIES) {
      const sourceContract = family.contracts.find((c: any) => c.address === fn.contract)!;
      const entry = sourceContract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      const { sourceId, ...abi } = entry;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(source.sources.some((s: any) => s.sourceId === sourceId)).toBe(true);
      expect(sourceContract.sourceRefs).toContain(sourceId);
      expect(fn.capabilityId).toBe(`puffer:v5-snapshot:1:${fn.contract.toLowerCase()}:${fn.operation}`);
      expect(fn.signature).toBe(`${fn.functionName}(${fn.abi.inputs.map(({ type }) => type).join(',')})`);
      expect([...fn.abi.inputs, ...fn.abi.outputs].every((p) => p.internalType === p.type)).toBe(true);
    }
    expect(PUFFER_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.abi.stateMutability, fn.abi.outputs])).toEqual([
      ['deposit', 'deposit(uint256,address)', 'nonpayable', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['mint', 'mint(uint256,address)', 'nonpayable', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['depositETH', 'depositETH(address)', 'payable', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['depositStETH', 'depositStETH(uint256,address)', 'nonpayable', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['withdraw', 'withdraw(uint256,address,address)', 'nonpayable', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['redeem', 'redeem(uint256,address,address)', 'nonpayable', [{ name: '', type: 'uint256', internalType: 'uint256' }]],
      ['requestWithdrawal', 'requestWithdrawal(uint128,address)', 'nonpayable', []],
    ]);
    expect(new Set(PUFFER_CAPABILITIES.map((fn) => fn.capabilityId)).size).toBe(7);
    expect(new Set(PUFFER_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(7);
  });
  it('requires each exact grant and authorizes ABI-extreme caller amounts independently', async () => {
    for (const fn of PUFFER_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      if (fn.functionName === 'depositETH') {
        await expect(policy.authorizeContractCalls([call(fn, args(fn), 17n)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      } else {
        await expect(policy.authorizeContractCalls([call(fn, args(fn), 1n)], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }
    const eth = PUFFER_CAPABILITIES.find((fn) => fn.functionName === 'depositETH')!;
    await expect(policy.authorizeContractCalls([call(eth, args(eth), 17n)], context([eth.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: eth.capabilityId }] });
    const queue = PUFFER_CAPABILITIES.find((fn) => fn.functionName === 'requestWithdrawal')!;
    const validQueueData = call(queue).data;
    const overflowingQueueData = `${validQueueData.slice(0, 10)}${(1n << 128n).toString(16).padStart(64, '0')}${validQueueData.slice(74)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ to: queue.contract, data: overflowingQueueData }], context([queue.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
  it('isolates grants by target, function, chain and selector', async () => {
    const deposit = PUFFER_CAPABILITIES.find((fn) => fn.functionName === 'deposit')!;
    const queue = PUFFER_CAPABILITIES.find((fn) => fn.functionName === 'requestWithdrawal')!;
    await expect(policy.authorizeContractCalls([call(queue)], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit)], context([deposit.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...call(deposit), to: manager }], context([deposit.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(deposit), data: `0xdeadbeef${call(deposit).data.slice(10)}` }], context([deposit.capabilityId]))).rejects.toBeDefined();
  });
  it('rejects noncanonical address padding, trailing and truncated calldata', async () => {
    const fn = PUFFER_CAPABILITIES.find((item) => item.functionName === 'deposit')!;
    const valid = call(fn);
    const malformedAddress = `${valid.data.slice(0, 10 + 64)}${'f'.repeat(24)}${valid.data.slice(10 + 64 + 24)}` as `0x${string}`;
    for (const data of [`${valid.data}00`, valid.data.slice(0, -2), malformedAddress]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});

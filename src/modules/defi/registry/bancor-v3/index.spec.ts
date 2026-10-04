import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildBancorV3Registry } from './index';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'bancor-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Bancor V3 source-qualified registry fixture', () => {
  const fragment = buildBancorV3Registry();
  const contract = fragment.chains[0].contracts[0];
  const functions = contract.functions;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const sampleArgs = (fn: DefiFunctionPolicy) => fn.abi.inputs.map((input) => input.type === 'address' ? C : maxUint256);
  const call = (fn: DefiFunctionPolicy, args: unknown[] = sampleArgs(fn), value?: string) => ({
    to: fn.contract,
    value,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }),
  });

  it('matches all six full pinned deployment ABI records and source-qualified inactive snapshots', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/bancor.json', 'utf8'));
    const raw = source.families.flatMap((family: any) => family.chains.flatMap((chain: any) => chain.contracts.flatMap((row: any) => row.functions)));
    expect(fragment.chains.map((chain) => [chain.chainId, chain.status])).toEqual([[1, 'active']]);
    expect(contract.address).toBe('0xeEF417e1D5CC832e619ae18D2F140De2999dD4fB');
    expect(functions.map((fn) => [fn.functionName, fn.signature, fn.abi.stateMutability])).toEqual([
      ['cancelWithdrawal', 'cancelWithdrawal(uint256)', 'nonpayable'],
      ['deposit', 'deposit(address,uint256)', 'payable'],
      ['initWithdrawal', 'initWithdrawal(address,uint256)', 'nonpayable'],
      ['tradeBySourceAmount', 'tradeBySourceAmount(address,address,uint256,uint256,uint256,address)', 'payable'],
      ['tradeByTargetAmount', 'tradeByTargetAmount(address,address,uint256,uint256,uint256,address)', 'payable'],
      ['withdraw', 'withdraw(uint256)', 'nonpayable'],
    ]);
    expect(raw).toHaveLength(6);
    expect(functions).toHaveLength(6);
    expect(source.unresolved).toEqual([]);
    expect(source.sources.every((row: object) => Object.keys(row).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(source.families[0]).toMatchObject({ familyId: 'bancor-v3', familyVersion: 'v3@97d7905b8548470e79d40ce02e09b006f555aa11' });
    raw.forEach((row: any, index: number) => {
      const fn = functions[index];
      expect(row.status).toBe('inactive');
      expect(row.provenance.status).toBe('candidate');
      expect(source.sources.some((item: any) => item.sourceId === row.provenance.sourceRef)).toBe(true);
      expect(row.abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: row.abi })).toBe(functionAbiHash(fn));
      expect(row.capabilityId).toBe(fn.capabilityId);
      expect(fn.capabilityId).toBe(`bancor-v3:v3:1:${contract.address.toLowerCase()}:${fn.operation}`);
    });
    expect(new Set(functions.map((fn) => fn.capabilityId)).size).toBe(6);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(6);
    expect(functions.every((fn) => (fn.warnings ?? []).some((warning) => warning.includes('approvals are independent')))).toBe(true);
    expect(functions.find((fn) => fn.functionName === 'deposit')!.warnings!.join(' ')).toMatch(/Token address.*returns pool-token amount.*does not take the pool-token receipt/);
    expect(functions.find((fn) => fn.functionName === 'initWithdrawal')!.warnings!.join(' ')).toMatch(/IPoolToken receipt.*request ID.*asynchronous/);
  });

  it('requires exact function grants for all six calls and rejects wrong chain, target, selector, trailing bytes, and noncanonical address padding', async () => {
    for (let index = 0; index < functions.length; index++) {
      const fn = functions[index];
      const good = call(fn);
      await expect(policy.authorizeContractCalls([good], ctx(1, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([good], ctx(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const other = functions[(index + 1) % functions.length];
      await expect(policy.authorizeContractCalls([good], ctx(1, [other.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([good], ctx(10, [fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...good, to: B }], ctx(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...good, data: `0xffffffff${good.data.slice(10)}` }], ctx(1, [fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], ctx(1, [fn.capabilityId]))).rejects.toBeDefined();
      if (fn.abi.inputs[0]?.type === 'address') {
        const badAddressPadding = `${good.data.slice(0, 10)}${'f'.repeat(24)}${good.data.slice(34)}` as `0x${string}`;
        await expect(policy.authorizeContractCalls([{ ...good, data: badAddressPadding }], ctx(1, [fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });

  it('accepts caller-selected max uint256 values and beneficiary/token values while enforcing ABI payability', async () => {
    for (const fn of functions) {
      const payable = fn.abi.stateMutability === 'payable';
      const data = call(fn, sampleArgs(fn), payable ? '17' : undefined);
      await expect(policy.authorizeContractCalls([data], ctx(1, [fn.capabilityId]))).resolves.toBeDefined();
      if (payable) {
        await expect(policy.authorizeContractCalls([call(fn, sampleArgs(fn), '0')], ctx(1, [fn.capabilityId]))).resolves.toBeDefined();
      } else {
        await expect(policy.authorizeContractCalls([call(fn, sampleArgs(fn), '1')], ctx(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }
    expect(sampleArgs(functions.find((fn) => fn.functionName === 'tradeBySourceAmount')!)).toEqual([C, C, maxUint256, maxUint256, maxUint256, C]);
  });
});

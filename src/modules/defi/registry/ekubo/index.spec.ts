import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildEkuboRegistry, EKUBO_CAPABILITIES } from './index';

const target = '0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D';
const other = '0x1111111111111111111111111111111111111111';
const token1 = '0x2222222222222222222222222222222222222222';
const config = `0x${'ab'.repeat(32)}` as const;
const max256 = (1n << 256n) - 1n;
const max128 = (1n << 128n) - 1n;
const min32 = -(1n << 31n);
const max32 = (1n << 31n) - 1n;
const poolKey = [other, token1, config] as const;
const fragment = buildEkuboRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'ekubo-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });

function argsFor(fn: DefiFunctionPolicy): readonly unknown[] {
  if (fn.functionName === 'mintAndDeposit') return [poolKey, min32, max32, max128, max128, max128];
  if (fn.functionName === 'deposit') return [max256, poolKey, min32, max32, max128, max128, max128];
  if (fn.functionName === 'withdraw') {
    const base = [max256, poolKey, min32, max32, max128];
    return fn.abi.inputs.length === 7 ? [...base, other, true] : base;
  }
  return fn.abi.inputs.length === 5 ? [max256, poolKey, min32, max32, other] : [max256, poolKey, min32, max32];
}
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn) as never }), ...(value === undefined ? {} : { value }) });

describe('Ekubo Ethereum Positions LP fixture', () => {
  it('binds six inactive source ABIs, outputs, selector-qualified IDs and source references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/ekubo.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('ekubo');
    expect(family.familyVersion).toBe('positions-v3.1.1@f8e38b5b');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Ekubo Ethereum Positions' });
    expect(contract.abiFunctions).toHaveLength(6);
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(EKUBO_CAPABILITIES).toHaveLength(6);
    expect(EKUBO_CAPABILITIES.every((fn) => fn.abi.stateMutability === 'payable')).toBe(true);
    const byName = (name: string) => EKUBO_CAPABILITIES.filter((fn) => fn.functionName === name);
    expect(byName('mintAndDeposit')[0].abi.outputs.map((output) => output.name)).toEqual(['id', 'liquidity', 'amount0', 'amount1']);
    expect(byName('deposit')[0].abi.outputs.map((output) => output.name)).toEqual(['liquidity', 'amount0', 'amount1']);
    expect(byName('withdraw')).toHaveLength(2);
    expect(byName('withdraw').every((fn) => fn.abi.outputs.map((output) => output.name).join(',') === 'amount0,amount1')).toBe(true);
    expect(byName('collectFees')).toHaveLength(2);
    expect(byName('collectFees').every((fn) => fn.abi.outputs.map((output) => output.name).join(',') === 'amount0,amount1')).toBe(true);
    for (const fn of EKUBO_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName && entry.inputs.length === fn.abi.inputs.length);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
      expect(fn.abi.inputs.find((input) => input.type === 'tuple')).toMatchObject({
        name: 'poolKey', type: 'tuple', internalType: 'struct PoolKey', components: [
          { name: 'token0', type: 'address', internalType: 'address' },
          { name: 'token1', type: 'address', internalType: 'address' },
          { name: 'config', type: 'bytes32', internalType: 'PoolConfig' },
        ],
      });
    }
    expect(new Set(EKUBO_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(6);
    for (const overloadName of ['withdraw', 'collectFees']) {
      expect(byName(overloadName).map((fn) => fn.capabilityId)).toEqual(byName(overloadName).map((fn) => `ekubo:positions-v3-1-1:1:${target.toLowerCase()}:${overloadName === 'collectFees' ? 'collect-fees' : 'withdraw'}-${toFunctionSelector(fn.signature).slice(2)}`));
    }
  });

  it('requires exact grants, permits native value for all payable methods, and accepts ABI-range extremes', async () => {
    for (const fn of EKUBO_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 17n)], context([fn.capabilityId]))).resolves.toMatchObject({ interactions: [{ value: '17' }] });
      await expect(policy.authorizeContractCalls([call(fn, max128)], context([fn.capabilityId]))).resolves.toBeDefined();
    }
  });

  it('isolates every function/overload, chain, selector and exact target', async () => {
    for (const fn of EKUBO_CAPABILITIES) {
      for (const otherFn of EKUBO_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('accepts signed tick extremes and rejects malformed tuple address, int32 sign extension, bool, and trailing data', async () => {
    const recipientWithdraw = EKUBO_CAPABILITIES.find((fn) => fn.functionName === 'withdraw' && fn.abi.inputs.length === 7)!;
    const validWithdraw = call(recipientWithdraw);
    const boolWord = 522;
    const invalidBool = `${validWithdraw.data.slice(0, boolWord)}${'0'.repeat(63)}2${validWithdraw.data.slice(boolWord + 64)}`;
    await expect(policy.authorizeContractCalls([{ ...validWithdraw, data: invalidBool }], context([recipientWithdraw.capabilityId]))).rejects.toBeDefined();

    for (const fn of EKUBO_CAPABILITIES) {
      const valid = call(fn);
      const poolKeyStart = fn.functionName === 'mintAndDeposit' ? 10 : 74;
      const malformedAddress = `${valid.data.slice(0, poolKeyStart)}${'1'.repeat(24)}${valid.data.slice(poolKeyStart + 24)}`;
      const tickLowerStart = fn.functionName === 'mintAndDeposit' ? 202 : 266;
      const malformedInt32Sign = `${valid.data.slice(0, tickLowerStart)}0${valid.data.slice(tickLowerStart + 1)}`;
      for (const data of [malformedAddress, malformedInt32Sign, `${valid.data}00`, valid.data.slice(0, -2), `0xdeadbeef${valid.data.slice(10)}`]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
    const tickRange = EKUBO_CAPABILITIES.find((fn) => fn.functionName === 'mintAndDeposit')!;
    await expect(policy.authorizeContractCalls([call(tickRange)], context([tickRange.capabilityId]))).resolves.toBeDefined();
    expect(argsFor(tickRange).slice(1, 3)).toEqual([min32, max32]);
  });
});

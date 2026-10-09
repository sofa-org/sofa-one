import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildZeroXRegistry, ZERO_X_CAPABILITIES } from './index';

const target = '0xdef1c0ded9bec7f1a1670819833240f027b25eff';
const other = '0x1111111111111111111111111111111111111111';
const fragment = buildZeroXRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'zero-x-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });

const tupleValues = (components: readonly any[], extremes = true): unknown[] => components.map((component) => component.type === 'tuple'
  ? tupleValues(component.components, extremes)
  : component.type === 'address' ? other
    : component.type === 'bytes32' ? extremes ? `0x${'ab'.repeat(32)}` : `0x${'00'.repeat(32)}`
      : component.type === 'bytes' ? '0x1234'
        : component.type.startsWith('uint') ? extremes ? (1n << BigInt(Number(component.type.slice(4)))) - 1n : 0n : 1);
const argsFor = (fn: DefiFunctionPolicy, extremes = true): readonly unknown[] => fn.abi.inputs.map((input: any) => input.type === 'tuple[]' ? [tupleValues(input.components, extremes)] : input.type === 'tuple' ? tupleValues(input.components, extremes) : input.type.startsWith('uint') ? extremes ? (1n << BigInt(Number(input.type.slice(4)))) - 1n : 0n : 1);
const call = (fn: DefiFunctionPolicy, value = 0n, extremes = true) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn, extremes) as never }), value });

describe('0x Ethereum Native Orders isolated fixture', () => {
  it('matches the pinned inactive source candidate, full ABI identity, selectors, and exactly eight methods', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v7/sources/zero-x.json', 'utf8'));
    const contract = source.families[0].contracts[0];
    expect(source.families[0].familyId).toBe('zero-x');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive' });
    expect(contract.abiFunctions).toHaveLength(8);
    expect(source.sources).toHaveLength(3);
    expect(contract.abiFunctions.map((entry: any) => entry.name).sort()).toEqual(['batchCancelLimitOrders','batchCancelRfqOrders','cancelLimitOrder','cancelRfqOrder','fillLimitOrder','fillOrKillLimitOrder','fillOrKillRfqOrder','fillRfqOrder'].sort());
    for (const fn of ZERO_X_CAPABILITIES) {
      const { sourceId, ...abi } = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      expect(abi).toEqual(fn.abi);
      expect(sourceId).toBe('zero-x-official-abi');
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(contract.sourceRefs).toContain(sourceId);
    }
    expect(new Set(ZERO_X_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(8);
    expect(ZERO_X_CAPABILITIES.map((fn) => [fn.functionName, toFunctionSelector(fn.signature)])).toEqual([
      ['batchCancelLimitOrders','0x9baa45a8'], ['batchCancelRfqOrders','0xf6e0f6a5'], ['cancelLimitOrder','0x7d49ec1a'], ['cancelRfqOrder','0xfe55a3ef'],
      ['fillLimitOrder','0xf6274f66'], ['fillOrKillLimitOrder','0x9240529c'], ['fillOrKillRfqOrder','0x438cdfc5'], ['fillRfqOrder','0xaa77476c'],
    ]);
  });

  it('requires exact function grants and isolates chain, target, selector, and unrelated grants', async () => {
    const fill = ZERO_X_CAPABILITIES.find((fn) => fn.functionName === 'fillRfqOrder')!;
    const cancel = ZERO_X_CAPABILITIES.find((fn) => fn.functionName === 'cancelRfqOrder')!;
    await expect(policy.authorizeContractCalls([call(fill)], context([fill.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(fill)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call(fill)], context([cancel.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(fill), to: other }], context([fill.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(fill)], context([fill.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  });

  it('enforces nonpayability, accepts payable fill value, and rejects noncanonical or unrelated calldata', async () => {
    const payable = ZERO_X_CAPABILITIES.find((fn) => fn.functionName === 'fillLimitOrder')!;
    const ordinary = ZERO_X_CAPABILITIES.find((fn) => fn.functionName === 'fillRfqOrder')!;
    const cancel = ZERO_X_CAPABILITIES.find((fn) => fn.functionName === 'cancelRfqOrder')!;
    await expect(policy.authorizeContractCalls([call(payable, 9n)], context([payable.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(ordinary, 1n)], context([ordinary.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(cancel, 1n)], context([cancel.capabilityId]))).rejects.toBeDefined();
    const valid = call(ordinary);
    for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([ordinary.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('exercises exact grants, target/chain/selector binding, canonical bytes, payable value, and ABI-width extremes for every method', async () => {
    for (const fn of ZERO_X_CAPABILITIES) {
      const valid = call(fn);
      const otherGrant = ZERO_X_CAPABILITIES.find((candidate) => candidate.capabilityId !== fn.capabilityId)!.capabilityId;
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([valid], context([otherGrant]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...valid, to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
      const amount = call(fn, 0n, false);
      await expect(policy.authorizeContractCalls([amount], context([fn.capabilityId]))).resolves.toBeDefined();
      const nonzeroValue = call(fn, 1n);
      if (fn.abi.stateMutability === 'payable') {
        await expect(policy.authorizeContractCalls([nonzeroValue], context([fn.capabilityId]))).resolves.toBeDefined();
      } else {
        await expect(policy.authorizeContractCalls([nonzeroValue], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});

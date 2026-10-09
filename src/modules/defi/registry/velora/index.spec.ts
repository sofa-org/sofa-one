import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildVeloraRegistry, VELORA_CAPABILITIES } from './index';

const target = '0xe92b586627ccA7a83dC919cc7127196d70f55a06';
const otherTarget = '0x1111111111111111111111111111111111111111';
const makerAsset = '0x2222222222222222222222222222222222222222';
const takerAsset = '0x3333333333333333333333333333333333333333';
const maker = '0x4444444444444444444444444444444444444444';
const taker = '0x5555555555555555555555555555555555555555';
const max256 = (1n << 256n) - 1n;
const max128 = (1n << 128n) - 1n;
const hashA = `0x${'ab'.repeat(32)}` as const;
const hashB = `0x${'cd'.repeat(32)}` as const;
const signature = '0x1234' as const;
const order = {
  nonceAndMeta: max256,
  expiry: max128,
  makerAsset,
  takerAsset,
  maker,
  taker,
  makerAmount: max256,
  takerAmount: max256,
} as const;
const fragment = buildVeloraRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({
  userId: 'velora-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet',
  chainId, executionMode: 'session_key', executionOwner: taker, allowedCapabilityIds: grants,
});

function argsFor(fn: DefiFunctionPolicy, signatureBytes: `0x${string}` = signature): readonly unknown[] {
  switch (fn.functionName) {
    case 'fillOrder': return [order, signatureBytes];
    case 'partialFillOrder': return [order, signatureBytes, max256];
    case 'cancelOrder': return [hashA];
    case 'cancelOrders': return [[hashA, hashB]];
    default: throw new Error(`Unexpected Augustus RFQ method: ${fn.functionName}`);
  }
}

const call = (fn: DefiFunctionPolicy, value?: bigint, signatureBytes?: `0x${string}`) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn, signatureBytes) as never }),
  ...(value === undefined ? {} : { value }),
});

function replaceWord(data: `0x${string}`, wordIndex: number, value: string): `0x${string}` {
  const start = 10 + wordIndex * 64;
  return `${data.slice(0, start)}${value.padStart(64, '0')}${data.slice(start + 64)}` as `0x${string}`;
}

describe('Velora Augustus RFQ Ethereum fixture', () => {
  it('binds the inactive source snapshot to all four exact ABI objects, hashes, selectors, IDs and refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v7/sources/velora.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family).toMatchObject({ familyId: 'velora', familyVersion: 'augustus-rfq@a36949e4' });
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Velora Ethereum Augustus RFQ' });
    expect(contract.abiFunctions).toHaveLength(4);
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(VELORA_CAPABILITIES).toHaveLength(4);
    expect(VELORA_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.abi.stateMutability, fn.abi.outputs, toFunctionSelector(fn.signature)])).toEqual([
      ['fillOrder', 'fillOrder((uint256,uint128,address,address,address,address,uint256,uint256),bytes)', 'nonpayable', [], '0x98f9b46b'],
      ['partialFillOrder', 'partialFillOrder((uint256,uint128,address,address,address,address,uint256,uint256),bytes,uint256)', 'nonpayable', [{ internalType: 'uint256', name: 'makerTokenFilledAmount', type: 'uint256' }], '0xc88ae6dc'],
      ['cancelOrder', 'cancelOrder(bytes32)', 'nonpayable', [], '0x7489ec23'],
      ['cancelOrders', 'cancelOrders(bytes32[])', 'nonpayable', [], '0x21c77c96'],
    ]);
    expect(VELORA_CAPABILITIES.map((fn) => fn.capabilityId)).toEqual([
      `velora:augustus-rfq-v1:1:${target.toLowerCase()}:fill-order`,
      `velora:augustus-rfq-v1:1:${target.toLowerCase()}:partial-fill-order`,
      `velora:augustus-rfq-v1:1:${target.toLowerCase()}:cancel-order`,
      `velora:augustus-rfq-v1:1:${target.toLowerCase()}:cancel-orders`,
    ]);
    for (const fn of VELORA_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(VELORA_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(4);
    expect(VELORA_CAPABILITIES.every((fn) => fn.abi.stateMutability === 'nonpayable')).toBe(true);
  });

  it('requires each exact grant, denies empty/unrelated grants, and rejects native value for every method', async () => {
    for (const fn of VELORA_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      for (const unrelated of VELORA_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([unrelated.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      }
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates exact chain, target and selector, while leaving ABI-valid order values and bytes caller-selected', async () => {
    for (const fn of VELORA_CAPABILITIES) {
      const valid = call(fn);
      await expect(policy.authorizeContractCalls([{ ...valid, to: otherTarget }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
      const wrongSelector = `0xdeadbeef${valid.data.slice(10)}` as `0x${string}`;
      await expect(policy.authorizeContractCalls([{ ...valid, data: wrongSelector }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId]))).resolves.toBeDefined();
    }
    const fill = VELORA_CAPABILITIES.find((fn) => fn.functionName === 'fillOrder')!;
    await expect(policy.authorizeContractCalls([call(fill, undefined, '0x')], context([fill.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(fill, undefined, '0xdeadbeef001122')], context([fill.capabilityId]))).resolves.toBeDefined();
    const partial = VELORA_CAPABILITIES.find((fn) => fn.functionName === 'partialFillOrder')!;
    await expect(policy.authorizeContractCalls([call(partial)], context([partial.capabilityId]))).resolves.toBeDefined();
    expect(order).toEqual({ nonceAndMeta: max256, expiry: max128, makerAsset, takerAsset, maker, taker, makerAmount: max256, takerAmount: max256 });
  });

  it('rejects noncanonical offsets, tuple address padding, dynamic-bytes padding, trailing and truncated calldata', async () => {
    for (const fn of VELORA_CAPABILITIES) {
      const valid = call(fn);
      for (const data of [
        `${valid.data}00` as `0x${string}`,
        valid.data.slice(0, -2) as `0x${string}`,
      ]) await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
    }

    for (const fn of VELORA_CAPABILITIES.filter((item) => item.functionName === 'fillOrder' || item.functionName === 'partialFillOrder')) {
      const valid = call(fn);
      const addressWordIndex = 2;
      const addressStart = 10 + addressWordIndex * 64;
      const malformedAddress = `${valid.data.slice(0, addressStart)}${'1'.repeat(24)}${valid.data.slice(addressStart + 24)}` as `0x${string}`;
      const overlappingBytesOffset = replaceWord(valid.data, 8, '100');
      const invalidPadding = `${valid.data.slice(0, -1)}1` as `0x${string}`;
      for (const data of [malformedAddress, overlappingBytesOffset, invalidPadding]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }

    const cancelMany = VELORA_CAPABILITIES.find((fn) => fn.functionName === 'cancelOrders')!;
    const arrayOffsetZero = replaceWord(call(cancelMany).data, 0, '0');
    await expect(policy.authorizeContractCalls([{ ...call(cancelMany), data: arrayOffsetZero }], context([cancelMany.capabilityId]))).rejects.toBeDefined();
  });
});

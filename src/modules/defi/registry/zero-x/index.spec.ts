import { encodeFunctionData, type AbiParameter } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildZeroXRegistry, ZERO_X_CAPABILITIES } from './index';
import { validateZeroExNftBinding, validateZeroExNftSettlement } from '../../execution/zero-ex-nft';
import { PRODUCTION_DEFI_MANIFEST } from '../production-registry';

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

  it('exercises exact grants, target/chain/selector binding, canonical bytes, payable value, and ABI-width extremes for every method', async () => {
    for (const fn of ZERO_X_CAPABILITIES) {
      const valid = call(fn);
      const otherGrant = ZERO_X_CAPABILITIES.find((candidate) => candidate.capabilityId !== fn.capabilityId)!.capabilityId;
      const authorized = await policy.authorizeContractCalls([valid], context([fn.capabilityId]));
      expect(authorized.executionPlan.map((node) => [node.match.capabilityId, node.data])).toEqual([[fn.capabilityId, valid.data]]);
      await expect(policy.authorizeContractCalls([valid], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([valid], context([otherGrant]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...valid, to: other }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: data.startsWith('0xdeadbeef') ? 'DEFI_FUNCTION_NOT_ALLOWED' : 'DEFI_INVALID_PARAMETERS' } });
      }
      const amount = call(fn, 0n, false);
      const minimum = await policy.authorizeContractCalls([amount], context([fn.capabilityId]));
      expect(minimum.executionPlan.map((node) => [node.match.capabilityId, node.data])).toEqual([[fn.capabilityId, amount.data]]);
      const nonzeroValue = call(fn, 1n);
      if (fn.abi.stateMutability === 'payable') {
        const funded = await policy.authorizeContractCalls([nonzeroValue], context([fn.capabilityId]));
        expect(funded.executionPlan.map((node) => [node.match.capabilityId, node.match.nativeValue])).toEqual([[fn.capabilityId, '1']]);
      } else {
        await expect(policy.authorizeContractCalls([nonzeroValue], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }
  });
});

describe('0x exact-feature NFT settlement syntax', () => {
  const functions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope?.kind === 'zero-ex-nft-settlement-v1');
  const cases: readonly { name: string; orders: readonly number[]; batch: boolean; callback?: number }[] = [
    { name: 'buyERC721', orders: [0], batch: false, callback: 2 },
    { name: 'sellERC721', orders: [0], batch: false, callback: 4 },
    { name: 'batchBuyERC721s', orders: [0], batch: true, callback: 2 },
    { name: 'matchERC721Orders', orders: [0, 1], batch: false },
    { name: 'batchMatchERC721Orders', orders: [0, 1], batch: true },
    { name: 'buyERC1155', orders: [0], batch: false, callback: 3 },
    { name: 'sellERC1155', orders: [0], batch: false, callback: 5 },
    { name: 'batchBuyERC1155s', orders: [0], batch: true, callback: 3 },
  ];
  const valueFor = (input: AbiParameter): unknown => {
    if (input.type.endsWith('[]')) {
      if (input.name?.endsWith('Properties')) return [];
      const child = { ...input, type: input.type.slice(0, -2) } as AbiParameter;
      return [valueFor(child), valueFor(child)];
    }
    if (input.type === 'tuple') return (input as AbiParameter & { components: readonly AbiParameter[] }).components.map(valueFor);
    if (input.type === 'address') return other;
    if (input.type === 'bytes32') return `0x${'ab'.repeat(32)}`;
    if (input.type === 'bytes') return '0x';
    if (input.type === 'bool') return false;
    return input.name === 'signatureType' ? 2n : 0n;
  };
  const nftArgs = (fn: DefiFunctionPolicy): unknown[] => fn.abi.inputs.map(valueFor);
  const encode = (fn: DefiFunctionPolicy, args = nftArgs(fn)) => encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
  const ordersFor = (args: unknown[], indices: readonly number[], batch: boolean): unknown[][] => indices.flatMap((index) => batch ? args[index] as unknown[][] : [args[index] as unknown[]]);

  it('requires the exact deployment, ABI and mandatory scope for each settlement entrypoint', () => {
    for (const entry of cases) {
      const fn = functions.find((candidate) => candidate.functionName === entry.name)!;
      for (const changed of [
        { ...fn, chainId: 10 },
        { ...fn, contract: other },
        { ...fn, type: 'typed_data_sign' },
        { ...fn, functionName: 'other' },
        { ...fn, signature: 'other()' },
        { ...fn, executionScope: undefined },
        { ...fn, executionScope: { kind: 'empty-callback-v1', argumentIndex: 2 } },
        { ...fn, executionScope: { kind: 'zero-ex-nft-settlement-v1', extra: true } },
        { ...fn, abi: { ...fn.abi, stateMutability: 'view' } },
        { ...fn, abi: { ...fn.abi, outputs: [{ name: 'unreviewed', type: 'bytes' }] } },
      ]) expect(() => validateZeroExNftBinding(changed as unknown as DefiFunctionPolicy)).toThrow();
    }
    expect(() => validateZeroExNftBinding({ ...ZERO_X_CAPABILITIES[0], executionScope: { kind: 'zero-ex-nft-settlement-v1' } } as unknown as DefiFunctionPolicy)).toThrow();
  });

  it('rejects each configurable taker callback, including later optional-failure items', () => {
    for (const entry of cases.filter((entry) => entry.callback !== undefined)) {
      const fn = functions.find((candidate) => candidate.functionName === entry.name)!;
      const args = nftArgs(fn);
      if (entry.batch) (args[entry.callback!] as unknown[])[1] = '0x00';
      else args[entry.callback!] = '0x00';
      expect(() => validateZeroExNftSettlement(encode(fn, args))).toThrow();
    }
  });

  it('rejects fee bytes and any property entry in every order on both matcher sides', () => {
    for (const entry of cases) {
      const fn = functions.find((candidate) => candidate.functionName === entry.name)!;
      const count = entry.orders.length * (entry.batch ? 2 : 1);
      for (let index = 0; index < count; index++) {
        const feeArgs = nftArgs(fn);
        const feeOrder = ordersFor(feeArgs, entry.orders, entry.batch)[index];
        // Zero price/quantity/fee values and caught failures never skip scope.
        (feeOrder[7] as unknown[][])[1][2] = '0x1234';
        expect(() => validateZeroExNftSettlement(encode(fn, feeArgs))).toThrow();
        const propertyArgs = nftArgs(fn);
        ordersFor(propertyArgs, entry.orders, entry.batch)[index][10] = [[other, '0x']];
        expect(() => validateZeroExNftSettlement(encode(fn, propertyArgs))).toThrow();
      }
    }
  });

  it('checks all supplied arrays even when source length checks would revert', () => {
    for (const entry of cases.filter((entry) => entry.batch)) {
      const fn = functions.find((candidate) => candidate.functionName === entry.name)!;
      const args = nftArgs(fn);
      (args[entry.orders[entry.orders.length - 1]] as unknown[][]).push((nftArgs(fn)[0] as unknown[][])[0]);
      const supplied = ordersFor(args, entry.orders, true);
      supplied[supplied.length - 1][10] = [[other, '0x']];
      expect(() => validateZeroExNftSettlement(encode(fn, args))).toThrow();
    }
  });

  it('bounds array counts, total bytes and node counts before decoding', () => {
    const fn = functions.find((candidate) => candidate.functionName === 'batchBuyERC721s')!;
    const overArray = nftArgs(fn);
    overArray[0] = Array.from({ length: 65 }, () => (nftArgs(fn)[0] as unknown[][])[0]);
    expect(() => validateZeroExNftSettlement(encode(fn, overArray))).toThrow();
    const overNodes = nftArgs(fn);
    overNodes[0] = Array.from({ length: 16 }, () => {
      const order = (nftArgs(fn)[0] as unknown[][])[0];
      order[7] = Array.from({ length: 16 }, () => [other, 0n, '0x']);
      return order;
    });
    expect(() => validateZeroExNftSettlement(encode(fn, overNodes))).toThrow();
    const valid = encode(fn);
    const hostileOffset = `${valid.slice(0, 10)}${'f'.repeat(64)}${valid.slice(74)}`;
    expect(() => validateZeroExNftSettlement(hostileOffset)).toThrow();
    expect(() => validateZeroExNftSettlement(`${valid}${'00'.repeat(65_536)}`)).toThrow();
  });

  it('rejects unknown/helper selectors, truncation, trailing bytes and malformed hex', () => {
    for (const fn of functions) {
      const valid = encode(fn);
      for (const data of [
        `${valid}00`, valid.slice(0, -2), `${valid.slice(0, -1)}g`,
        `0x60018b41${valid.slice(10)}`, `0xa4f4d30d${valid.slice(10)}`, `0xdeadbeef${valid.slice(10)}`, '0x',
      ]) expect(() => validateZeroExNftSettlement(data)).toThrow();
    }
  });
});

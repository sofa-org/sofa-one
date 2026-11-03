import { encodeFunctionData } from 'viem';
import type { DefiExecutionContext, DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';
import { validateHertzDecreaseOrder, validateHertzDecreaseOrderBinding } from './hertzflow';

const scopeKind = 'hertzflow-zero-callback-decrease-order-v1';
const owner = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const zero = '0x0000000000000000000000000000000000000000';
const zeroWord = `0x${'00'.repeat(32)}`;
const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((entry) => entry.executionScope?.kind === scopeKind)!;
function parameters(orderType = 4, routeSize = 1) {
  return {
    addresses: { receiver: owner, cancellationReceiver: owner, callbackContract: zero, uiFeeReceiver: zero, market: token, initialCollateralToken: token, swapPath: Array<string>(routeSize).fill(token) },
    numbers: { sizeDeltaUsd: 10n ** 30n, initialCollateralDeltaAmount: 1n, triggerPrice: 1n, acceptablePrice: 1n, executionFee: 0n, callbackGasLimit: 0n, minOutputAmount: 0n, validFromTime: 0n },
    orderType, decreasePositionSwapType: 0, orderPositionType: 0,
    isLong: true, shouldUnwrapNativeToken: false, autoCancel: false,
    referralCode: zeroWord, dataList: [] as string[],
  };
}
const encode = (params = parameters()) => encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [params] as never });
function word(data: string, index: number, value: bigint): string {
  const offset = 10 + index * 64;
  return `${data.slice(0, offset)}${value.toString(16).padStart(64, '0')}${data.slice(offset + 64)}`;
}
function fixture(ids = [fn.capabilityId]) {
  const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, db as never, PRODUCTION_DEFI_MANIFEST);
  const policy = new DefiPolicyService(db as never, {} as never, catalog);
  const context: DefiExecutionContext = { userId: 'hertz-test', walletId: 'wallet', apiKeyId: '00000000-0000-4000-8000-000000000001', chainId: 56, executionMode: 'session_key', executionOwner: owner, capabilityMode: 'custom', allowedCapabilityIds: ids };
  return { policy, context };
}

describe('HertzFlow existing-position decrease scope', () => {
  it.each([4, 5, 6])('plans decrease type %i and rejects native value despite the payable ABI', async (type) => {
    const data = encode(parameters(type)), { policy, context } = fixture();
    const authorization = await policy.authorizeContractCalls([{ to: fn.contract, data }], context);
    expect(authorization.executionPlan.map((node) => [node.match.capabilityId, node.data, node.match.nativeValue])).toEqual([[fn.capabilityId, data, '0']]);
    for (const value of ['1', '17', ((1n << 256n) - 1n).toString()]) {
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value }], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it.each([0, 1, 2, 3, 7, 8, 9, 255])('rejects non-decrease order type %i', (type) => {
    expect(() => validateHertzDecreaseOrder(encode(parameters(type)), 0n)).toThrow();
  });

  it.each([4, 5, 6])('rejects chosen callbacks and all extension data for type %i', (type) => {
    for (const callbackContract of [owner, token, fn.contract]) {
      const params = parameters(type); params.addresses.callbackContract = callbackContract;
      expect(() => validateHertzDecreaseOrder(encode(params), 0n)).toThrow();
    }
    for (const dataList of [[zeroWord], [`0x${'12'.repeat(32)}`]]) {
      const params = parameters(type); params.dataList = dataList;
      expect(() => validateHertzDecreaseOrder(encode(params), 0n)).toThrow();
    }
  });

  it('rejects malformed tuple offsets, oversized arrays and noncanonical scalar words before decoding', () => {
    const data = encode(), start = Number(BigInt(`0x${data.slice(10, 74)}`)) / 32;
    const addressesStart = start + Number(BigInt(`0x${data.slice(10 + start * 64, 10 + (start + 1) * 64)}`)) / 32;
    const oversizedData = parameters(); oversizedData.dataList = Array<string>(65).fill(zeroWord);
    for (const invalid of [data.slice(0, -2), `${data}00`, data.slice(0, 10), `${data}zz`, `${data.slice(0, 10)}${'00'.repeat(65_537)}`,
      encode(parameters(4, 65)), encode(oversizedData), word(data, 0, 1n), word(data, start, (1n << 256n) - 1n),
      word(data, start + 9, 256n), word(data, start + 12, 2n), word(data, addressesStart, (1n << 160n) + BigInt(owner)),
      word(data, addressesStart + 6, 1n), word(data, start + 16, 1n)]) {
      expect(() => validateHertzDecreaseOrder(invalid, 0n)).toThrow();
    }
  });

  it('cannot remove, widen or transplant the complete deployment/ABI/scope identity', () => {
    const changed: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined }, { ...fn, executionScope: { kind: 'empty-tuple-bytes-v1', tupleArgIndex: 0, bytesComponentIndex: 9 } },
      { ...fn, executionScope: { ...fn.executionScope, allowIncrease: true } as unknown as DefiExecutionScope },
      { ...fn, chainId: 1 }, { ...fn, contract: token }, { ...fn, type: 'typed_data_sign' },
      { ...fn, signature: 'createOrder(bytes)' }, { ...fn, functionName: 'createOrderAlias' },
      { ...fn, abi: { ...fn.abi, stateMutability: 'nonpayable' } }, { ...fn, abi: { ...fn.abi, outputs: [] } },
      { ...fn, abi: { ...fn.abi, inputs: [{ ...fn.abi.inputs[0], name: 'unchecked' }] } },
    ];
    for (const candidate of changed) expect(() => validateHertzDecreaseOrderBinding(candidate)).toThrow();
  });

  it('does not implicitly add the new selector to an existing finite multicall grant', async () => {
    const wrapper = PRODUCTION_DEFI_MANIFEST.capabilities.find((entry) => entry.chainId === 56 && entry.contract.toLowerCase() === fn.contract.toLowerCase() && entry.executionScope?.kind === 'same-target-financial-multicall-v1')!;
    const data = encodeFunctionData({ abi: [wrapper.abi], functionName: wrapper.functionName, args: [[encode()]] });
    const { policy, context } = fixture([wrapper.capabilityId, fn.capabilityId]);
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data }], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });
});

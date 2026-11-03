import { toFunctionSelector, type AbiFunction, type AbiParameter } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const SCOPE_KIND = 'hertzflow-zero-callback-decrease-order-v1';
const TARGET = '0x61e1116a943b27d21094599c2c5bd75e980170a5';
const ZERO = '0x0000000000000000000000000000000000000000';
function parameter(name: string, type: 'address' | 'address[]' | 'uint256' | 'uint8' | 'bool' | 'bytes32' | 'bytes32[]', internalType: string = type): AbiParameter {
  return { name, type, internalType };
}
const abi: AbiFunction = {
  name: 'createOrder', type: 'function', stateMutability: 'payable',
  inputs: [{
    name: 'params', type: 'tuple', internalType: 'struct IBaseOrderUtils.CreateOrderParams',
    components: [
      {
        name: 'addresses', type: 'tuple', internalType: 'struct IBaseOrderUtils.CreateOrderParamsAddresses',
        components: [
          parameter('receiver', 'address'), parameter('cancellationReceiver', 'address'),
          parameter('callbackContract', 'address'), parameter('uiFeeReceiver', 'address'),
          parameter('market', 'address'), parameter('initialCollateralToken', 'address'),
          parameter('swapPath', 'address[]'),
        ],
      },
      {
        name: 'numbers', type: 'tuple', internalType: 'struct IBaseOrderUtils.CreateOrderParamsNumbers',
        components: [
          parameter('sizeDeltaUsd', 'uint256'), parameter('initialCollateralDeltaAmount', 'uint256'),
          parameter('triggerPrice', 'uint256'), parameter('acceptablePrice', 'uint256'),
          parameter('executionFee', 'uint256'), parameter('callbackGasLimit', 'uint256'),
          parameter('minOutputAmount', 'uint256'), parameter('validFromTime', 'uint256'),
        ],
      },
      parameter('orderType', 'uint8', 'enum Order.OrderType'),
      parameter('decreasePositionSwapType', 'uint8', 'enum Order.DecreasePositionSwapType'),
      parameter('orderPositionType', 'uint8', 'enum Order.OrderPositionType'),
      parameter('isLong', 'bool'), parameter('shouldUnwrapNativeToken', 'bool'),
      parameter('autoCancel', 'bool'), parameter('referralCode', 'bytes32'),
      parameter('dataList', 'bytes32[]'),
    ],
  }],
  outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
};
const SIGNATURE = 'createOrder(((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,uint8,bool,bool,bool,bytes32,bytes32[]))';
const SELECTOR = toFunctionSelector(SIGNATURE);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
const CANONICAL_ABI = canonical(abi);

/** The full createOrder selector is never an unrestricted order-creation grant. */
export function validateHertzDecreaseOrderBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.contract.toLowerCase() === TARGET;
  if (!root && !marked) return;
  const reserved = root && (fn.signature === SIGNATURE || fn.functionName === abi.name || toFunctionSelector(fn.signature) === SELECTOR);
  if (!reserved && !marked) return;
  if (!root || fn.chainId !== 56 || !marked || fn.type !== 'contract_call'
    || fn.signature !== SIGNATURE || fn.functionName !== abi.name
    || canonical(fn.abi) !== CANONICAL_ABI || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid HertzFlow decrease-order deployment/ABI/mandatory scope binding');
  }
}

/** Restrict request syntax; the fixed on-chain account/position key supplies ownership. */
export function validateHertzDecreaseOrder(data: string, nativeValue: bigint): void {
  if (nativeValue !== 0n || typeof data !== 'string' || data.slice(0, 10).toLowerCase() !== SELECTOR) {
    throw new TypeError('Invalid HertzFlow decrease-order selector or native value');
  }
  const params = decodeUniswapParameters(abi.inputs, `0x${data.slice(10)}`)[0] as {
    addresses: { callbackContract: string };
    orderType: number;
    dataList: readonly unknown[];
  };
  // OrderType 4/5/6 are MarketDecrease, LimitDecrease and StopLossDecrease.
  if (params.orderType < 4 || params.orderType > 6 || params.addresses.callbackContract !== ZERO || params.dataList.length !== 0) {
    throw new TypeError('HertzFlow order must decrease an existing position without chosen callbacks or extensions');
  }
}

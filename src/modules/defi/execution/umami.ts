import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const SCOPE_KIND = 'umami-zero-request-callback-v1';
const TARGET = '0x5f851f67d24419982ecd7b7765defd64fbb50a97';
const ZERO = '0x0000000000000000000000000000000000000000';
const abis: readonly AbiFunction[] = [
  {
    type: 'function', name: 'depositWithCallback', stateMutability: 'payable',
    inputs: [
      { name: 'assets', type: 'uint256' }, { name: 'minOutAfterFees', type: 'uint256' },
      { name: 'receiver', type: 'address' }, { name: 'callback', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function', name: 'redeemWithCallback', stateMutability: 'payable',
    inputs: [
      { name: 'shares', type: 'uint256' }, { name: 'minOutAfterFees', type: 'uint256' },
      { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' },
      { name: 'callback', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
const methods = abis.map((abi) => {
  const signature = `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`;
  return { abi, signature, selector: toFunctionSelector(signature), canonicalAbi: canonical(abi) };
});

/** The two selected request entrypoints cannot lose their zero-callback scope. */
export function validateUmamiRequestBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.contract.toLowerCase() === TARGET;
  if (!root && !marked) return;
  const selector = root ? toFunctionSelector(fn.signature) : undefined;
  const method = root ? methods.find((entry) => entry.signature === fn.signature || entry.abi.name === fn.functionName || entry.selector === selector) : undefined;
  if (!method && !marked) return;
  if (!root || fn.chainId !== 42161 || !method || !marked || fn.type !== 'contract_call'
    || fn.signature !== method.signature || fn.functionName !== method.abi.name
    || canonical(fn.abi) !== method.canonicalAbi || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid Umami request deployment/ABI/mandatory scope binding');
  }
}

/** Disable only the selected request callback, not configured hooks or asynchronous keepers. */
export function validateUmamiRequest(data: string): void {
  const selector = typeof data === 'string' ? data.slice(0, 10).toLowerCase() : undefined;
  const method = methods.find((entry) => entry.selector === selector);
  if (!method) throw new TypeError('Unsupported Umami request selector');
  const args = decodeUniswapParameters(method.abi.inputs, `0x${data.slice(10)}`);
  if (args[method.abi.inputs.length - 1] !== ZERO) throw new TypeError('Umami selected request callback must be zero');
}

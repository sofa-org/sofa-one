import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const SCOPE_KIND = 'openocean-empty-permit-swap-v1';
const TARGET = '0x6352a56caadc4f1e25cd6c75970fa768a3304e64';
const abis: readonly AbiFunction[] = [
  ...['callUniswapWithPermit', 'callUniswapToWithPermit'].map((name): AbiFunction => ({
    name, type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'srcToken', type: 'address', internalType: 'contract IERC20' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      { name: 'minReturn', type: 'uint256', internalType: 'uint256' },
      { name: 'pools', type: 'bytes32[]', internalType: 'bytes32[]' },
      { name: 'permit', type: 'bytes', internalType: 'bytes' },
      ...(name === 'callUniswapToWithPermit'
        ? [{ name: 'recipient', type: 'address', internalType: 'address payable' }]
        : []),
    ],
    outputs: [{ name: 'returnAmount', type: 'uint256', internalType: 'uint256' }],
  })),
  {
    name: 'uniswapV3SwapToWithPermit', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address', internalType: 'address payable' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      { name: 'minReturn', type: 'uint256', internalType: 'uint256' },
      { name: 'pools', type: 'uint256[]', internalType: 'uint256[]' },
      { name: 'permit', type: 'bytes', internalType: 'bytes' },
      { name: 'srcToken', type: 'address', internalType: 'contract IERC20' },
    ],
    outputs: [{ name: 'returnAmount', type: 'uint256', internalType: 'uint256' }],
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

/** Reserve exact permit-wrapper identities, never the ordinary route name prefixes. */
export function validateOpenOceanSwapBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.contract.toLowerCase() === TARGET;
  if (!root && !marked) return;
  const selector = root ? toFunctionSelector(fn.signature) : undefined;
  const method = root ? methods.find((entry) => entry.signature === fn.signature
    || entry.selector === selector || entry.abi.name === fn.functionName) : undefined;
  if (!method && !marked) return;
  if (!root || fn.chainId !== 1 || !method || !marked || fn.type !== 'contract_call'
    || fn.signature !== method.signature || fn.functionName !== method.abi.name
    || canonical(fn.abi) !== method.canonicalAbi || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid OpenOcean swap deployment/ABI/mandatory scope binding');
  }
}

/** Empty bytes skip the entire external authority call; routes use existing allowance. */
export function validateOpenOceanSwap(data: string): void {
  const selector = typeof data === 'string' ? data.slice(0, 10).toLowerCase() : undefined;
  const method = methods.find((entry) => entry.selector === selector);
  if (!method) throw new TypeError('Unsupported OpenOcean swap selector');
  const args = decodeUniswapParameters(method.abi.inputs, `0x${data.slice(10)}`);
  if (args[4] !== '0x') throw new TypeError('OpenOcean swap permit data must be empty');
}

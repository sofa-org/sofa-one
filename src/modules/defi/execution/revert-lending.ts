import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const SCOPE_KIND = 'revert-empty-lending-permit-v1';
const TARGET = '0x74e6afef5705beb126c6d3bf46f8fad8f3e07825';
const abis: readonly AbiFunction[] = [
  ...['deposit', 'mint'].map((name): AbiFunction => ({
    name, type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: name === 'deposit' ? 'assets' : 'shares', type: 'uint256', internalType: 'uint256' },
      { name: 'receiver', type: 'address', internalType: 'address' },
      { name: 'permitData', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
  })),
  {
    name: 'repay', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      { name: 'isShare', type: 'bool', internalType: 'bool' },
      { name: 'permitData', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [
      { name: 'assets', type: 'uint256', internalType: 'uint256' },
      { name: 'shares', type: 'uint256', internalType: 'uint256' },
    ],
  },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
const methods = abis.map((abi) => {
  const signature = `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`;
  return { abi, signature, selector: toFunctionSelector(signature), canonicalAbi: canonical(abi), permitIndex: abi.inputs.length - 1 };
});

/** Reserve only the permit-bearing overload identities, not ordinary ERC4626 names. */
export function validateRevertLendingBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.contract.toLowerCase() === TARGET;
  if (!root && !marked) return;
  const selector = root ? toFunctionSelector(fn.signature) : undefined;
  const method = root ? methods.find((entry) => entry.signature === fn.signature || entry.selector === selector) : undefined;
  if (!method && !marked) return;
  if (!root || fn.chainId !== 42161 || !method || !marked || fn.type !== 'contract_call'
    || fn.signature !== method.signature || fn.functionName !== method.abi.name
    || canonical(fn.abi) !== method.canonicalAbi || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid Revert lending deployment/ABI/mandatory scope binding');
  }
}

/** Empty raw bytes bypass the entire Permit2 branch; existing vault allowance is used. */
export function validateRevertLending(data: string): void {
  const selector = typeof data === 'string' ? data.slice(0, 10).toLowerCase() : undefined;
  const method = methods.find((entry) => entry.selector === selector);
  if (!method) throw new TypeError('Unsupported Revert lending selector');
  const args = decodeUniswapParameters(method.abi.inputs, `0x${data.slice(10)}`);
  if (args[method.permitIndex] !== '0x') throw new TypeError('Revert lending permit data must be empty');
}

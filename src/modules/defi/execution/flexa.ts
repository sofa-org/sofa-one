import { keccak256, stringToHex, toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const TARGET = '0xd57e335457b6f5d09ac69248230005a02f9b60cf';
const SCOPE_KIND = 'flexa-preauthorized-stake-v1';
const TOKEN = { name: '_token', type: 'address' } as const;
const AMOUNT = { name: '_amount', type: 'uint256' } as const;
const SIGNATURE = { name: '_collateralizableApprovalSignature', type: 'bytes' } as const;
const STAKE_ABI: AbiFunction = {
  type: 'function', name: 'stake', stateMutability: 'nonpayable',
  inputs: [TOKEN, AMOUNT, SIGNATURE], outputs: [{ name: '', type: 'uint256' }],
};
const RELEASABLE_ABI: AbiFunction = {
  type: 'function', name: 'stakeReleasableTokensFrom', stateMutability: 'nonpayable',
  inputs: [{ name: '_pool', type: 'address' }, TOKEN, AMOUNT, SIGNATURE], outputs: [{ name: '', type: 'uint256' }],
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

const FUNCTIONS = [
  { signature: 'stake(address,uint256,bytes)', abi: STAKE_ABI, signatureIndex: 2, selfPool: false },
  { signature: 'stakeReleasableTokensFrom(address,address,uint256,bytes)', abi: RELEASABLE_ABI, signatureIndex: 3, selfPool: true },
].map((fn) => ({ ...fn, selector: toFunctionSelector(fn.abi), abiHash: keccak256(stringToHex(canonical(fn.abi))) }));
const BY_SIGNATURE = new Map(FUNCTIONS.map((fn) => [fn.signature, fn]));
const BY_SELECTOR = new Map(FUNCTIONS.map((fn) => [fn.selector, fn]));

/** Neither source-bound financial selector may lose its mandatory argument interpreter. */
export function validateFlexaStakeBinding(fn: DefiFunctionPolicy): void {
  const selected = BY_SIGNATURE.get(fn.signature);
  const reserved = fn.contract.toLowerCase() === TARGET && selected !== undefined;
  if (!reserved && fn.executionScope?.kind !== SCOPE_KIND) return;
  if (fn.chainId !== 1 || fn.contract.toLowerCase() !== TARGET || !selected
    || fn.type !== 'contract_call' || fn.functionName !== selected.abi.name
    || fn.executionScope?.kind !== SCOPE_KIND || Object.keys(fn.executionScope).join(',') !== 'kind'
    || keccak256(stringToHex(canonical(fn.abi))) !== selected.abiHash) {
    throw new TypeError('Invalid Flexa stake deployment/ABI/mandatory scope binding');
  }
}

/** Empty signatures consume existing Anvil funding/allowance; self-pool disables the selected-pool call. */
export function validateFlexaStake(data: string): void {
  if (typeof data !== 'string') throw new TypeError('Invalid Flexa stake calldata');
  const selected = BY_SELECTOR.get(data.slice(0, 10).toLowerCase() as `0x${string}`);
  if (!selected) throw new TypeError('Wrong Flexa stake selector');
  const args = decodeUniswapParameters(selected.abi.inputs, `0x${data.slice(10)}`);
  if (args[selected.signatureIndex] !== '0x') throw new TypeError('Flexa stake approval signature must be empty');
  if (selected.selfPool && (args[0] as string).toLowerCase() !== TARGET) throw new TypeError('Flexa stake source pool must be the bound root');
}

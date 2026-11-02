import { keccak256, stringToHex, type AbiFunction } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const TARGET = '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae';
const CHAINS = new Set([10, 137, 8453]);
const SIGNATURE = 'claimWithRecipient(address[],address[],uint256[],bytes32[][],address[],bytes[])';
const ABI: AbiFunction = {
  type: 'function', name: 'claimWithRecipient', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: 'users', type: 'address[]' }, { name: 'tokens', type: 'address[]' },
    { name: 'amounts', type: 'uint256[]' }, { name: 'proofs', type: 'bytes32[][]' },
    { name: 'recipients', type: 'address[]' }, { name: 'datas', type: 'bytes[]' },
  ],
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
const ABI_HASH = keccak256(stringToHex(canonical(ABI)));

/** These exact source-bound claims cannot fall back to outer-ABI-only authorization. */
export function validateMerklClaimBinding(fn: DefiFunctionPolicy): void {
  const reserved = fn.contract.toLowerCase() === TARGET && fn.signature === SIGNATURE;
  if (!reserved && fn.executionScope?.kind !== 'merkl-empty-claim-data-v1') return;
  if (!CHAINS.has(fn.chainId) || fn.contract.toLowerCase() !== TARGET || fn.signature !== SIGNATURE
    || fn.type !== 'contract_call' || fn.functionName !== ABI.name || fn.executionScope?.kind !== 'merkl-empty-claim-data-v1'
    || keccak256(stringToHex(canonical(fn.abi))) !== ABI_HASH) throw new TypeError('Invalid Merkl claim deployment/ABI/mandatory scope binding');
}

/** Bound every claim/proof/data array before decoding; disable only the explicit onClaim path. */
export function validateMerklClaim(data: string): void {
  if (typeof data !== 'string' || data.slice(0, 10).toLowerCase() !== '0x9fb67b58') throw new TypeError('Wrong Merkl claim selector');
  const args = decodeUniswapParameters(ABI.inputs, `0x${data.slice(10)}`);
  const datas = args[5];
  if (!Array.isArray(datas) || datas.some((entry) => entry !== '0x')) throw new TypeError('Merkl claim callback data must be empty');
}

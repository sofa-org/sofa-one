import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const TARGET = '0x0000001d41857cb60f6be0c9fe74b9e69e1e5234';
const SCOPE_KIND = 'napier-zero-deadline-collect-v1';
const COLLECT_INPUT = {
  name: 'inputs', type: 'tuple[]', internalType: 'struct TwoCryptoZap.CollectInput[]',
  components: [
    { name: 'principalToken', type: 'address', internalType: 'address' },
    {
      name: 'permit', type: 'tuple', internalType: 'struct TwoCryptoZap.PermitCollectInput',
      components: [
        { name: 'deadline', type: 'uint256', internalType: 'uint256' },
        { name: 'v', type: 'uint8', internalType: 'uint8' },
        { name: 'r', type: 'bytes32', internalType: 'bytes32' },
        { name: 's', type: 'bytes32', internalType: 'bytes32' },
      ],
    },
  ],
} as const;
const RECEIVER = { name: 'receiver', type: 'address', internalType: 'address' } as const;
const METHODS: readonly { signature: string; abi: AbiFunction }[] = [
  {
    signature: 'collectWithPermit((address,(uint256,uint8,bytes32,bytes32))[],address)',
    abi: {
      type: 'function', name: 'collectWithPermit', stateMutability: 'nonpayable',
      inputs: [COLLECT_INPUT, RECEIVER], outputs: [],
    },
  },
  {
    signature: 'collectRewardsWithPermit((address,(uint256,uint8,bytes32,bytes32))[],address[][],address)',
    abi: {
      type: 'function', name: 'collectRewardsWithPermit', stateMutability: 'nonpayable',
      inputs: [COLLECT_INPUT, { name: 'rewardTokens', type: 'address[][]', internalType: 'address[][]' }, RECEIVER], outputs: [],
    },
  },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
const methods = METHODS.map((method) => ({ ...method, selector: toFunctionSelector(method.abi), canonicalAbi: canonical(method.abi) }));

/** Reserve both collector identities and aliases at the fixed root, even when the marker is removed. */
export function validateNapierCollectorBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.contract.toLowerCase() === TARGET;
  if (!root && !marked) return;
  const selector = root ? toFunctionSelector(fn.signature) : undefined;
  const method = methods.find((entry) => entry.signature === fn.signature || entry.selector === selector
    || entry.abi.name === fn.functionName || entry.abi.name === fn.abi.name || entry.abi.name === fn.signature.split('(')[0]);
  if (!method && !marked) return;
  if (!root || fn.chainId !== 1 || !method || !marked || fn.type !== 'contract_call'
    || fn.signature !== method.signature || fn.functionName !== method.abi.name
    || canonical(fn.abi) !== method.canonicalAbi || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid Napier collector deployment/ABI/mandatory scope binding');
  }
}

/** Zero deadlines skip the entire authority call; existing collector approval and accrued balances remain required. */
export function validateNapierCollect(data: string): void {
  const selector = typeof data === 'string' ? data.slice(0, 10).toLowerCase() : undefined;
  const method = methods.find((entry) => entry.selector === selector);
  if (!method) throw new TypeError('Unsupported Napier collector selector');
  const args = decodeUniswapParameters(method.abi.inputs, `0x${data.slice(10)}`);
  const inputs = args[0] as readonly { permit: { deadline: bigint } }[];
  for (const input of inputs) {
    if (input.permit.deadline !== 0n) throw new TypeError('Napier collector permit deadline must be zero');
  }
}

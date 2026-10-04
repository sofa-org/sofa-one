import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const contract = '0x83f20f44975d03b1b09e64809b757c47f942beea';
const sourceRef = [
  'https://github.com/makerdao/sdai/blob/2b7acb95289a9eb3a8844206d5712eabfa206efc/README.md',
  'https://github.com/makerdao/sdai/blob/665879762f8b5df5d234463f45d1d6a49bd4fbeb/src/ISavingsDai.sol',
  'https://github.com/makerdao/sdai/blob/665879762f8b5df5d234463f45d1d6a49bd4fbeb/src/SavingsDai.sol',
].join(' | ');

const abiFunctions = [
  {
    type: 'function', name: 'deposit', stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'assets', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'shares', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: 'assets', type: 'uint256' }],
  },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'assets', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'owner', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function', name: 'redeem', stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'shares', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'owner', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: 'assets', type: 'uint256' }],
  },
] as const satisfies readonly AbiFunction[];

const operations = ['deposit', 'mint', 'withdraw', 'redeem'] as const;
const functions: DefiFunctionPolicy[] = abiFunctions.map((abi, index) => {
  const operation = operations[index];
  const signature = `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`;
  return {
    capabilityId: `sdai-savings:no-referral-v1:1:${contract}:${operation}`,
    type: 'contract_call',
    chainId,
    contract,
    functionName: abi.name,
    signature,
    abi,
    status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-05', status: 'verified' },
    protocol: 'Spark Savings sDAI',
    operation,
    label: `sDAI ${operation}`,
    description: `Exact no-referral SavingsDai ${operation} ABI selected from the pinned implementation declarations.`,
    warnings: [
      'Caller-selected ABI arguments remain unrestricted by platform financial, amount, recipient, owner, market, price, oracle, or funding caps; protocol checks and reverts remain unchanged.',
      'This source-qualified selection does not establish current runtime/code identity, liquidity, funded execution, or a complete savings workflow.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: contract, status: 'active', functions }] }];

export const SDAI_SAVINGS_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Isolated test fixture only; not imported by or wired into production runtime/catalog. */
export function buildSdaiSavingsRegistry(): DefiRegistryFragment { return { chains }; }

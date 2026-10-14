import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const target = '0xeEF417e1D5CC832e619ae18D2F140De2999dD4fB';
const sourceRef = 'bancor-v3-mainnet-deployment';
const commonWarnings = [
  'This is an explicitly source-qualified test fixture only; it is inactive candidate source and is not production admission, current runtime-code verification, or funded-execution proof.',
  'All ABI financial and recipient arguments remain caller-selected. There are no platform amount/token/pool/beneficiary/deadline allowlists or caps, owner checks, price-feed screening, eligibility checks, or automatic approval pairing. ERC-20 approvals are independent capabilities and are not included or automatic.',
  'Only the six fixed user methods on the exact network proxy are represented; this is not a pool inventory, complete workflow, liquidity, pool eligibility, safety, or transaction-success guarantee.',
];
const specs = [
  {
    name: 'cancelWithdrawal', operation: 'cancel-withdrawal', mutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], label: 'Bancor cancel withdrawal request',
    warnings: ['Cancellation uses a previously returned request ID and is subject to protocol request state.'],
  },
  {
    name: 'deposit', operation: 'deposit', mutability: 'payable',
    inputs: [{ name: 'pool', type: 'address', internalType: 'contract Token' }, { name: 'tokenAmount', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], label: 'Bancor liquidity deposit',
    warnings: ['deposit(pool, tokenAmount) uses a Token address for the Bancor pool/base-token side and returns pool-token amount; it does not take the pool-token receipt. initWithdrawal separately accepts IPoolToken receipts.'],
  },
  {
    name: 'initWithdrawal', operation: 'init-withdrawal', mutability: 'nonpayable',
    inputs: [{ name: 'poolToken', type: 'address', internalType: 'contract IPoolToken' }, { name: 'poolTokenAmount', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], label: 'Bancor initiate asynchronous withdrawal',
    warnings: ['initWithdrawal takes an IPoolToken receipt, not the base Token argument used by deposit, and returns a request ID; cancelWithdrawal and withdraw use protocol request state, and withdraw requires an eligible request. The request/claim sequence can be asynchronous and subject to protocol timing and liquidity; no completion or payout is guaranteed.'],
  },
  {
    name: 'tradeBySourceAmount', operation: 'trade-by-source-amount', mutability: 'payable',
    inputs: [
      { name: 'sourceToken', type: 'address', internalType: 'contract Token' }, { name: 'targetToken', type: 'address', internalType: 'contract Token' },
      { name: 'sourceAmount', type: 'uint256', internalType: 'uint256' }, { name: 'minReturnAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'deadline', type: 'uint256', internalType: 'uint256' }, { name: 'beneficiary', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], label: 'Bancor trade by source amount', warnings: [],
  },
  {
    name: 'tradeByTargetAmount', operation: 'trade-by-target-amount', mutability: 'payable',
    inputs: [
      { name: 'sourceToken', type: 'address', internalType: 'contract Token' }, { name: 'targetToken', type: 'address', internalType: 'contract Token' },
      { name: 'targetAmount', type: 'uint256', internalType: 'uint256' }, { name: 'maxSourceAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'deadline', type: 'uint256', internalType: 'uint256' }, { name: 'beneficiary', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], label: 'Bancor trade by target amount', warnings: [],
  },
  {
    name: 'withdraw', operation: 'withdraw', mutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], label: 'Bancor complete eligible withdrawal',
    warnings: ['initWithdrawal takes an IPoolToken receipt, not the base Token argument used by deposit, and returns a request ID; cancelWithdrawal and withdraw use protocol request state, and withdraw requires an eligible request. The request/claim sequence can be asynchronous and subject to protocol timing and liquidity; no completion or payout is guaranteed.'],
  },
] as const;

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = {
    type: 'function', name: spec.name, stateMutability: spec.mutability,
    inputs: [...spec.inputs], outputs: [...spec.outputs],
  };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return {
    capabilityId: `bancor-v3:v3:${chainId}:${target.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: target, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Bancor V3', operation: spec.operation, label: spec.label,
    warnings: [...commonWarnings, ...spec.warnings],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];

/** Explicit source-qualified test fixture; intentionally not wired into a runtime registry. */
export function buildBancorV3Registry(): DefiRegistryFragment { return { chains }; }

export const bancorV3Selectors = specs.map((spec) => toFunctionSelector(`${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`));

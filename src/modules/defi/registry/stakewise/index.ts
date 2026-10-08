import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const vault = '0xAC0F906E433d58FA868F936E8A43230473652885';
const sourceRef = 'docs/defi-research/expansion55-stakewise-v5.md (StakeWise v3-core commit fc70cbe1b3d41bc5f78434830d837aa270ca33bc; Ethereum Genesis Vault deployment and interfaces)';
const specs = [
  { name: 'deposit', operation: 'deposit', mutability: 'payable', inputs: [{ name: 'receiver', type: 'address', internalType: 'address' }, { name: 'referrer', type: 'address', internalType: 'address' }], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }], label: 'StakeWise ETH deposit' },
  { name: 'enterExitQueue', operation: 'enter-exit-queue', mutability: 'nonpayable', inputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }, { name: 'receiver', type: 'address', internalType: 'address' }], outputs: [{ name: 'positionTicket', type: 'uint256', internalType: 'uint256' }], label: 'StakeWise enter asynchronous exit queue' },
  { name: 'claimExitedAssets', operation: 'claim-exited-assets', mutability: 'nonpayable', inputs: [{ name: 'positionTicket', type: 'uint256', internalType: 'uint256' }, { name: 'timestamp', type: 'uint256', internalType: 'uint256' }, { name: 'exitQueueIndex', type: 'uint256', internalType: 'uint256' }], outputs: [], label: 'StakeWise claim exited assets' },
] as const;

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return {
    capabilityId: `stakewise:v3-genesis:${chainId}:${vault.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: vault, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'StakeWise', operation: spec.operation, label: spec.label,
    warnings: [
      'This source-qualified fixture is not a production admission, compiled/runtime verification, current liquidity proof, or funded-execution guarantee.',
      'Receiver, referrer, shares, ticket, timestamp, and exit-queue index are caller-controlled ABI values; there are no platform-added recipient, ownership, amount, or approval constraints.',
      ...(spec.operation === 'enter-exit-queue' || spec.operation === 'claim-exited-assets' ? ['Exit is asynchronous: queue entry is not an instant redemption, and claim readiness depends on protocol queue conditions and available assets; no timing or payout is guaranteed.'] : ['The payable deposit amount is caller-controlled; no platform amount limit or deposit outcome is guaranteed.']),
      ...(spec.operation === 'claim-exited-assets' ? ['The source contract restricts claiming to the designated receiver for a queued position; this intrinsic protocol rule is not a platform owner/whitelist policy.'] : []),
    ],
  };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: vault, status: 'active', functions }] }];

/** Explicit source fixture only; intentionally not wired into a runtime registry. */
export function buildStakeWiseRegistry(): DefiRegistryFragment { return { chains }; }

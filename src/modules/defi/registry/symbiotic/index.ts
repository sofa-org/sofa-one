import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const vault = '0x007e0B8E99c6134E81A1eAAE754460E3202cB671';
const sourceRef = 'symbiotic-ivault-interface';
const address = (name: string) => ({ name, internalType: 'address', type: 'address' });
const uint256 = (name: string) => ({ name, internalType: 'uint256', type: 'uint256' });
const declarations: readonly { abi: AbiFunction; operation: string }[] = [
  { operation: 'deposit', abi: {
    type: 'function', name: 'deposit', stateMutability: 'nonpayable',
    inputs: [address('onBehalfOf'), uint256('amount')],
    outputs: [uint256('depositedAmount'), uint256('mintedShares')],
  } },
  { operation: 'withdraw', abi: {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [address('claimer'), uint256('amount')],
    outputs: [uint256('burnedShares'), uint256('mintedShares')],
  } },
  { operation: 'redeem', abi: {
    type: 'function', name: 'redeem', stateMutability: 'nonpayable',
    inputs: [address('claimer'), uint256('shares')],
    outputs: [uint256('withdrawnAssets'), uint256('mintedShares')],
  } },
  { operation: 'claim', abi: {
    type: 'function', name: 'claim', stateMutability: 'nonpayable',
    inputs: [address('recipient'), uint256('epoch')],
    outputs: [uint256('amount')],
  } },
  { operation: 'claim-batch', abi: {
    type: 'function', name: 'claimBatch', stateMutability: 'nonpayable',
    inputs: [address('recipient'), { name: 'epochs', internalType: 'uint256[]', type: 'uint256[]' }],
    outputs: [uint256('amount')],
  } },
];

function makeFunction({ abi, operation }: typeof declarations[number]): DefiFunctionPolicy {
  return {
    capabilityId: `symbiotic:v1:${chainId}:${vault.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: vault, functionName: abi.name,
    signature: `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Symbiotic', operation, label: `Symbiotic vault ${abi.name}`,
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, an automatic grant, current capacity/whitelist status, runtime-version verification, liquidity, or funded-execution certification.',
      'All ABI-valid onBehalfOf/claimer/recipient, amount/shares, and epoch arguments remain caller selected without platform financial caps, owner/feed restrictions, or approval pairing.',
      'The protocol pulls collateral from the caller on deposit; withdrawals are queued for a later epoch to the selected claimer, and claims pay the caller-selected recipient. Configured depositor whitelist, deposit capacity, nonzero-address/amount rules, epoch timing, share accounting, token allowance, and claim eligibility are intrinsic protocol conditions. Separate approvals are independent and never automatic.',
    ],
  };
}

const functions = declarations.map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: vault, status: 'active', functions }] }];

export const SYMBIOTIC_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit fixture for offline policy tests only; not runtime wired or automatically granted. */
export function buildSymbioticRegistry(): DefiRegistryFragment { return { chains }; }

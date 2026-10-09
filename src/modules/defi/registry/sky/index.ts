import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const savings = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const sourceRef = 'sky-susds-listed-implementation-abi';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const uint16 = (name: string) => ({ name, type: 'uint16', internalType: 'uint16' });

const abis: readonly AbiFunction[] = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver')], outputs: [uint('shares')] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), uint16('referral')], outputs: [uint('shares')] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver')], outputs: [uint('assets')] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver'), uint16('referral')], outputs: [uint('assets')] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), address('owner')], outputs: [uint('shares')] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver'), address('owner')], outputs: [uint('assets')] },
];

function signatureOf(abi: AbiFunction): string {
  return `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`;
}

function operationOf(abi: AbiFunction): string {
  const selector = toFunctionSelector(signatureOf(abi)).slice(2);
  return `${abi.name}-${selector}`;
}

const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const signature = signatureOf(abi);
  const operation = operationOf(abi);
  return {
    capabilityId: `sky:susds-v1:${chainId}:${savings.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: savings, functionName: abi.name,
    signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Sky', operation, label: `sUSDS ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current proxy implementation proof, liquidity proof, or funded-execution certification.',
      'The dated official chainlog snapshot maps the sUSDS proxy to a listed implementation; the implementation address is source evidence only and is never an authorized target.',
      'Savings methods can accrue and be paused. USDS allowance, share allowance when caller differs from owner, accrual/configuration and redemption liquidity are protocol prerequisites, not platform ownership/cap/pairing filters.',
      'All amount, receiver, owner, and referral values remain caller-selected within canonical ABI types. Approvals are independent; no adapter, ward/admin, permit, drip, view, or generic executor route is included.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: savings, status: 'active', functions }] }];

export const SKY_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildSkyRegistry(): DefiRegistryFragment { return { chains }; }

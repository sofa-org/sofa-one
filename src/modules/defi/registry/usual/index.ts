import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const vault = '0xd861bE82dEe3223CFBEd160791f6550b0704D406';
const sourceRef = 'usual-susd0-implementation-verified-source';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });

const abis: Record<'deposit' | 'mint' | 'withdraw' | 'redeem', AbiFunction> = {
  deposit: { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver')], outputs: [uint('shares')] },
  mint: { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver')], outputs: [uint('')] },
  withdraw: { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), address('owner')], outputs: [uint('shares')] },
  redeem: { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver'), address('owner')], outputs: [uint('assets')] },
};

function makeFunction(operation: keyof typeof abis): DefiFunctionPolicy {
  const abi = abis[operation];
  const signatures = {
    deposit: 'deposit(uint256,address)', mint: 'mint(uint256,address)',
    withdraw: 'withdraw(uint256,address,address)', redeem: 'redeem(uint256,address,address)',
  };
  return {
    capabilityId: `usual:susd0-v1:1:${vault.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: vault, functionName: operation,
    signature: signatures[operation], abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Usual', operation, label: `sUSD0 ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current proxy implementation proof, liquidity proof, or funded-execution certification.',
      'sUSD0 is the savings share product; USD0 is its documented underlying. This is not privileged USD0 issuance or the separate legacy USD0++ bond product.',
      'Implementation source describes pause/blacklist controls, configurable fees and maxWithdraw/maxRedeem behavior; caller-selected values remain uncapped and receiver/owner are not platform-restricted. Allowances are independent and never auto-added.',
      'The documented 3 bps fee is not proof of the current configured fee or a promised payout. Protocol state, share allowance where applicable, available assets and token approval remain protocol prerequisites.',
    ],
  };
}

const functions = (['deposit', 'mint', 'withdraw', 'redeem'] as const).map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: vault, status: 'active', functions }] }];

export const USUAL_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildUsualRegistry(): DefiRegistryFragment { return { chains }; }

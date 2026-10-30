import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const savings = '0x004626A008B1aCdC4c74ab51644093b155e59A23';
const sourceRef = 'angle-official-sdk-savings-abi';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });

const abis: Record<'deposit' | 'mint' | 'withdraw' | 'redeem', AbiFunction> = {
  deposit: { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver')], outputs: [uint('shares')] },
  mint: { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver')], outputs: [uint('assets')] },
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
    capabilityId: `angle:ageur-savings-v1:1:${savings.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: savings, functionName: operation,
    signature: signatures[operation], abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Angle Protocol', operation, label: `agEUR Savings ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current proxy implementation proof, liquidity proof, or funded-execution certification.',
      'This fixture is specifically the dated agEUR Savings snapshot in the pinned SDK; it does not assert a current stEUR/EURA deployment, rename, or continuity.',
      'Savings methods accrue interest and are pause-gated in the pinned implementation. Token allowance, pause/configuration, accrued assets and available liquidity remain protocol prerequisites; approvals are independent and never auto-added.',
      'Amounts and receiver/owner remain caller-controlled ABI arguments without platform caps, owner restrictions, feeds, or approval pairing. This does not authorize staking adapters, admin, permit/signature, or generic execution paths.',
    ],
  };
}

const functions = (['deposit', 'mint', 'withdraw', 'redeem'] as const).map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: savings, status: 'active', functions }] }];

export const ANGLE_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildAngleRegistry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const vault = '0xA62F9C5af106FeEE069F38dE51098D9d81B90572';
const sourceRef = 'stakestone-stonevault-sourcify-abi';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });

const abis: Record<'deposit' | 'requestWithdraw' | 'cancelWithdraw', AbiFunction> = {
  deposit: { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [uint('mintAmount')] },
  requestWithdraw: { type: 'function', name: 'requestWithdraw', stateMutability: 'nonpayable', inputs: [uint('_shares')], outputs: [] },
  cancelWithdraw: { type: 'function', name: 'cancelWithdraw', stateMutability: 'nonpayable', inputs: [uint('_shares')], outputs: [] },
};

function makeFunction(operation: keyof typeof abis): DefiFunctionPolicy {
  const operations = { deposit: 'deposit', requestWithdraw: 'request-withdraw', cancelWithdraw: 'cancel-withdraw' } as const;
  const signatures = { deposit: 'deposit()', requestWithdraw: 'requestWithdraw(uint256)', cancelWithdraw: 'cancelWithdraw(uint256)' } as const;
  const abi = abis[operation];
  return {
    capabilityId: `stakestone:stone-vault-v1:${chainId}:${vault.toLowerCase()}:${operations[operation]}`,
    type: 'contract_call', chainId, contract: vault, functionName: operation,
    signature: signatures[operation], abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'StakeStone', operation: operations[operation], label: `StoneVault ${operations[operation]}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, present runtime identity, liquidity, or funded-execution certification.',
      'Only deposit(), requestWithdraw(uint256), and cancelWithdraw(uint256) are included. Request/cancel are queue operations, not a complete asynchronous withdrawal or settlement workflow.',
      'Deposit and request/cancel amounts remain caller-selected within the declared ABI types without platform caps, owner restrictions, feeds, or funded criteria. Token allowance and protocol exit state remain intrinsic prerequisites.',
      'Independent approvals are not paired or automatically granted; no broader withdrawal, settlement, admin/operator, or generic-bytes methods are included.',
    ],
  };
}

const functions = (['deposit', 'requestWithdraw', 'cancelWithdraw'] as const).map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: vault, status: 'active', functions }] }];

export const STAKESTONE_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildStakeStoneRegistry(): DefiRegistryFragment { return { chains }; }

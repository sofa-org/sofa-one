import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 56;
const stakeManager = '0x1adB950d8bB3dA4bE104211D5AB038628e477fE6';
const sourceRef = 'lista-official-stake-manager-source';

const abis: Record<'deposit' | 'requestWithdraw' | 'claimWithdraw', AbiFunction> = {
  deposit: { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  requestWithdraw: { type: 'function', name: 'requestWithdraw', stateMutability: 'nonpayable', inputs: [{ name: '_amountInSnBnb', type: 'uint256', internalType: 'uint256' }], outputs: [] },
  claimWithdraw: { type: 'function', name: 'claimWithdraw', stateMutability: 'nonpayable', inputs: [{ name: '_idx', type: 'uint256', internalType: 'uint256' }], outputs: [] },
};

function makeFunction(operation: keyof typeof abis): DefiFunctionPolicy {
  const operations = { deposit: 'deposit', requestWithdraw: 'request-withdraw', claimWithdraw: 'claim-withdraw' } as const;
  const signatures = { deposit: 'deposit()', requestWithdraw: 'requestWithdraw(uint256)', claimWithdraw: 'claimWithdraw(uint256)' } as const;
  const abi = abis[operation];
  return {
    capabilityId: `lista:stake-manager-v1:${chainId}:${stakeManager.toLowerCase()}:${operations[operation]}`,
    type: 'contract_call', chainId, contract: stakeManager, functionName: operation,
    signature: signatures[operation], abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Lista DAO', operation: operations[operation], label: `Lista StakeManager ${operations[operation]}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current proxy implementation proof, or funded-execution certification.',
      'The official source declares native deposit and slisBNB withdrawal request/claim methods. Deposit requires positive native value and conversion to a positive slisBNB amount; request withdrawals have a protocol minimum and queue conditions.',
      'Withdrawal claims are indexed against the caller’s confirmed request and remain subject to protocol queue, unbonding, and liquidity conditions. No platform caller-owner, amount, minimum, index, or funded filter is imposed.',
      'The fork test is published source evidence and its setup replaces the proxy implementation; it is not evidence of current live proxy state. slisBNB allowance is a separate protocol prerequisite; approvals are independent and never auto-added.',
    ],
  };
}

const functions = (['deposit', 'requestWithdraw', 'claimWithdraw'] as const).map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: stakeManager, status: 'active', functions }] }];

export const LISTA_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildListaRegistry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const proxy = '0x39254033945AA2E4809Cc2977E7087BEE48bd7Ab';
const sourceRef = 'origin-oeth-implementation-deployment';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const mintAbi: AbiFunction = { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('_amount')], outputs: [] };
const requestAbi: AbiFunction = {
  type: 'function', name: 'requestWithdrawal', stateMutability: 'nonpayable', inputs: [uint('_amount')],
  outputs: [{ name: 'requestId', type: 'uint256', internalType: 'uint256' }, { name: 'queued', type: 'uint256', internalType: 'uint256' }],
};
const claimAbi: AbiFunction = { type: 'function', name: 'claimWithdrawal', stateMutability: 'nonpayable', inputs: [uint('_requestId')], outputs: [{ name: 'amount', type: 'uint256', internalType: 'uint256' }] };
const claimsAbi: AbiFunction = {
  type: 'function', name: 'claimWithdrawals', stateMutability: 'nonpayable',
  inputs: [{ name: '_requestIds', type: 'uint256[]', internalType: 'uint256[]' }],
  outputs: [{ name: 'amounts', type: 'uint256[]', internalType: 'uint256[]' }, { name: 'totalAmount', type: 'uint256', internalType: 'uint256' }],
};

function makeFunction(abi: AbiFunction, operation: 'mint' | 'request-withdrawal' | 'claim-withdrawal' | 'claim-withdrawals', signature: string): DefiFunctionPolicy {
  return {
    capabilityId: `origin:oeth-v1:${chainId}:${proxy.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: proxy, functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Origin', operation, label: `Origin OETH ${operation}`,
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, automatic grant, current proxy implementation/code, liquidity, or funded-execution certification.',
      'Pinned OETH vault mint accepts supported ERC20 assets: it pulls the asset and mints OETH. It is nonpayable; this fixture does not imply native ETH input.',
      'Withdrawal requests burn caller OETH and queue an asynchronous asset withdrawal. Claims transfer the queued asset; the protocol minimum delay, available queue liquidity, and capital-pause state can prevent completion.',
      'All ABI-valid financial amounts and request IDs remain caller-selected without platform owner, amount, feed, or approval-pairing restrictions. ERC20 allowance is a separate protocol prerequisite; no approval is coupled or granted.',
    ],
  };
}

const functions: DefiFunctionPolicy[] = [
  makeFunction(mintAbi, 'mint', 'mint(uint256)'),
  makeFunction(requestAbi, 'request-withdrawal', 'requestWithdrawal(uint256)'),
  makeFunction(claimAbi, 'claim-withdrawal', 'claimWithdrawal(uint256)'),
  makeFunction(claimsAbi, 'claim-withdrawals', 'claimWithdrawals(uint256[])'),
];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: proxy, status: 'active', functions }] }];

export const ORIGIN_OETH_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildOriginOethRegistry(): DefiRegistryFragment { return { chains }; }

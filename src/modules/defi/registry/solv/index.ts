import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const proxy = '0x3d93B9e8F0886358570646dAd9421564C5fE6334';
const sourceRef = 'solvbtc-router-v2-etherscan-source';
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const uint256 = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const uint64 = (name: string) => ({ name, type: 'uint64', internalType: 'uint64' });

const depositAbi: AbiFunction = {
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [address('targetToken_'), address('currency_'), uint256('currencyAmount_'), uint256('minimumTargetTokenAmount_'), uint64('expireTime_')],
  outputs: [{ name: 'targetTokenAmount_', type: 'uint256', internalType: 'uint256' }],
};
const withdrawRequestAbi: AbiFunction = {
  type: 'function', name: 'withdrawRequest', stateMutability: 'nonpayable',
  inputs: [address('targetToken_'), address('currency_'), uint256('withdrawAmount_')],
  outputs: [{ name: '', type: 'address', internalType: 'address' }, { name: '', type: 'uint256', internalType: 'uint256' }],
};
const cancelWithdrawRequestAbi: AbiFunction = {
  type: 'function', name: 'cancelWithdrawRequest', stateMutability: 'nonpayable',
  inputs: [address('targetToken_'), address('redemption_'), uint256('redemptionId_')],
  outputs: [{ name: 'targetTokenAmount_', type: 'uint256', internalType: 'uint256' }],
};

function makeFunction(abi: AbiFunction, operation: 'deposit' | 'withdraw-request' | 'cancel-withdraw-request', signature: string, label: string): DefiFunctionPolicy {
  return {
    capabilityId: `solv:router-v2:${chainId}:${proxy.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: proxy, functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Solv', operation, label,
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, automatic grant, current proxy implementation/slot, settlement, liquidity, or funded-execution certification.',
      'The exact target is the Ethereum Router V2 proxy from the pinned official deployment artifact. The receipt implementation and separately currently listed verified implementation differ; the latter contributes ABI/source declarations only, not proof of the proxy current slot.',
      'Router path configuration, pool currency/permissions, KYC/whitelist/SFT slot checks, fees, allowance, and queue state remain protocol-native conditions. No platform financial cap, owner check, asset/recipient/deadline restriction, or approval pairing is added.',
      'withdrawRequest starts an asynchronous request and cancelWithdrawRequest cancels a request; these selected methods do not provide withdrawal settlement/claim completion. Independent token approvals are not automatically paired or granted.',
    ],
  };
}

const functions: DefiFunctionPolicy[] = [
  makeFunction(depositAbi, 'deposit', 'deposit(address,address,uint256,uint256,uint64)', 'SolvBTC Router V2 deposit'),
  makeFunction(withdrawRequestAbi, 'withdraw-request', 'withdrawRequest(address,address,uint256)', 'SolvBTC Router V2 withdrawal request'),
  makeFunction(cancelWithdrawRequestAbi, 'cancel-withdraw-request', 'cancelWithdrawRequest(address,address,uint256)', 'SolvBTC Router V2 cancel withdrawal request'),
];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: proxy, status: 'active', functions }] }];

export const SOLV_ROUTER_V2_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildSolvRouterV2Registry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const target = '0x493C57C4763932315A328269E1ADaD09653B9081';
const sourceRef = 'idle-token-interface';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const mintAbi: AbiFunction = {
  type: 'function', name: 'mintIdleToken', stateMutability: 'nonpayable',
  inputs: [uint('_amount'), { name: '_skipRebalance', type: 'bool', internalType: 'bool' }, { name: '_referral', type: 'address', internalType: 'address' }],
  outputs: [{ name: 'mintedTokens', type: 'uint256', internalType: 'uint256' }],
};
const redeemAbi: AbiFunction = {
  type: 'function', name: 'redeemIdleToken', stateMutability: 'nonpayable',
  inputs: [uint('_amount')], outputs: [{ name: 'redeemedTokens', type: 'uint256', internalType: 'uint256' }],
};

function makeFunction(abi: AbiFunction, operation: 'mint-idle-token' | 'redeem-idle-token', signature: string, functionName: string): DefiFunctionPolicy {
  return {
    capabilityId: `idle:v3-1:${chainId}:${target.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: target, functionName, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Idle', operation, label: `Idle iDAI ${operation}`,
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, automatic grant, current proxy-code, liquidity, or funded-execution certification.',
      'Pinned iDAI target uses DAI as underlying. Mint pulls underlying and mints Idle tokens to the caller; redemption burns caller-held Idle tokens, transfers underlying, and invokes rewards redemption.',
      'The interface names _skipRebalance, while the pinned implementation declares its second bool unnamed and unused; this fixture follows the pinned interface and does not claim compiled ABI identity.',
      'Caller controls all ABI-valid amounts, the rebalance flag and referral address without platform financial caps, referral restrictions or approval pairing. Protocol pause, token allowance, and available liquidity are intrinsic prerequisites.',
    ],
  };
}

const functions: DefiFunctionPolicy[] = [
  makeFunction(mintAbi, 'mint-idle-token', 'mintIdleToken(uint256,bool,address)', 'mintIdleToken'),
  makeFunction(redeemAbi, 'redeem-idle-token', 'redeemIdleToken(uint256)', 'redeemIdleToken'),
];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];

export const IDLE_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildIdleRegistry(): DefiRegistryFragment { return { chains }; }

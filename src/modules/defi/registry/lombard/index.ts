import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const proxy = '0x8236a87084f8B84306F72007F36F2618A5634494';
const sourceRef = 'lombard-staked-lbtc-implementation-sourcify';
const redeemForBtcAbi: AbiFunction = {
  type: 'function', name: 'redeemForBtc', stateMutability: 'nonpayable',
  inputs: [{ name: 'scriptPubkey', type: 'bytes', internalType: 'bytes' }, { name: 'amount', type: 'uint256', internalType: 'uint256' }], outputs: [],
};
const redeemAbi: AbiFunction = {
  type: 'function', name: 'redeem', stateMutability: 'nonpayable',
  inputs: [{ name: 'amount', type: 'uint256', internalType: 'uint256' }], outputs: [],
};

const functions: DefiFunctionPolicy[] = [
  {
    capabilityId: `lombard:staked-lbtc-v1:${chainId}:${proxy.toLowerCase()}:redeem-for-btc`,
    type: 'contract_call', chainId, contract: proxy, functionName: 'redeemForBtc', signature: 'redeemForBtc(bytes,uint256)', abi: redeemForBtcAbi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Lombard', operation: 'redeem-for-btc', label: 'Lombard LBTC redeem for Bitcoin',
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, automatic grant, current proxy implementation/code, Bitcoin completion, liquidity, or funded-execution certification.',
      'The pinned StakedLBTC implementation forwards caller-selected Bitcoin scriptPubkey and amount to the configured asset router for BTC redemption; this payload is not arbitrary EVM target/calldata authority.',
      'Script encoding/eligibility, router configuration, minimum/dust/fee, pause and protocol availability remain protocol-native conditions. No platform script, amount, owner, price/feed restriction, or approval pairing is added.',
    ],
  },
  {
    capabilityId: `lombard:staked-lbtc-v1:${chainId}:${proxy.toLowerCase()}:redeem`,
    type: 'contract_call', chainId, contract: proxy, functionName: 'redeem', signature: 'redeem(uint256)', abi: redeemAbi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Lombard', operation: 'redeem', label: 'Lombard LBTC redeem to NativeLBTC',
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, automatic grant, current proxy implementation/code, NativeLBTC liquidity, or funded-execution certification.',
      'The pinned implementation routes redemption into NativeLBTC on this chain; this operation is not a redemption to BTC or ETH.',
      'Router configuration, minimums, fees, pause and route availability remain protocol-native conditions. Caller-selected ABI-valid amount has no platform cap, owner check, price/feed filter, or approval pairing.',
    ],
  },
];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: proxy, status: 'active', functions }] }];

export const LOMBARD_STAKED_LBTC_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildLombardStakedLbtcRegistry(): DefiRegistryFragment { return { chains }; }

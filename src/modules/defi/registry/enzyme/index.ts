import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const comptroller = '0x3714E016690aC209aB173A2B4b86Aaa1c8f48327';
const sourceRef = 'enzyme-sdk-comptroller-abi';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const addressArray = (name: string) => ({ name, type: 'address[]', internalType: 'address[]' });
const uintArray = (name: string) => ({ name, type: 'uint256[]', internalType: 'uint256[]' });

const abis: Record<'buyShares' | 'redeemSharesInKind' | 'redeemSharesForSpecificAssets', AbiFunction> = {
  buyShares: {
    type: 'function', name: 'buyShares', stateMutability: 'nonpayable',
    inputs: [uint('_investmentAmount'), uint('_minSharesQuantity')],
    outputs: [uint('sharesReceived_')],
  },
  redeemSharesInKind: {
    type: 'function', name: 'redeemSharesInKind', stateMutability: 'nonpayable',
    inputs: [address('_recipient'), uint('_sharesQuantity'), addressArray('_additionalAssets'), addressArray('_assetsToSkip')],
    outputs: [addressArray('payoutAssets_'), uintArray('payoutAmounts_')],
  },
  redeemSharesForSpecificAssets: {
    type: 'function', name: 'redeemSharesForSpecificAssets', stateMutability: 'nonpayable',
    inputs: [address('_recipient'), uint('_sharesQuantity'), addressArray('_payoutAssets'), uintArray('_payoutAssetPercentages')],
    outputs: [uintArray('payoutAmounts_')],
  },
};

const operations = {
  buyShares: 'buy-shares', redeemSharesInKind: 'redeem-shares-in-kind',
  redeemSharesForSpecificAssets: 'redeem-shares-for-specific-assets',
} as const;

const functions: DefiFunctionPolicy[] = (Object.keys(abis) as (keyof typeof abis)[]).map((name) => {
  const abi = abis[name];
  return {
    capabilityId: `enzyme:sulu-v4:${chainId}:${comptroller.toLowerCase()}:${operations[name]}`,
    type: 'contract_call', chainId, contract: comptroller, functionName: name,
    signature: `${name}(${abi.inputs.map(({ type }) => type).join(',')})`,
    abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Enzyme', operation: operations[name], label: `Enzyme ${operations[name]}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current open-fund/runtime identity, liquidity, or funded-execution certification.',
      'This is the Comptroller user target, not the associated VaultProxy or FundDeployer. Deployment log evidence is one dated fund snapshot, not broad deployment coverage.',
      'buyShares denomination asset/allowance, caller-owned redemption, shares-action timelock, policy behavior, unique assets/percentages, and skipped-balance consequences are intrinsic protocol semantics; no platform amount, owner, asset, feed, or pairing filters are added.',
      'Only these three fixed calls are bound. Integration-adapter execution, batching, administration, permit, and generic execution methods are excluded; token approvals remain independent.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: comptroller, status: 'active', functions }] }];

export const ENZYME_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildEnzymeRegistry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const target = '0xc1e3Ca8A3921719bE0aE3690A0e036feB4f69191';
const sourceRef = 'stakedao-crv-depositor-sourcify';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const bool = (name: string) => ({ name, type: 'bool', internalType: 'bool' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });

const depositAbi: AbiFunction = {
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [uint('_amount'), bool('_lock'), bool('_stake'), address('_user')], outputs: [],
};
const depositAllAbi: AbiFunction = {
  type: 'function', name: 'depositAll', stateMutability: 'nonpayable',
  inputs: [bool('_lock'), bool('_stake'), address('_user')], outputs: [],
};

function makeFunction(abi: AbiFunction, operation: 'deposit' | 'deposit-all', signature: string): DefiFunctionPolicy {
  return {
    capabilityId: `stakedao:crv-depositor-v1:${chainId}:${target.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: target, functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'StakeDAO', operation, label: `StakeDAO CRV depositor ${operation}`,
    warnings: [
      'Explicit source-qualified active test fixture only; not production admission, automatic grant, current runtime-code, liquidity, or funded-execution certification.',
      'Pinned verified source declares deposit public and depositAll external, with no access modifier or caller-owner equality check on either entrypoint. depositAll reads the caller CRV balance and calls deposit with that amount.',
      'Caller chooses ABI-valid amount, lock/stake flags and nonzero beneficiary; platform adds no financial cap, owner restriction, or approval pairing. CRV allowance and locker/minter/gauge dependencies are intrinsic protocol prerequisites.',
      'The selected methods do not establish a complete StakeDAO deposit/exit/reward workflow. The SDCRV gauge address is not a selected user target; exit and reward-claim methods are not inferred.',
    ],
  };
}

const functions: DefiFunctionPolicy[] = [
  makeFunction(depositAbi, 'deposit', 'deposit(uint256,bool,bool,address)'),
  makeFunction(depositAllAbi, 'deposit-all', 'depositAll(bool,bool,address)'),
];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];

export const STAKEDAO_CRV_DEPOSITOR_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildStakeDaoCrvDepositorRegistry(): DefiRegistryFragment { return { chains }; }

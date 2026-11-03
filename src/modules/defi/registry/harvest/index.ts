import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const vault = '0xf0358e8c3CD5Fa238a29301d0bEa3D63A17bEdBE';
const sourceRef = 'harvest-vault-interface';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });

const depositAbi: AbiFunction = {
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [uint('amountWei')], outputs: [],
};
const withdrawAbi: AbiFunction = {
  type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
  inputs: [uint('numberOfShares')], outputs: [],
};

function makeFunction(abi: AbiFunction, operation: 'deposit' | 'withdraw'): DefiFunctionPolicy {
  return {
    capabilityId: `harvest:v1:${chainId}:${vault.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: vault, functionName: operation,
    signature: `${operation}(uint256)`, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Harvest Finance', operation, label: `Harvest fUSDC vault ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current code or liquidity proof, or funded-execution certification.',
      'Pinned source identifies this Ethereum vault as an fUSDC vault over USDC. Deposit pulls underlying from the caller and mints vault shares to the caller; withdrawal redeems caller-held shares for underlying, subject to the vault implementation.',
      'Caller-controlled amount/shares remain ABI-valid uint256 values without platform caps or owner/feed restrictions. Token allowance, vault access/amount conditions, fees, available assets, and current vault state remain protocol prerequisites; approvals are independent and not paired.',
    ],
  };
}

const functions = [makeFunction(depositAbi, 'deposit'), makeFunction(withdrawAbi, 'withdraw')];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: vault, status: 'active', functions }] }];

export const HARVEST_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildHarvestRegistry(): DefiRegistryFragment { return { chains }; }

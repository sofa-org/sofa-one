import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const target = '0x9d39a5de30e57443bff2a8307a4256c8797a3497';
const sourceRef = 'ethena-sourcify-staked-usde-v2';
const uint256 = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const unnamedUint = () => ({ name: '', type: 'uint256', internalType: 'uint256' });

// Complete function metadata copied from the exact-match Sourcify record.
const declarations: readonly { operation: string; abi: AbiFunction }[] = [
  { operation: 'deposit', abi: { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint256('assets'), address('receiver')], outputs: [unnamedUint()] } },
  { operation: 'mint', abi: { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint256('shares'), address('receiver')], outputs: [unnamedUint()] } },
  { operation: 'cooldown-assets', abi: { type: 'function', name: 'cooldownAssets', stateMutability: 'nonpayable', inputs: [uint256('assets')], outputs: [uint256('shares')] } },
  { operation: 'cooldown-shares', abi: { type: 'function', name: 'cooldownShares', stateMutability: 'nonpayable', inputs: [uint256('shares')], outputs: [uint256('assets')] } },
  { operation: 'unstake', abi: { type: 'function', name: 'unstake', stateMutability: 'nonpayable', inputs: [address('receiver')], outputs: [] } },
  { operation: 'withdraw', abi: { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [uint256('assets'), address('receiver'), address('_owner')], outputs: [unnamedUint()] } },
  { operation: 'redeem', abi: { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [uint256('shares'), address('receiver'), address('_owner')], outputs: [unnamedUint()] } },
];

function makeFunction({ abi, operation }: typeof declarations[number]): DefiFunctionPolicy {
  return {
    capabilityId: `ethena:staked-usde-v2:${chainId}:${target}:${operation}`,
    type: 'contract_call', chainId, contract: target, functionName: abi.name,
    signature: `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Ethena', operation, label: `Ethena sUSDe ${abi.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, an automatic grant, current contract-mode/duration observation, current liquidity, or funded-execution certification.',
      'All ABI-valid amounts, receivers, and _owner arguments remain caller controlled; no platform financial caps, owner restriction, price/feed policy, or approval coupling is imposed.',
      'sUSDe mode is conditional: positive cooldown duration enables cooldownAssets/cooldownShares and disables withdraw/redeem; zero duration enables ERC-4626 withdraw/redeem and disables cooldown methods. The current duration is not observed. Unstake sends the caller-associated silo balance to the selected receiver only when cooldown has elapsed or duration is zero; protocol blacklist and cooldown timing remain intrinsic conditions. USDe approval is a separate independent permission and is not included or automatic.',
    ],
  };
}

const functions = declarations.map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];

export const ETHENA_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline policy tests only; not runtime wired or automatically granted. */
export function buildEthenaRegistry(): DefiRegistryFragment { return { chains }; }

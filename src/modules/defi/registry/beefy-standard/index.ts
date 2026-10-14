import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 8453;
const morphoEurc = '0x01F1A592B0b757B2931bbcCf28227cdC1e892dde';
const aerodromeWethLcap = '0x028baCa249B33d24FC32ac01d6531F6be0061c8E';
const sourceRef = 'docs/defi-research/expansion55-beefy-v5.md (official Beefy API snapshot and beefy-v2 commit 97385b9a832316d78a4c595319352726d5a322a7)';
const specs = [
  { contract: morphoEurc, name: 'deposit', operation: 'deposit', inputs: [{ name: '_amount', type: 'uint256', internalType: 'uint256' }], label: 'Beefy vault deposit' },
  { contract: morphoEurc, name: 'depositAll', operation: 'deposit-all', inputs: [], label: 'Beefy vault deposit all' },
  { contract: morphoEurc, name: 'withdraw', operation: 'withdraw', inputs: [{ name: '_shares', type: 'uint256', internalType: 'uint256' }], label: 'Beefy vault withdraw' },
  { contract: morphoEurc, name: 'withdrawAll', operation: 'withdraw-all', inputs: [], label: 'Beefy vault withdraw all' },
  { contract: aerodromeWethLcap, name: 'deposit', operation: 'deposit', inputs: [{ name: '_amount', type: 'uint256', internalType: 'uint256' }], label: 'Beefy vault deposit' },
  { contract: aerodromeWethLcap, name: 'depositAll', operation: 'deposit-all', inputs: [], label: 'Beefy vault deposit all' },
  { contract: aerodromeWethLcap, name: 'withdraw', operation: 'withdraw', inputs: [{ name: '_shares', type: 'uint256', internalType: 'uint256' }], label: 'Beefy vault withdraw' },
  { contract: aerodromeWethLcap, name: 'withdrawAll', operation: 'withdraw-all', inputs: [], label: 'Beefy vault withdraw all' },
] as const;

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: [...spec.inputs], outputs: [] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return {
    capabilityId: `beefy-standard:v1:${chainId}:${spec.contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Beefy', operation: spec.operation, label: spec.label,
    warnings: [
      'Source-qualified inactive candidate fixture only; API status is mutable and does not establish deployed code identity, current vault implementation, liquidity, or funded execution.',
      ...(spec.operation.startsWith('deposit')
        ? ['Deposit amounts are caller-controlled; depositAll uses the caller underlying-asset balance. The underlying asset must be separately available and approved; this capability does not grant token approval.']
        : ['Withdrawal amounts are caller-controlled share units; withdrawAll uses the caller vault share balance. Redemption may depend on available liquidity and does not guarantee an outcome.']),
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: morphoEurc, status: 'active', functions: functions.slice(0, 4) },
  { address: aerodromeWethLcap, status: 'active', functions: functions.slice(4) },
] }];

/** Source fixture only; intentionally not wired into a runtime registry. */
export function buildBeefyStandardRegistry(): DefiRegistryFragment { return { chains }; }

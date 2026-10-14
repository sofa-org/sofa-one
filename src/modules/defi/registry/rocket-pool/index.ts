import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const depositPool = '0xDD3f50F8A6CafbE9b31a427582963f465E745AF8';
const reth = '0xae78736Cd615f374D3085123A210448E74Fc6393';
const sourceRef = 'docs/defi-research/expansion55-rocket-pool-v5.md (Rocket Pool official docs pinned at docs.rocketpool.net commit f5ebf7e5b387bd3b10d8ecdeeb37dc6c387688b3; Rocket Pool interfaces pinned at fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88)';
const specs = [
  { contract: depositPool, name: 'deposit', operation: 'deposit', mutability: 'payable', inputs: [], outputs: [], label: 'RocketPool ETH deposit' },
  { contract: reth, name: 'burn', operation: 'burn', mutability: 'nonpayable', inputs: [{ name: '_rethAmount', type: 'uint256' }], outputs: [], label: 'RocketPool rETH redeem' },
] as const;
const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return {
    capabilityId: `rocket-pool:v1:${chainId}:${spec.contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Rocket Pool', operation: spec.operation, label: spec.label,
    warnings: [
      'This is an inactive source-qualified fixture; the snapshot is not runtime-code verification, current dynamic-registry resolution, or proof of funded execution.',
      ...(spec.name === 'burn' ? ['rETH burn redemption depends on available liquid ETH and may revert when liquidity is insufficient; a redeemable amount or successful outcome is not guaranteed.'] : ['Caller controls payable ETH value; no amount limit or deposit outcome is guaranteed.']),
    ],
  };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: depositPool, status: 'active', functions: [functions[0]] },
  { address: reth, status: 'active', functions: [functions[1]] },
] }];

/** Source fixture only; intentionally not wired into a runtime registry. */
export function buildRocketPoolRegistry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const targets = [
  { address: '0xf951E335afb289353dc249e82926178EaC7DEd78', name: 'swETH' },
  { address: '0xfAe103DC9cf190eD75350761e95403b7b8aFa6c0', name: 'rswETH' },
] as const;
const methodSpecs: readonly { name: 'deposit' | 'depositWithReferral'; inputs: AbiFunction['inputs'] }[] = [
  { name: 'deposit', inputs: [] },
  { name: 'depositWithReferral', inputs: [{ name: 'referral', type: 'address', internalType: 'address' }] },
];

function makeFunction(target: typeof targets[number], spec: typeof methodSpecs[number]): DefiFunctionPolicy {
  const operation = spec.name === 'deposit' ? 'deposit' : 'deposit-with-referral';
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: 'payable', inputs: spec.inputs, outputs: [] };
  const interfaceSource = target.name === 'swETH' ? 'swell-sweth-interface' : 'swell-rsweth-interface';
  return {
    capabilityId: `swell:v1:${chainId}:${target.address.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: target.address, functionName: spec.name, signature: `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`, abi,
    status: 'active', provenance: { sourceRef: interfaceSource, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Swell', operation, label: `Swell ${target.name} ${spec.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, funded execution, liquidity, or deposit-success certification.',
      'The caller chooses payable native value and, for depositWithReferral, any ABI-valid referral address; no platform amount, receiver, referral, asset, owner, or feed policy is added.',
      'Only the two deposit entrypoints are included; exits, approvals, generic NFT operations, permit, and multicall are independent or unresolved and are not authorized here.',
    ],
  };
}

const functions = targets.flatMap((target) => methodSpecs.map((spec) => makeFunction(target, spec)));
const chains: DefiChainPolicy[] = [{
  chainId, status: 'active',
  contracts: targets.map((target) => ({ address: target.address, status: 'active' as const, functions: functions.filter((fn) => fn.contract === target.address) })),
}];

export const SWELL_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline policy tests only; not runtime wired or automatically granted. */
export function buildSwellRegistry(): DefiRegistryFragment { return { chains }; }

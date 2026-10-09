import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const pool = '0xC155444481854c60e7a29f4150373f479988F32D';
const sourceRef = 'gearbox-sdk-pool-abi';
const address = (name: string) => ({ name, internalType: 'address', type: 'address' });
const uint256 = (name: string) => ({ name, internalType: 'uint256', type: 'uint256' });

// Full function objects as published in the pinned Gearbox SDK iPoolV310Abi.
const declarations: readonly { abi: AbiFunction; operation: string }[] = [
  {
    operation: 'deposit',
    abi: {
      type: 'function', name: 'deposit', stateMutability: 'nonpayable',
      inputs: [uint256('assets'), address('receiver')],
      outputs: [uint256('shares')],
    },
  },
  {
    operation: 'mint',
    abi: {
      type: 'function', name: 'mint', stateMutability: 'nonpayable',
      inputs: [uint256('shares'), address('receiver')],
      outputs: [uint256('assets')],
    },
  },
  {
    operation: 'withdraw',
    abi: {
      type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
      inputs: [uint256('assets'), address('receiver'), address('owner')],
      outputs: [uint256('shares')],
    },
  },
  {
    operation: 'redeem',
    abi: {
      type: 'function', name: 'redeem', stateMutability: 'nonpayable',
      inputs: [uint256('shares'), address('receiver'), address('owner')],
      outputs: [uint256('assets')],
    },
  },
];

function makeFunction({ abi, operation }: typeof declarations[number]): DefiFunctionPolicy {
  const signature = `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`;
  return {
    capabilityId: `gearbox-pool:versionv3-10:${chainId}:${pool.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: pool, functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Gearbox', operation, label: `Gearbox Pool V3.10 ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; it is not production admission, an automatic grant, a current liquidity/block observation, or funded-execution certification.',
      'Caller controls all ABI-valid amount, receiver, and owner arguments; this fixture adds no financial cap, owner restriction, health-factor/feed gate, approval pairing, or asset restriction.',
      'Protocol share conversion, solvency, allowance, pool liquidity, and withdrawal limits remain intrinsic protocol behavior/prerequisites. Only the four direct Pool V3.10 ERC-4626 operations are selected; credit-facade leverage, batch/general executors, zappers, permits, approvals, and administrative calls are not granted.',
    ],
  };
}

const functions = declarations.map(makeFunction);
const chains: DefiChainPolicy[] = [{
  chainId,
  status: 'active',
  contracts: [{ address: pool, status: 'active', functions }],
}];

export const GEARBOX_POOL_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline policy tests only; not runtime wired or automatically granted. */
export function buildGearboxPoolRegistry(): DefiRegistryFragment { return { chains }; }

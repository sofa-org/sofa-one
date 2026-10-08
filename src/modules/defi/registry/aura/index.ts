import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const booster = '0xA57b8d98dAE62B26Ec3bcC4a365338157060B234';
const rewardPool = '0x712CC5BeD99aA06fC4D5FB50Aea3750fA5161D0f';
const sourceRef = 'docs/defi-research/expansion55-aura-v5.md (Aura Phase 6 deployment/config commit 36599d53946aab701e2a1757e164261f49529399; Aura-owned convex-platform implementation e7c23cfeec5ef9beb4873d87069363ee458fc184; historical pool 0 read at block 0x18e885f)';

const specs: readonly { contract: string; name: string; operation: string; inputs: AbiFunction['inputs']; label: string }[] = [
  { contract: booster, name: 'deposit', operation: 'deposit', inputs: [{ name: '_pid', type: 'uint256', internalType: 'uint256' }, { name: '_amount', type: 'uint256', internalType: 'uint256' }, { name: '_stake', type: 'bool', internalType: 'bool' }], label: 'Aura deposit and optionally stake' },
  { contract: booster, name: 'depositAll', operation: 'deposit-all', inputs: [{ name: '_pid', type: 'uint256', internalType: 'uint256' }, { name: '_stake', type: 'bool', internalType: 'bool' }], label: 'Aura deposit all and optionally stake' },
  { contract: booster, name: 'withdraw', operation: 'withdraw', inputs: [{ name: '_pid', type: 'uint256', internalType: 'uint256' }, { name: '_amount', type: 'uint256', internalType: 'uint256' }], label: 'Aura withdraw' },
  { contract: booster, name: 'withdrawAll', operation: 'withdraw-all', inputs: [{ name: '_pid', type: 'uint256', internalType: 'uint256' }], label: 'Aura withdraw all' },
  { contract: rewardPool, name: 'withdrawAndUnwrap', operation: 'withdraw-and-unwrap', inputs: [{ name: 'amount', type: 'uint256', internalType: 'uint256' }, { name: 'claim', type: 'bool', internalType: 'bool' }], label: 'Aura withdraw and unwrap existing reward-pool position' },
  { contract: rewardPool, name: 'getReward', operation: 'get-reward', inputs: [], label: 'Aura claim rewards for caller' },
];

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: [...spec.inputs], outputs: [{ name: '', type: 'bool', internalType: 'bool' }] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  const warnings = [
    'Source-qualified fixture only: not production admission, current deployed-runtime verification, funded execution, liquidity, or proof that a transaction will succeed.',
    'Pool IDs, amounts, and _stake/claim booleans remain caller-controlled ABI values; no platform PID/asset/amount allowlist or financial cap is applied. Protocol pool status, intrinsic conditions, and shutdown state control business execution.',
    'No currently open Aura deposit pool was verified. These Booster declarations do not certify a deposit-ready workflow; sampling some pools as shut down does not establish that all 283 pools are shut down.',
    'Required LP/deposit-token approvals remain independent and are not bundled or automatically granted.',
    'The declared bool return is not an economic-success guarantee.',
  ];
  if (spec.operation === 'deposit-all' || spec.operation === 'withdraw-all') warnings.push('This all-balance method acts on the caller balance of the selected pool token/deposit token and may affect the full balance.');
  if (spec.contract === rewardPool) warnings.push('This reward pool was returned for Booster pool 0 in a historical read whose shutdown flag was true. These methods are scoped only to exiting/claiming an existing position at that exact reward-pool target, not new-stake readiness, current liquidity, or all Aura reward pools.');
  if (spec.operation === 'withdraw-and-unwrap') warnings.push('Aura-owned implementation calls the Booster operator withdrawal path; only the pool-0 reward contract role is evidenced here, not an arbitrary reward-pool operator relationship.');
  return {
    capabilityId: `aura:v1:${chainId}:${spec.contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Aura', operation: spec.operation, label: spec.label, warnings,
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: booster, status: 'active', functions: functions.filter((fn) => fn.contract === booster) },
  { address: rewardPool, status: 'active', functions: functions.filter((fn) => fn.contract === rewardPool) },
] }];

/** Explicit test fixture only; not wired into production registry admission. */
export function buildAuraRegistry(): DefiRegistryFragment { return { chains }; }

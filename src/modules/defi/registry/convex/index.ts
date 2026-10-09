import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const booster = '0xF403C135812408BFbE8713b5A23a04b3D48AAE31';
const rewardPool = '0xf34DFF761145FF0B05e917811d488B441F33a968';
const sourceRef = 'docs/defi-research/expansion55-convex-v5.md (convex-eth/platform commit 4f22038387ca4ce014dec3d7f5781a8e28051c13; Ethereum pool 0 record at block 0x18e86c7)';

const specs: readonly { contract: string; name: string; operation: string; inputs: AbiFunction['inputs']; label: string }[] = [
  { contract: booster, name: 'deposit', operation: 'deposit', inputs: [{ name: '_pid', type: 'uint256' }, { name: '_amount', type: 'uint256' }, { name: '_stake', type: 'bool' }], label: 'Convex deposit and optionally stake' },
  { contract: booster, name: 'depositAll', operation: 'deposit-all', inputs: [{ name: '_pid', type: 'uint256' }, { name: '_stake', type: 'bool' }], label: 'Convex deposit all LP tokens and optionally stake' },
  { contract: booster, name: 'withdraw', operation: 'withdraw', inputs: [{ name: '_pid', type: 'uint256' }, { name: '_amount', type: 'uint256' }], label: 'Convex withdraw LP tokens' },
  { contract: booster, name: 'withdrawAll', operation: 'withdraw-all', inputs: [{ name: '_pid', type: 'uint256' }], label: 'Convex withdraw all LP tokens' },
  { contract: rewardPool, name: 'withdrawAndUnwrap', operation: 'withdraw-and-unwrap', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'claim', type: 'bool' }], label: 'Convex withdraw and unwrap staked LP tokens' },
  { contract: rewardPool, name: 'getReward', operation: 'get-reward', inputs: [], label: 'Convex claim rewards' },
];

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: [...spec.inputs], outputs: [{ name: '', type: 'bool' }] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  const warnings = [
    'This source-qualified fixture is not a production admission, current pool/runtime verification, funded-execution proof, or a claim of complete Convex coverage.',
    'Pool ID, amount, and stake/claim booleans are caller-controlled ABI values without platform-specific caps, token/PID allowlists, receiver/owner checks, or approval coupling.',
    'LP/deposit-token ERC-20 approval is independent and is not included or automatically granted; the fixture does not certify a fully prefunded workflow.',
  ];
  if (spec.operation === 'deposit-all' || spec.operation === 'withdraw-all') warnings.push('This all-balance operation uses the caller wallet balance for its LP/deposit token and may affect the full available balance.');
  if (spec.operation === 'deposit' || spec.operation === 'deposit-all') warnings.push('When _stake is true the Booster stakes for the caller; when false it issues the pool deposit token for a later Booster withdrawal. Protocol shutdown, fees, pool state, and intrinsic eligibility can affect execution.');
  if (spec.operation === 'withdraw-and-unwrap') warnings.push('This operation withdraws the caller position from the reward pool; `claim` controls the source-declared reward-claim behavior.');
  if (spec.operation === 'get-reward') warnings.push('The zero-argument caller method claims for msg.sender and includes extra rewards according to the source implementation; other getReward overloads are excluded.');
  if (spec.contract === rewardPool) warnings.push('This one reward-pool address was historically returned for Booster pool 0; it is not an inventory of Convex pools. The source-declared bool return is not a guarantee of economic success or current liquidity.');
  return {
    capabilityId: `convex:v1:${chainId}:${spec.contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Convex', operation: spec.operation, label: spec.label, warnings,
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: booster, status: 'active', functions: functions.filter((fn) => fn.contract === booster) },
  { address: rewardPool, status: 'active', functions: functions.filter((fn) => fn.contract === rewardPool) },
] }];

/** Explicit source fixture only; not wired into a runtime registry. */
export function buildConvexRegistry(): DefiRegistryFragment { return { chains }; }

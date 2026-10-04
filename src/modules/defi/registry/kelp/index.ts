import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const depositPool = '0x036676389e48133B63a802f8635AD39E752D375D';
const withdrawalManager = '0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16';
const sourceRef = 'docs/defi-research/expansion55-kelp-v5.md (Kelp-DAO/LRT-rsETH commit 3dded885f6f797f5959aff449c3a30c5cbb6ce23)';

const specs: readonly { contract: string; name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; label: string }[] = [
  { contract: depositPool, name: 'depositETH', operation: 'deposit-eth', mutability: 'payable', inputs: [{ name: 'minRSETHAmountExpected', type: 'uint256' }, { name: 'referralId', type: 'string' }], label: 'Kelp deposit ETH' },
  { contract: depositPool, name: 'depositAsset', operation: 'deposit-asset', mutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'depositAmount', type: 'uint256' }, { name: 'minRSETHAmountExpected', type: 'uint256' }, { name: 'referralId', type: 'string' }], label: 'Kelp deposit asset' },
  { contract: withdrawalManager, name: 'initiateWithdrawal', operation: 'initiate-withdrawal', mutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'rsETHUnstaked', type: 'uint256' }, { name: 'referralId', type: 'string' }], label: 'Kelp initiate withdrawal' },
  { contract: withdrawalManager, name: 'completeWithdrawal', operation: 'complete-withdrawal', mutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'referralId', type: 'string' }], label: 'Kelp complete withdrawal' },
];

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  const selector = toFunctionSelector(signature);
  const warnings = [
    'This source-qualified fixture is not a production admission, live implementation/runtime verification, funded-execution proof, or a claim of complete Kelp coverage.',
    'Arguments including asset, amount, minimum output, referral string, and withdrawal choice remain caller-controlled ABI values; no protocol-specific financial policy or automatic token approval is implied.',
  ];
  if (spec.operation === 'initiate-withdrawal') warnings.push('rsETHUnstaked is denominated in rsETH, not the selected withdrawal asset.');
  if (spec.operation === 'complete-withdrawal') warnings.push('Completion is user-initiated only after operator unlock, configured delay, and liquidity; it is not an instant exit. The management delay is configurable (initialized to eight days in source), not guaranteed to remain exactly eight days.');
  return {
    capabilityId: `kelp:v1:${chainId}:${spec.contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Kelp', operation: spec.operation, label: spec.label, warnings,
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: depositPool, status: 'active', functions: functions.filter((fn) => fn.contract === depositPool) },
  { address: withdrawalManager, status: 'active', functions: functions.filter((fn) => fn.contract === withdrawalManager) },
] }];

/** Explicit source fixture only; not wired into a runtime registry. */
export function buildKelpRegistry(): DefiRegistryFragment { return { chains }; }

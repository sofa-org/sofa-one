import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const router = '0x888888888889758F76e7103c6CbF23ABbF58F946';
const standardizedYield = '0xcad69479358c1ef3560f29f278966df772abf42f';
const sourceRef = 'docs/defi-research/expansion55-pendle-v5.md (pendle-finance/pendle-core-v2-public commit 87685c89d05087535e9b9647eeda0e3d297d1f06)';

const specs: readonly { contract: string; name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; label: string }[] = [
  { contract: router, name: 'addLiquidityDualSyAndPt', operation: 'add-liquidity-dual-sy-pt', mutability: 'nonpayable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'market', type: 'address' }, { name: 'netSyDesired', type: 'uint256' }, { name: 'netPtDesired', type: 'uint256' }, { name: 'minLpOut', type: 'uint256' }], outputs: [{ name: 'netLpOut', type: 'uint256' }, { name: 'netSyUsed', type: 'uint256' }, { name: 'netPtUsed', type: 'uint256' }], label: 'Pendle add liquidity using SY and PT' },
  { contract: router, name: 'removeLiquidityDualSyAndPt', operation: 'remove-liquidity-dual-sy-pt', mutability: 'nonpayable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'market', type: 'address' }, { name: 'netLpToRemove', type: 'uint256' }, { name: 'minSyOut', type: 'uint256' }, { name: 'minPtOut', type: 'uint256' }], outputs: [{ name: 'netSyOut', type: 'uint256' }, { name: 'netPtOut', type: 'uint256' }], label: 'Pendle remove liquidity to SY and PT' },
  { contract: router, name: 'mintPyFromSy', operation: 'mint-py-from-sy', mutability: 'nonpayable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'YT', type: 'address' }, { name: 'netSyIn', type: 'uint256' }, { name: 'minPyOut', type: 'uint256' }], outputs: [{ name: 'netPyOut', type: 'uint256' }], label: 'Pendle mint PY from SY' },
  { contract: router, name: 'redeemPyToSy', operation: 'redeem-py-to-sy', mutability: 'nonpayable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'YT', type: 'address' }, { name: 'netPyIn', type: 'uint256' }, { name: 'minSyOut', type: 'uint256' }], outputs: [{ name: 'netSyOut', type: 'uint256' }], label: 'Pendle redeem PY to SY' },
  { contract: standardizedYield, name: 'deposit', operation: 'deposit-sy', mutability: 'payable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'amountTokenToDeposit', type: 'uint256' }, { name: 'minSharesOut', type: 'uint256' }], outputs: [{ name: 'amountSharesOut', type: 'uint256' }], label: 'Pendle deposit into SY' },
  { contract: standardizedYield, name: 'redeem', operation: 'redeem-sy', mutability: 'nonpayable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'amountSharesToRedeem', type: 'uint256' }, { name: 'tokenOut', type: 'address' }, { name: 'minTokenOut', type: 'uint256' }, { name: 'burnFromInternalBalance', type: 'bool' }], outputs: [{ name: 'amountTokenOut', type: 'uint256' }], label: 'Pendle redeem SY' },
];

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  const warning = [
    'This source-qualified fixture is not a production admission, current facet/runtime verification, funded-execution proof, or a claim of complete Pendle coverage.',
    'Receiver, market/YT/token, amounts, minimum outputs, and SY internal-balance choice remain caller-controlled ABI arguments; no financial limits or asset/market allowlist are implied.',
    'Required underlying/SY/PT/PY/YT/LP token approvals are independent capabilities and are neither included nor automatically coupled. A single function grant does not establish a complete funding path.',
  ];
  if (spec.contract === router) warning.push('The official interface is bound to the source-declared router role and facet interfaces; direct router methods may invoke protocol-owned internal flows. Arbitrary wallet multicalls, swaps, zaps, token-input payloads, limit orders, and callback executors are excluded.');
  if (spec.operation === 'redeem-py-to-sy') warning.push('Before expiry PY redemption requires the applicable PT and YT position; no position/ownership or outcome guarantee is asserted.');
  if (spec.operation === 'deposit-sy') warning.push('The documented SY deposit is payable; value is structurally permitted, but protocol acceptance depends on the chosen token and amount.');
  return {
    capabilityId: `pendle-v3:v3:${chainId}:${spec.contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Pendle', operation: spec.operation, label: spec.label, warnings: warning,
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: router, status: 'active', functions: functions.filter((fn) => fn.contract === router) },
  { address: standardizedYield, status: 'active', functions: functions.filter((fn) => fn.contract === standardizedYield) },
] }];

/** Explicit source fixture only; not wired into a runtime registry. */
export function buildPendleV3Registry(): DefiRegistryFragment { return { chains }; }

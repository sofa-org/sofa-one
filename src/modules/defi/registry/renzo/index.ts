import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const manager = '0x74a09653A083691711cF8215a6ab074BB4e99ef5';
const queue = '0x5efc9D10E42FB517456f4ac41EB5e2eBe42C8918';
const sourceRef = 'renzo-contracts-public-fc8c8e08';
const u = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const specs: { contract: string; name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; label: string }[] = [
  { contract: manager, name: 'depositETH', operation: 'deposit-eth', mutability: 'payable', inputs: [], label: 'Renzo deposit ETH' },
  { contract: manager, name: 'depositETH', operation: 'deposit-eth-referral', mutability: 'payable', inputs: [u('_referralId')], label: 'Renzo deposit ETH with referral' },
  { contract: manager, name: 'deposit', operation: 'deposit-erc20', mutability: 'nonpayable', inputs: [{ name: '_collateralToken', type: 'address', internalType: 'contract IERC20' }, u('_amount')], label: 'Renzo deposit ERC-20 collateral' },
  { contract: manager, name: 'deposit', operation: 'deposit-erc20-referral', mutability: 'nonpayable', inputs: [{ name: '_collateralToken', type: 'address', internalType: 'contract IERC20' }, u('_amount'), u('_referralId')], label: 'Renzo deposit ERC-20 collateral with referral' },
  { contract: queue, name: 'withdraw', operation: 'withdraw', mutability: 'nonpayable', inputs: [u('_amount'), { name: '_assetOut', type: 'address', internalType: 'address' }], label: 'Renzo request withdrawal' },
  { contract: queue, name: 'claim', operation: 'claim', mutability: 'nonpayable', inputs: [u('withdrawRequestIndex'), { name: 'user', type: 'address', internalType: 'address' }], label: 'Renzo claim withdrawal request' },
];
const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: spec.inputs, outputs: [] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  const selector = toFunctionSelector(signature).slice(2);
  return { capabilityId: `renzo:v1:${chainId}:${spec.contract.toLowerCase()}:${selector}`, type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Renzo', operation: spec.operation, label: spec.label, warnings: ['Source-qualified test fixture only; not production admission, funded execution, complete Renzo coverage, liquidity or protocol-safety certification.', 'Caller controls ABI-valid token, amount, referral, withdrawal request index, and asset selection. No asset, recipient, owner, financial-cap, or approval pairing restriction is implied.', 'Protocol-intrinsic collateral eligibility, pause/cooldown/risk-oracle checks, liquidity, and asynchronous queue behavior are protocol conditions, not platform allowlists or execution guarantees. ERC-20 allowance/funding is independent and not automatically coupled.'] };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [manager, queue].map((address) => ({ address, status: 'active', functions: functions.filter((fn) => fn.contract === address) })) }];
export function buildRenzoRegistry(): DefiRegistryFragment { return { chains }; }

import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 42161;
const target = '0xf8b2c637A68cF6A17b1DF9F8992EeBeFf63d2dFf';
const sourceRef = 'docs/defi-research/expansion55-dolomite-v5.md (Dolomite official router documentation and IDepositWithdrawalRouter source)';
type Spec = { name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; label: string };
const base = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const flag = (name: string, internalType: string) => ({ name, type: 'uint8', internalType });
const specs: Spec[] = [
  { name: 'depositWei', operation: 'deposit-wei', mutability: 'nonpayable', inputs: [base('_isolationModeMarketId'), base('_toAccountNumber'), base('_marketId'), base('_amountWei'), flag('_eventFlag', 'enum IDepositWithdrawalRouter.EventFlag')], label: 'Dolomite deposit Wei' },
  { name: 'depositPayable', operation: 'deposit-payable', mutability: 'payable', inputs: [base('_isolationModeMarketId'), base('_toAccountNumber'), flag('_eventFlag', 'enum IDepositWithdrawalRouter.EventFlag')], label: 'Dolomite payable deposit' },
  { name: 'depositPar', operation: 'deposit-par', mutability: 'nonpayable', inputs: [base('_isolationModeMarketId'), base('_toAccountNumber'), base('_marketId'), base('_amountPar'), flag('_eventFlag', 'enum IDepositWithdrawalRouter.EventFlag')], label: 'Dolomite deposit Par' },
  { name: 'withdrawWei', operation: 'withdraw-wei', mutability: 'nonpayable', inputs: [base('_isolationModeMarketId'), base('_fromAccountNumber'), base('_marketId'), base('_amountWei'), flag('_balanceCheckFlag', 'enum AccountBalanceLib.BalanceCheckFlag')], label: 'Dolomite withdraw Wei' },
  { name: 'withdrawPayable', operation: 'withdraw-payable', mutability: 'nonpayable', inputs: [base('_isolationModeMarketId'), base('_fromAccountNumber'), base('_amountWei'), flag('_balanceCheckFlag', 'enum AccountBalanceLib.BalanceCheckFlag')], label: 'Dolomite withdraw payable' },
  { name: 'withdrawPar', operation: 'withdraw-par', mutability: 'nonpayable', inputs: [base('_isolationModeMarketId'), base('_fromAccountNumber'), base('_marketId'), base('_amountPar'), flag('_balanceCheckFlag', 'enum AccountBalanceLib.BalanceCheckFlag')], label: 'Dolomite withdraw Par' },
];
const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: spec.inputs, outputs: [] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return { capabilityId: `dolomite-router:v1:${chainId}:${target.toLowerCase()}:${spec.operation}`, type: 'contract_call', chainId, contract: target, functionName: spec.name, signature, abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Dolomite', operation: spec.operation, label: spec.label, warnings: ['Source-qualified test fixture only, not production admission, implementation/runtime verification, funded execution, or a liquidity/health-factor guarantee.', 'Account numbers, isolation-mode and market IDs, amounts, enum flags, and caller-controlled accounts remain unrestricted ABI arguments; uint256-max amounts can represent entire balances. A withdrawal can create debt and is not an instant-liquidity promise.', 'Token approvals are independent and not automatically coupled. This fixed interface exposes selected internal deposit/withdraw operations only; generic DolomiteMargin.operate and other router methods are excluded.'] };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];
export function buildDolomiteRouterRegistry(): DefiRegistryFragment { return { chains }; }
export const dolomiteRouterSelectors = specs.map((spec) => toFunctionSelector(`${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`));

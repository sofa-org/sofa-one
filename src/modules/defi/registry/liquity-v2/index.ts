import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const familyVersion = 'v2-weth';
const borrowerOperations = '0x372abd1810eaf23cb9d941bbe7596dfb2c46bc65';
const stabilityPool = '0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const bool = (name: string) => ({ name, type: 'bool', internalType: 'bool' });
const borrowerMethods: readonly AbiFunction[] = [
  { type: 'function', name: 'openTrove', stateMutability: 'nonpayable', inputs: [address('_owner'), uint('_ownerIndex'), uint('_collAmount'), uint('_boldAmount'), uint('_upperHint'), uint('_lowerHint'), uint('_annualInterestRate'), uint('_maxUpfrontFee'), address('_addManager'), address('_removeManager'), address('_receiver')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'addColl', stateMutability: 'nonpayable', inputs: [uint('_troveId'), uint('_collAmount')], outputs: [] },
  { type: 'function', name: 'withdrawColl', stateMutability: 'nonpayable', inputs: [uint('_troveId'), uint('_amount')], outputs: [] },
  { type: 'function', name: 'withdrawBold', stateMutability: 'nonpayable', inputs: [uint('_troveId'), uint('_amount'), uint('_maxUpfrontFee')], outputs: [] },
  { type: 'function', name: 'repayBold', stateMutability: 'nonpayable', inputs: [uint('_troveId'), uint('_amount')], outputs: [] },
  { type: 'function', name: 'adjustTrove', stateMutability: 'nonpayable', inputs: [uint('_troveId'), uint('_collChange'), bool('_isCollIncrease'), uint('_boldChange'), bool('_isDebtIncrease'), uint('_maxUpfrontFee')], outputs: [] },
  { type: 'function', name: 'closeTrove', stateMutability: 'nonpayable', inputs: [uint('_troveId')], outputs: [] },
];
const stabilityMethods: readonly AbiFunction[] = [
  { type: 'function', name: 'provideToSP', stateMutability: 'nonpayable', inputs: [uint('_amount'), bool('_doClaim')], outputs: [] },
  { type: 'function', name: 'withdrawFromSP', stateMutability: 'nonpayable', inputs: [uint('_amount'), bool('doClaim')], outputs: [] },
  { type: 'function', name: 'claimAllCollGains', stateMutability: 'nonpayable', inputs: [], outputs: [] },
];
function operationName(name: string): string { return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
function makeFunction(contract: string, abi: AbiFunction, sourceRef: string): DefiFunctionPolicy {
  const operation = operationName(abi.name);
  return {
    capabilityId: `liquity-v2:${familyVersion}:${chainId}:${contract.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract, functionName: abi.name,
    signature: `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Liquity V2', operation,
    label: `Liquity V2 WETH ${abi.name}`,
    warnings: [
      'Explicit reviewed active TEST fixture only; raw candidate source remains inactive. No production admission, automatic grant, runtime-readiness, funded-execution, or full-market certification.',
      'All ABI-valid amounts, trove IDs, owner/manager/receiver addresses, hints, rates, booleans, and fees remain caller-selected. No platform collateral, debt, health-factor, ownership, asset, oracle, allowance, or financial cap is imposed; token approvals are independent and never paired or auto-granted.',
      'Liquity protocol solvency rules, manager permissions, oracle state, token allowances, and branch availability are intrinsic prerequisites and are not evaluated by this fixture.',
      'Stability Pool claim behavior is source-dependent: provideToSP/withdrawFromSP with doClaim true claims, false may retain/stash gains; claimAllCollGains requires an eligible nonzero stashed gain. No guarantee of a claimable gain is implied.',
    ],
  };
}
const functions = [...borrowerMethods.map((abi) => makeFunction(borrowerOperations, abi, 'liquity-borrower-operations')), ...stabilityMethods.map((abi) => makeFunction(stabilityPool, abi, 'liquity-stability-pool'))];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: borrowerOperations, status: 'active', functions: functions.filter((fn) => fn.contract === borrowerOperations) },
  { address: stabilityPool, status: 'active', functions: functions.filter((fn) => fn.contract === stabilityPool) },
]}];
export const LIQUITY_V2_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Explicit active test fixture only; deliberately not wired to runtime registry or grants. */
export function buildLiquityV2Registry(): DefiRegistryFragment { return { chains }; }

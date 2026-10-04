import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const familyVersion = 'listed-impl-v5';
const vault = '0xD9A442856C234a39a81a089C06451EBAa4306a72';
const manager = '0xDdA0483184E75a5579ef9635ED14BacCf9d50283';
const uint = (name: string, bits: 128 | 256 = 256) => ({ name, type: `uint${bits}`, internalType: `uint${bits}` });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const vaultMethods: readonly AbiFunction[] = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'depositETH', stateMutability: 'payable', inputs: [address('receiver')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'depositStETH', stateMutability: 'nonpayable', inputs: [uint('stETHSharesAmount'), address('receiver')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), address('owner')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver'), address('owner')], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
];
const managerMethods: readonly AbiFunction[] = [
  { type: 'function', name: 'requestWithdrawal', stateMutability: 'nonpayable', inputs: [uint('pufETHAmount', 128), address('recipient')], outputs: [] },
];
function operationName(name: string): string { return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
function makeFunction(contract: string, abi: AbiFunction, sourceRef: string): DefiFunctionPolicy {
  const operation = abi.name === 'depositETH' ? 'deposit-eth' : operationName(abi.name);
  return {
    capabilityId: `puffer:v5-snapshot:1:${contract.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract, functionName: abi.name,
    signature: `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Puffer', operation,
    label: `Puffer ${abi.name}`,
    warnings: [
      'Explicit reviewed active TEST fixture only; raw source candidates remain inactive. Not production admission, automatic grant, current-version assertion, funded execution, liquidity, or economic-success certification.',
      'All ABI-valid amounts, receivers, owners, and recipients remain caller controlled; no platform financial cap or ownership validation is imposed. Allowances are independent, may use any spender and uint256 amount, and are never coupled or auto-granted.',
      'Vault fees and daily liquidity limits are intrinsic protocol conditions, not platform financial validators. Puffer configuration, allowance/funding, protocol readiness, safety, liquidity and population remain unproven.',
      'Withdrawal is asynchronous: requestWithdrawal queues a withdrawal. Source identifies completeQueuedWithdrawal/finalizeWithdrawals as restricted to a withdrawal-finalizer role; no ordinary user claim method is established here, so the complete exit cycle is not represented.',
    ],
  };
}
const functions = [...vaultMethods.map((abi) => makeFunction(vault, abi, 'puffer-vault-impl')), ...managerMethods.map((abi) => makeFunction(manager, abi, 'puffer-withdrawal-manager-impl'))];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: vault, status: 'active', functions: functions.filter((fn) => fn.contract === vault) },
  { address: manager, status: 'active', functions: functions.filter((fn) => fn.contract === manager) },
]}];
export const PUFFER_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Explicit active test fixture; deliberately not wired to the runtime registry or grants. */
export function buildPufferRegistry(): DefiRegistryFragment { return { chains }; }

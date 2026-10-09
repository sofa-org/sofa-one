import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const strategyManager = '0x858646372CC42E1A627fcE94aa7A7033e7CF075A';
const delegationManager = '0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A';
const strategySource = 'eigenlayer-strategy-manager-interface';
const delegationSource = 'eigenlayer-delegation-manager-interface';
const address = (name: string, internalType = 'address') => ({ name, type: 'address', internalType });
const uint = (name: string, type: 'uint32' | 'uint256') => ({ name, type, internalType: type });

const depositAbi: AbiFunction = {
  type: 'function', name: 'depositIntoStrategy', stateMutability: 'nonpayable',
  inputs: [address('strategy', 'contract IStrategy'), address('token', 'contract IERC20'), uint('amount', 'uint256')],
  outputs: [{ name: 'depositShares', type: 'uint256', internalType: 'uint256' }],
};
const queueAbi: AbiFunction = {
  type: 'function', name: 'queueWithdrawals', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple[]', internalType: 'struct IDelegationManagerTypes.QueuedWithdrawalParams[]', components: [
    { name: 'strategies', type: 'address[]', internalType: 'contract IStrategy[]' },
    { name: 'depositShares', type: 'uint256[]', internalType: 'uint256[]' },
    address('__deprecated_withdrawer'),
  ] }],
  outputs: [{ name: '', type: 'bytes32[]', internalType: 'bytes32[]' }],
};
const completeAbi: AbiFunction = {
  type: 'function', name: 'completeQueuedWithdrawal', stateMutability: 'nonpayable',
  inputs: [
    { name: 'withdrawal', type: 'tuple', internalType: 'struct IDelegationManagerTypes.Withdrawal', components: [
      address('staker'), address('delegatedTo'), address('withdrawer'), uint('nonce', 'uint256'), uint('startBlock', 'uint32'),
      { name: 'strategies', type: 'address[]', internalType: 'contract IStrategy[]' },
      { name: 'scaledShares', type: 'uint256[]', internalType: 'uint256[]' },
    ] },
    { name: 'tokens', type: 'address[]', internalType: 'contract IERC20[]' },
    { name: 'receiveAsTokens', type: 'bool', internalType: 'bool' },
  ],
  outputs: [],
};

const definitions: readonly { contract: string; abi: AbiFunction; sourceRef: string; operation: 'deposit-into-strategy' | 'queue-withdrawals' | 'complete-queued-withdrawal' }[] = [
  { contract: strategyManager, abi: depositAbi, sourceRef: strategySource, operation: 'deposit-into-strategy' },
  { contract: delegationManager, abi: queueAbi, sourceRef: delegationSource, operation: 'queue-withdrawals' },
  { contract: delegationManager, abi: completeAbi, sourceRef: delegationSource, operation: 'complete-queued-withdrawal' },
];

function signatureOf(abi: AbiFunction): string {
  return `${abi.name}(${abi.inputs.map((input) => input.type.startsWith('tuple')
    ? `(${(input as { components: readonly { type: string }[] }).components.map((component) => component.type).join(',')})${input.type.slice(5)}`
    : input.type).join(',')})`;
}

function makeFunction(definition: typeof definitions[number]): DefiFunctionPolicy {
  const { contract, abi, sourceRef, operation } = definition;
  return {
    capabilityId: `eigenlayer:v1-4-1:${chainId}:${contract.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract, functionName: abi.name, signature: signatureOf(abi), abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'EigenLayer', operation, label: `EigenLayer ${abi.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, live-code proof, funded execution, or liquidity certification.',
      'Caller-selected strategy, token, amount, arrays, staker/delegate/withdrawer identities, and receive-as-tokens choice remain ABI-controlled without platform financial, owner, or strategy allowlists.',
      'Strategy eligibility, token allowance, withdrawal queue delay, slashing, and source-required caller/staker completion semantics are intrinsic protocol prerequisites; they are not platform grant dependencies or guarantees.',
    ],
  };
}

const functions = definitions.map(makeFunction);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: strategyManager, status: 'active', functions: functions.filter((fn) => fn.contract === strategyManager) },
  { address: delegationManager, status: 'active', functions: functions.filter((fn) => fn.contract === delegationManager) },
] }];

export const EIGENLAYER_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildEigenLayerRegistry(): DefiRegistryFragment { return { chains }; }

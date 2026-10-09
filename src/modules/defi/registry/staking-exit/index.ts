import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const ADDRESS = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';
const SOURCE = 'https://docs.lido.fi/deployed-contracts (snapshot 2026-10-03); https://docs.lido.fi/contracts/withdrawal-queue-erc721; https://github.com/lidofinance/core/blob/b71ac05c1546cc7bc37d4fcd6eafec5d2b7f3593/contracts/0.8.9/WithdrawalQueue.sol';
const DATE = '2026-10-03';
const specs: readonly { name: string; signature: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; operation: string; warning: string }[] = [
  { name: 'requestWithdrawals', signature: 'requestWithdrawals(uint256[],address)', inputs: [{ name: '_amounts', type: 'uint256[]' }, { name: '_owner', type: 'address' }], outputs: [{ name: 'requestIds', type: 'uint256[]' }], operation: 'request-withdrawal', warning: 'Withdrawal requests are asynchronous and require protocol finalization before claim; no instant liquidity is guaranteed. Caller controls amounts and NFT owner.' },
  { name: 'requestWithdrawalsWstETH', signature: 'requestWithdrawalsWstETH(uint256[],address)', inputs: [{ name: '_amounts', type: 'uint256[]' }, { name: '_owner', type: 'address' }], outputs: [{ name: 'requestIds', type: 'uint256[]' }], operation: 'request-withdrawal', warning: 'Withdrawal requests are asynchronous and require protocol finalization before claim; no instant liquidity is guaranteed. Caller controls amounts and NFT owner.' },
  { name: 'claimWithdrawals', signature: 'claimWithdrawals(uint256[],uint256[])', inputs: [{ name: '_requestIds', type: 'uint256[]' }, { name: '_hints', type: 'uint256[]' }], outputs: [], operation: 'claim', warning: 'Claim sends ETH to msg.sender, as defined by Lido; no platform owner pinning or alternative recipient is encoded. Caller controls request IDs and hints.' },
];
const functions: DefiFunctionPolicy[] = specs.map((spec) => ({
  capabilityId: `lido-withdrawal-queue:v1:1:${ADDRESS.toLowerCase()}:${spec.name}`,
  type: 'contract_call', chainId: 1, contract: ADDRESS, functionName: spec.name, signature: spec.signature,
  abi: { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: spec.inputs, outputs: spec.outputs },
  status: 'active', provenance: { sourceRef: SOURCE, verifiedAt: DATE, status: 'verified' },
  protocol: 'Lido', operation: spec.operation, label: `Lido ${spec.operation}`,
  warnings: [spec.warning, 'Caller controls ABI arguments; protocol-native validation and revert semantics are unchanged.'],
}));
const chains: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: ADDRESS, status: 'active', functions }] }];

export const STAKING_EXIT_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
export function buildStakingExitRegistry(): DefiRegistryFragment { return { chains }; }

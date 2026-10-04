import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const liquidityPool = '0x308861A430be4cce5502d0A12724771Fc6DaF216';
const weeth = '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee';
const withdrawRequestNft = '0x7d5706f6ef3F89B3951E23e557CDFBC3239D4E2c';
const sourceRef = 'docs/defi-research/expansion55-etherfi-v5.md (Ether.fi deployed-contract documentation; etherfi-protocol/smart-contracts commit 15ff96d4d5e8e6a19a472cd40a7bcb858c9e7a88)';

const specs: readonly { contract: string; name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; label: string }[] = [
  { contract: liquidityPool, name: 'deposit', operation: 'deposit-empty', mutability: 'payable', inputs: [], outputs: [{ name: '', type: 'uint256' }], label: 'Ether.fi deposit' },
  { contract: liquidityPool, name: 'deposit', operation: 'deposit-referral', mutability: 'payable', inputs: [{ name: '_referral', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], label: 'Ether.fi deposit with referral' },
  { contract: liquidityPool, name: 'deposit', operation: 'deposit-user-referral', mutability: 'payable', inputs: [{ name: '_user', type: 'address' }, { name: '_referral', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], label: 'Ether.fi deposit for user with referral' },
  { contract: liquidityPool, name: 'requestWithdraw', operation: 'request-withdraw', mutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], label: 'Ether.fi request withdrawal' },
  { contract: weeth, name: 'wrap', operation: 'wrap', mutability: 'nonpayable', inputs: [{ name: '_eETHAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], label: 'Ether.fi wrap eETH' },
  { contract: weeth, name: 'unwrap', operation: 'unwrap', mutability: 'nonpayable', inputs: [{ name: '_weETHAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], label: 'Ether.fi unwrap weETH' },
  { contract: withdrawRequestNft, name: 'claimWithdraw', operation: 'claim-withdraw', mutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], label: 'Ether.fi claim withdrawal NFT' },
];

const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  const selector = toFunctionSelector(signature);
  return {
    capabilityId: `etherfi:v1:${chainId}:${spec.contract.toLowerCase()}:${selector.slice(2)}`,
    type: 'contract_call', chainId, contract: spec.contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Ether.fi', operation: spec.operation, label: spec.label,
    warnings: [
      'This source-qualified fixture is not a production admission, runtime/proxy implementation verification, funded-execution proof, or a claim of complete Ether.fi/Swell coverage.',
      ...(spec.name === 'requestWithdraw' ? ['Withdrawal is queued: requestWithdraw creates an NFT request; claimWithdraw is a later, separately authorized action after finalization and is not an instant exit guarantee. Recipient and financial arguments are caller-controlled.'] : []),
      ...(spec.name === 'claimWithdraw' ? ['Claiming depends on request ownership and protocol finalization; this does not constrain the NFT owner or guarantee claimability.'] : []),
      ...(spec.name === 'wrap' ? ['wrap requires caller-held eETH and its independent ERC20 transfer authorization; no approval capability is included.'] : []),
      ...(spec.name === 'deposit' ? ['Caller controls payable ETH and any referral/recipient arguments; protocol minimums and maximums are not platform financial limits.'] : []),
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  { address: liquidityPool, status: 'active', functions: functions.filter((fn) => fn.contract === liquidityPool) },
  { address: weeth, status: 'active', functions: functions.filter((fn) => fn.contract === weeth) },
  { address: withdrawRequestNft, status: 'active', functions: functions.filter((fn) => fn.contract === withdrawRequestNft) },
] }];

/** Explicit source fixture only; not wired into a runtime registry. */
export function buildEtherfiRegistry(): DefiRegistryFragment { return { chains }; }

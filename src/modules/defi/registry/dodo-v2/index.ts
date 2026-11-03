import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 8453;
const target = '0x4CAD0052524648A7Fa2cfE279997b00239295F33';
const sourceRef = 'docs/defi-research/expansion55-dodo-v5.md (DODO official Base deployment and address-specific Sourcify ABI)';
const u = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const a = (name: string) => ({ name, type: 'address', internalType: 'address' });
const b = () => ({ name: '', type: 'bool', internalType: 'bool' });
const specs: { name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; label: string }[] = [
  { name: 'dodoSwapV2TokenToToken', operation: 'dodo-swap-v2-token-to-token', mutability: 'nonpayable', inputs: [a('fromToken'), a('toToken'), u('fromTokenAmount'), u('minReturnAmount'), { name: 'dodoPairs', type: 'address[]', internalType: 'address[]' }, u('directions'), b(), u('deadLine')], label: 'DODO V2 token-to-token swap' },
  { name: 'dodoSwapV2ETHToToken', operation: 'dodo-swap-v2-eth-to-token', mutability: 'payable', inputs: [a('toToken'), u('minReturnAmount'), { name: 'dodoPairs', type: 'address[]', internalType: 'address[]' }, u('directions'), b(), u('deadLine')], label: 'DODO V2 native ETH-to-token swap' },
  { name: 'dodoSwapV2TokenToETH', operation: 'dodo-swap-v2-token-to-eth', mutability: 'nonpayable', inputs: [a('fromToken'), u('fromTokenAmount'), u('minReturnAmount'), { name: 'dodoPairs', type: 'address[]', internalType: 'address[]' }, u('directions'), b(), u('deadLine')], label: 'DODO V2 token-to-native ETH swap' },
];
const functions: DefiFunctionPolicy[] = specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: spec.inputs, outputs: [{ name: 'returnAmount', type: 'uint256', internalType: 'uint256' }] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return { capabilityId: `dodo-v2:v2:${chainId}:${target.toLowerCase()}:${spec.operation}`, type: 'contract_call', chainId, contract: target, functionName: spec.name, signature, abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'DODO', operation: spec.operation, label: spec.label, warnings: ['Source-qualified test fixture only: not production admission, code-hop/runtime semantics, funded execution, pool eligibility, or liquidity proof.', 'Pair addresses are caller-selected counterparties, not platform-approved pools. Token, pair, amount, direction, minimum output, deadline, and native value remain ABI-level caller inputs without platform financial caps.', 'Token approvals are independent and are not automatically coupled. The fixed ABI contains no external target or bytes wallet-call payload; protocol semantics, bool meaning, direction grammar, and pair behavior require independent review.'] };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];
export function buildDodoV2Registry(): DefiRegistryFragment { return { chains }; }
export const dodoV2Selectors = specs.map((spec) => toFunctionSelector(`${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`));

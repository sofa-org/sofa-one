import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const LIDO = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const DATE = '2026-10-03';
const lower = (value: string) => value.toLowerCase();
const refs = 'https://docs.lido.fi/deployed-contracts (snapshot 2026-10-03); https://docs.lido.fi/contracts/lido; https://docs.lido.fi/contracts/wsteth';
const approvalRefs = `${refs}; https://docs.lido.fi/contracts/lido#approve (stETH approve declaration); https://docs.lido.fi/contracts/wsteth (ERC-20 support); standard ERC-20 approve(address,uint256) interface`;
const specs: readonly { contract: string; name: string; signature: string; mutability: AbiFunction['stateMutability']; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; operation: string }[] = [
  { contract: LIDO, name: 'submit', signature: 'submit(address)', mutability: 'payable', inputs: [{ name: '_referral', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], operation: 'stake' },
  { contract: WSTETH, name: 'wrap', signature: 'wrap(uint256)', mutability: 'nonpayable', inputs: [{ name: '_stETHAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], operation: 'wrap' },
  { contract: WSTETH, name: 'unwrap', signature: 'unwrap(uint256)', mutability: 'nonpayable', inputs: [{ name: '_wstETHAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], operation: 'unwrap' },
  { contract: LIDO, name: 'approve', signature: 'approve(address,uint256)', mutability: 'nonpayable', inputs: [{ name: '_spender', type: 'address' }, { name: '_amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], operation: 'approve' },
  { contract: WSTETH, name: 'approve', signature: 'approve(address,uint256)', mutability: 'nonpayable', inputs: [{ name: '_spender', type: 'address' }, { name: '_amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], operation: 'approve' },
];
const functions: DefiFunctionPolicy[] = specs.map((spec) => ({
  capabilityId: spec.name === 'approve' ? `erc20:1:${lower(spec.contract)}:approve` : `lido-v1:1:${lower(spec.contract)}:${spec.name}`,
  type: 'contract_call', chainId: 1, contract: spec.contract, functionName: spec.name, signature: spec.signature,
  abi: { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: spec.inputs, outputs: spec.outputs },
  status: 'active', provenance: { sourceRef: spec.name === 'approve' ? approvalRefs : refs, verifiedAt: DATE, status: 'verified' },
  protocol: 'Lido', operation: spec.operation, label: `${spec.name === 'approve' ? (spec.contract === LIDO ? 'stETH' : 'wstETH') : 'Lido'} ${spec.operation}`,
  warnings: spec.name === 'approve'
    ? ['Independent explicit grant: any spender and any uint256 amount (including maximum) are allowed; no action dependency or automatic approval/cleanup.']
    : ['Caller controls ABI arguments; protocol-native validation and revert semantics are unchanged.'],
}));
const chains: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [LIDO, WSTETH].map((address) => ({ address, status: 'active', functions: functions.filter((fn) => lower(fn.contract) === lower(address)) })) }];

export const STAKING_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
export function buildStakingRegistry(): DefiRegistryFragment { return { chains }; }

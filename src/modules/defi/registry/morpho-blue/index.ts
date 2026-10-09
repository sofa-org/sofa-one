import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const ADDRESS = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const SOURCE = 'https://docs.morpho.org/get-started/resources/addresses/ (snapshot 2026-10-03); https://github.com/morpho-org/morpho-blue/blob/8e26ca6a8dbc5089edcd67fb576248810fd2870a/src/interfaces/IMorpho.sol';
const DATE = '2026-10-03';
const components = [
  { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' },
];
const marketParams = { name: 'marketParams', type: 'tuple' as const, components };
const specs: readonly { name: string; signature: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; warnings: string[] }[] = [
  { name: 'withdraw', signature: 'withdraw((address,address,address,address,uint256),uint256,uint256,address,address)', inputs: [marketParams, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'assetsWithdrawn', type: 'uint256' }, { name: 'sharesWithdrawn', type: 'uint256' }], warnings: ['Caller controls market parameters, amount, onBehalf, and receiver; market existence and protocol-native withdrawal semantics are not validated here.'] },
  { name: 'withdrawCollateral', signature: 'withdrawCollateral((address,address,address,address,uint256),uint256,address,address)', inputs: [marketParams, { name: 'assets', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'receiver', type: 'address' }], outputs: [], warnings: ['Collateral withdrawal can affect position health; caller controls market parameters, amount, onBehalf, and receiver, with authorization and market semantics enforced by Morpho.'] },
  { name: 'borrow', signature: 'borrow((address,address,address,address,uint256),uint256,uint256,address,address)', inputs: [marketParams, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'assetsBorrowed', type: 'uint256' }, { name: 'sharesBorrowed', type: 'uint256' }], warnings: ['Borrow creates caller-selected debt; market parameters, amount, onBehalf, and receiver are caller-controlled, with protocol-native market and position semantics unchanged.'] },
];
const functionsFor = (chainId: number): DefiFunctionPolicy[] => specs.map((spec) => ({
  capabilityId: `morpho-blue:v1:${chainId}:${ADDRESS.toLowerCase()}:${spec.name}`,
  type: 'contract_call', chainId, contract: ADDRESS, functionName: spec.name, signature: spec.signature,
  abi: { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: spec.inputs, outputs: spec.outputs },
  status: 'active', provenance: { sourceRef: `${SOURCE}; chain-specific deployment listing for ${chainId === 1 ? 'Ethereum' : 'Base'}`, verifiedAt: DATE, status: 'verified' },
  protocol: 'Morpho Blue', operation: spec.name, label: `Morpho Blue ${spec.name}`, warnings: spec.warnings,
}));
const byChain = new Map([[1, functionsFor(1)], [8453, functionsFor(8453)]]);
export const MORPHO_BLUE_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze([...byChain.values()].flat());
export function buildMorphoBlueRegistry(): DefiRegistryFragment {
  const chains: DefiChainPolicy[] = [...byChain].map(([chainId, functions]) => ({ chainId, status: 'active', contracts: [{ address: ADDRESS, status: 'active', functions }] }));
  return { chains };
}

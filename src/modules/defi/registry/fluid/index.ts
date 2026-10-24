import { toFunctionSelector } from 'viem';
import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 8453;
const artifactCommit = '9496626f71a761fc296dc3b2efbfd54c504e18f0';
const fTokenSource = `Instadapp/fluid-contracts-public@${artifactCommit}/deployments/base/fToken_fUSDC.json and fToken_fWETH.json`;
const vaultSource = `Instadapp/fluid-contracts-public@${artifactCommit}/deployments/base/VaultT1_ETH_GHO.json`;
const fTokens = [
  { label: 'fUSDC', address: '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169' },
  { label: 'fWETH', address: '0x9272D6153133175175Bc276512B2336BE3931CE9' },
] as const;
const vault = { label: 'Vault T1 ETH GHO', address: '0x03271C337c86a6Fd89625A2820e48621DC2a128b' } as const;
type Method = { name: 'deposit' | 'mint' | 'withdraw' | 'redeem'; operation: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs'] };
const fTokenMethods: readonly Method[] = [
  { name: 'deposit', operation: 'deposit', inputs: [{ name: 'assets_', type: 'uint256' }, { name: 'receiver_', type: 'address' }], outputs: [{ name: 'shares_', type: 'uint256' }] },
  { name: 'deposit', operation: 'deposit', inputs: [{ name: 'assets_', type: 'uint256' }, { name: 'receiver_', type: 'address' }, { name: 'minAmountOut_', type: 'uint256' }], outputs: [{ name: 'shares_', type: 'uint256' }] },
  { name: 'mint', operation: 'mint', inputs: [{ name: 'shares_', type: 'uint256' }, { name: 'receiver_', type: 'address' }], outputs: [{ name: 'assets_', type: 'uint256' }] },
  { name: 'mint', operation: 'mint', inputs: [{ name: 'shares_', type: 'uint256' }, { name: 'receiver_', type: 'address' }, { name: 'maxAssets_', type: 'uint256' }], outputs: [{ name: 'assets_', type: 'uint256' }] },
  { name: 'withdraw', operation: 'withdraw', inputs: [{ name: 'assets_', type: 'uint256' }, { name: 'receiver_', type: 'address' }, { name: 'owner_', type: 'address' }], outputs: [{ name: 'shares_', type: 'uint256' }] },
  { name: 'withdraw', operation: 'withdraw', inputs: [{ name: 'assets_', type: 'uint256' }, { name: 'receiver_', type: 'address' }, { name: 'owner_', type: 'address' }, { name: 'maxSharesBurn_', type: 'uint256' }], outputs: [{ name: 'shares_', type: 'uint256' }] },
  { name: 'redeem', operation: 'redeem', inputs: [{ name: 'shares_', type: 'uint256' }, { name: 'receiver_', type: 'address' }, { name: 'owner_', type: 'address' }], outputs: [{ name: 'assets_', type: 'uint256' }] },
  { name: 'redeem', operation: 'redeem', inputs: [{ name: 'shares_', type: 'uint256' }, { name: 'receiver_', type: 'address' }, { name: 'owner_', type: 'address' }, { name: 'minAmountOut_', type: 'uint256' }], outputs: [{ name: 'assets_', type: 'uint256' }] },
];
function signatureOf(method: Pick<Method, 'name' | 'inputs'>): string {
  return `${method.name}(${method.inputs.map(({ type }) => type).join(',')})`;
}
function makeFTokenCapability(contract: string, market: string, method: Method): DefiFunctionPolicy {
  const abi: AbiFunction = { type: 'function', name: method.name, stateMutability: 'nonpayable', inputs: [...method.inputs], outputs: [...method.outputs] };
  const signature = signatureOf(method);
  const selector = toFunctionSelector(signature).slice(2);
  return {
    capabilityId: `fluid-lending:v1:${chainId}:${contract.toLowerCase()}:${selector}`,
    type: 'contract_call', chainId, contract, functionName: method.name, signature, abi, status: 'active',
    provenance: { sourceRef: fTokenSource, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Fluid', operation: method.operation, label: `Fluid ${market} ${method.name}`,
    warnings: ['Caller selects asset/shares, receiver, owner, and any min-output or max-asset/share arguments; no platform financial, ownership, or recipient constraints are added.', 'Approval to an underlying token is separate and is not automatically granted. Deployment artifact and ABI do not establish current runtime identity, liquidity, solvency, or funded execution.'],
  };
}
const fTokenFunctions = fTokens.flatMap((token) => fTokenMethods.map((method) => makeFTokenCapability(token.address, token.label, method)));
const operateAbi: AbiFunction = {
  type: 'function', name: 'operate', stateMutability: 'payable',
  inputs: [{ name: 'nftId_', type: 'uint256' }, { name: 'newCol_', type: 'int256' }, { name: 'newDebt_', type: 'int256' }, { name: 'to_', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }, { name: '', type: 'int256' }, { name: '', type: 'int256' }],
};
const operateSignature = 'operate(uint256,int256,int256,address)';
const operate: DefiFunctionPolicy = {
  capabilityId: `fluid-vault-t1:v1:${chainId}:${vault.address.toLowerCase()}:operate`,
  type: 'contract_call', chainId, contract: vault.address, functionName: 'operate', signature: operateSignature, abi: operateAbi, status: 'active',
  provenance: { sourceRef: vaultSource, verifiedAt: '2026-10-04', status: 'verified' },
  protocol: 'Fluid', operation: 'operate', label: `Fluid ${vault.label} operate`,
  warnings: ['The caller selects NFT position ID, signed collateral/debt deltas, and recipient; no platform financial, ownership, health-factor, or recipient constraints are added.', 'Source semantics describe position operations (zero NFT ID opens a position; positive/negative deltas alter collateral/debt; zero recipient means caller). Protocol state may still reject an action. This is not a generic NFT transfer or operator capability.', 'Payable native value remains caller selected and is not bounded by this fixed ABI policy. The artifact does not establish current runtime identity, liquidity, solvency, or funded execution.'],
};
const allFunctions = [...fTokenFunctions, operate];
const chains: DefiChainPolicy[] = [{
  chainId, status: 'active', contracts: [
    ...fTokens.map((token) => ({ address: token.address, status: 'active' as const, functions: fTokenFunctions.filter((fn) => fn.contract === token.address) })),
    { address: vault.address, status: 'active', functions: [operate] },
  ],
}];

export const FLUID_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(allFunctions);

/** Explicit candidate fixture only; it is not wired into the production registry. */
export function buildFluidRegistry(): DefiRegistryFragment { return { chains }; }

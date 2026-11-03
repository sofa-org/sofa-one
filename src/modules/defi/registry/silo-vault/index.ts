import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 42161;
const vaults = ['0x84D1B853C1F34a01c6120013AC7AC704D5383a8D', '0x5B73fb33c602351664D02ed199847B7A155297B5'] as const;
const sourceRef = 'silo-contracts-v2-f896c9da';
const u = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const addr = (name: string) => ({ name, type: 'address', internalType: 'address' });
const collateralType = { name: '_collateralType', type: 'uint8', internalType: 'enum ISilo.CollateralType' };
const specs: { name: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; label: string }[] = [
  { name: 'deposit', inputs: [u('_assets'), addr('_receiver'), collateralType], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }], label: 'Silo deposit assets' },
  { name: 'mint', inputs: [u('_shares'), addr('_receiver'), collateralType], outputs: [{ name: 'assets', type: 'uint256', internalType: 'uint256' }], label: 'Silo mint shares' },
  { name: 'withdraw', inputs: [u('_assets'), addr('_receiver'), addr('_owner'), collateralType], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }], label: 'Silo withdraw assets' },
  { name: 'redeem', inputs: [u('_shares'), addr('_receiver'), addr('_owner'), collateralType], outputs: [{ name: 'assets', type: 'uint256', internalType: 'uint256' }], label: 'Silo redeem shares' },
  { name: 'borrow', inputs: [u('_assets'), addr('_receiver'), addr('_borrower')], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }], label: 'Silo borrow assets' },
  { name: 'repay', inputs: [u('_assets'), addr('_borrower')], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }], label: 'Silo repay assets' },
];
const functions: DefiFunctionPolicy[] = vaults.flatMap((contract) => specs.map((spec) => {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: spec.inputs, outputs: spec.outputs };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return { capabilityId: `silo-vault:v3-market:${chainId}:${contract.toLowerCase()}:${spec.name}`, type: 'contract_call', chainId, contract, functionName: spec.name, signature, abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Silo Finance', operation: spec.name, label: spec.label, warnings: ['Source-qualified explicit fixture only; not production admission or a claim of complete Silo market coverage, funded execution, liquidity, or protocol safety.', 'Receiver, owner, borrower, assets, and shares remain caller-selected ABI arguments without platform financial or owner restrictions. CollateralType is the protocol-defined enum (Protected=0, Collateral=1), not a platform asset policy.', 'Configured protocol hooks, solvency/market state, collateral requirements, token allowance/funding, and liquidity are independent protocol prerequisites and are not guaranteed by this function grant. Token approvals are separate capabilities and are not automatically coupled.'] };
}));
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: vaults.map((address) => ({ address, status: 'active', functions: functions.filter((fn) => fn.contract === address) })) }];
export function buildSiloVaultRegistry(): DefiRegistryFragment { return { chains }; }

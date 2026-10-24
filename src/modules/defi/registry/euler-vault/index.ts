import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const evc = '0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383';
const vaults = [
  { address: '0xb3b36220fA7d12f7055dab5c9FD18E860e9a6bF8', symbol: 'eWETH-1', asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { address: '0xF6E2EfDF175e7a91c8847dade42f2d39A9aE57D4', symbol: 'ewstETH-1', asset: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' },
] as const;
const vaultSourceRef = 'euler-evault-abi';
const evcSourceRef = 'euler-evc-abi';
const ui = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const ad = (name: string) => ({ name, type: 'address', internalType: 'address' });
const vaultSpecs: { name: string; operation: string; inputs: AbiFunction['inputs']; label: string }[] = [
  { name: 'deposit', operation: 'deposit', inputs: [ui('amount'), ad('receiver')], label: 'Euler vault deposit' },
  { name: 'mint', operation: 'mint', inputs: [ui('amount'), ad('receiver')], label: 'Euler vault mint' },
  { name: 'withdraw', operation: 'withdraw', inputs: [ui('amount'), ad('receiver'), ad('owner')], label: 'Euler vault withdraw' },
  { name: 'redeem', operation: 'redeem', inputs: [ui('amount'), ad('receiver'), ad('owner')], label: 'Euler vault redeem' },
  { name: 'borrow', operation: 'borrow', inputs: [ui('amount'), ad('receiver')], label: 'Euler vault borrow' },
  { name: 'repay', operation: 'repay', inputs: [ui('amount'), ad('receiver')], label: 'Euler vault repay' },
];
const evcSpecs: { name: string; operation: string; inputs: AbiFunction['inputs']; label: string }[] = [
  { name: 'enableCollateral', operation: 'enable-collateral', inputs: [ad('account'), ad('vault')], label: 'Euler enable collateral' },
  { name: 'disableCollateral', operation: 'disable-collateral', inputs: [ad('account'), ad('vault')], label: 'Euler disable collateral' },
  { name: 'enableController', operation: 'enable-controller', inputs: [ad('account'), ad('vault')], label: 'Euler enable controller' },
  { name: 'disableController', operation: 'disable-controller', inputs: [ad('account')], label: 'Euler disable controller' },
];
function makeFunction(contract: string, family: 'euler-vault' | 'euler-evc', version: 'evk-v1' | 'evc-v1', sourceRef: string, spec: { name: string; operation: string; inputs: AbiFunction['inputs']; label: string }, payable: boolean): DefiFunctionPolicy {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: payable ? 'payable' : 'nonpayable', inputs: spec.inputs, outputs: family === 'euler-evc' ? [] : [{ name: '', type: 'uint256', internalType: 'uint256' }] };
  const signature = `${spec.name}(${spec.inputs.map(({ type }) => type).join(',')})`;
  return { capabilityId: `${family}:${version}:${chainId}:${contract.toLowerCase()}:${spec.operation}`, type: 'contract_call', chainId, contract, functionName: spec.name, signature, abi, status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Euler', operation: spec.operation, label: spec.label, warnings: ['Explicit source-qualified test fixture only; not production admission, recommended-market status, funded execution, liquidity, or protocol-safety certification.', 'All ABI-valid amounts, receivers, owners, accounts, vault choices, and collateral/controller choices remain caller controlled; no platform financial, asset, ownership, health-factor, or borrower cap is imposed.', 'Euler authorization, controller/collateral state, solvency, vault liquidity, token allowance/funding, and protocol eligibility are independent intrinsic prerequisites. Underlying-token approvals remain separate capabilities and are never automatically coupled.'] };
}
const vaultFunctions = vaults.flatMap((vault) => vaultSpecs.map((spec) => makeFunction(vault.address, 'euler-vault', 'evk-v1', vaultSourceRef, spec, false)));
const evcFunctions = evcSpecs.map((spec) => makeFunction(evc, 'euler-evc', 'evc-v1', evcSourceRef, spec, true));
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [
  ...vaults.map((vault) => ({ address: vault.address, status: 'active' as const, functions: vaultFunctions.filter((fn) => fn.contract === vault.address) })),
  { address: evc, status: 'active', functions: evcFunctions },
] }];
export function buildEulerVaultRegistry(): DefiRegistryFragment { return { chains }; }

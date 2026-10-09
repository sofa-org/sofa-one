import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const candidates = [
  { chainId: 1, address: '0x04422053aDDbc9bB2759b248B574e3FCA76Bc145', name: 'Keyrock USDC', responseHash: '8614743d67c968ef33525d64606c3650c3473e84416bb76ed2606d5f752c44c6', apiDate: '2026-10-02' },
  { chainId: 8453, address: '0x050cE30b927Da55177A4914EC73480238BAD56f0', name: 'Gauntlet USDC Prime', responseHash: 'd041f3f1fb58d2ee688def57fdaf1682abeedc36510228899e779c552c89a631', apiDate: '2026-10-02' },
] as const;
const lower = (value: string) => value.toLowerCase();
const specs: readonly { name: string; signature: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; operation: string }[] = [
  { name: 'deposit', signature: 'deposit(uint256,address)', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'onBehalf', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }], operation: 'deposit' },
  { name: 'withdraw', signature: 'withdraw(uint256,address,address)', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'onBehalf', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }], operation: 'withdraw' },
  { name: 'redeem', signature: 'redeem(uint256,address,address)', inputs: [{ name: 'shares', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'onBehalf', type: 'address' }], outputs: [{ name: 'assets', type: 'uint256' }], operation: 'redeem' },
];
const functions: DefiFunctionPolicy[] = candidates.flatMap((vault) => specs.map((spec) => ({
  capabilityId: `morpho-vault-v2:${vault.chainId}:${lower(vault.address)}:${spec.name}`,
  type: 'contract_call' as const,
  chainId: vault.chainId,
  contract: vault.address,
  functionName: spec.name,
  signature: spec.signature,
  abi: { type: 'function', name: spec.name, stateMutability: 'nonpayable', inputs: spec.inputs, outputs: spec.outputs },
  status: 'active' as const,
  provenance: {
    sourceRef: `https://api.morpho.org/graphql vaultV2ByAddress response SHA-256 ${vault.responseHash} (snapshot ${vault.apiDate}); https://docs.morpho.org/developers/earn/concepts/vault-v2`,
    verifiedAt: vault.apiDate,
    status: 'verified' as const,
  },
  protocol: 'Morpho Vault V2',
  operation: spec.operation,
  label: `${vault.name} ${spec.name}`,
  warnings: ['Caller controls asset/share amount, receiver, and onBehalf; vault share conversion and liquidity behavior remain protocol-native.'],
})));

const chains: DefiChainPolicy[] = candidates.map((vault) => ({
  chainId: vault.chainId,
  status: 'active',
  contracts: [{ address: vault.address, status: 'active', functions: functions.filter((fn) => fn.chainId === vault.chainId) }],
}));
export const VAULT_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
export function buildVaultRegistry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const minter = '0x7Bc6bad540453360F744666D625fec0ee1320cA3';
const vault = '0xac3E018457B222d93114458476f3E3416Abbe38F';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });

const minterAbis: readonly AbiFunction[] = [
  { type: 'function', name: 'mintFrxEth', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'mintFrxEthAndGive', stateMutability: 'payable', inputs: [address('_recipient')], outputs: [] },
  { type: 'function', name: 'submitAndDeposit', stateMutability: 'payable', inputs: [address('_recipient')], outputs: [uint('_shares')] },
];
const vaultAbis: readonly AbiFunction[] = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver')], outputs: [uint('shares')] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver')], outputs: [uint('assets')] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), address('owner')], outputs: [uint('shares')] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver'), address('owner')], outputs: [uint('assets')] },
];

function signatureOf(abi: AbiFunction): string { return `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`; }
function toFunction(abi: AbiFunction, target: string, operation: string, sourceRef: string): DefiFunctionPolicy {
  const signature = signatureOf(abi);
  return {
    capabilityId: `frax:frxeth-v2:${chainId}:${target.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: target, functionName: abi.name,
    signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Frax', operation, label: `frxETH ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current runtime identity, liquidity/queue state, or funded-execution certification.',
      'Minter requires positive native value and minting may be paused. submitAndDeposit performs an internal frxETH-to-sfrxETH approval as protocol behavior; it does not add a wallet approval capability.',
      'Vault withdrawals/redeems return frxETH, not native ETH. Share/token allowance, accrual, available assets and protocol queue/configuration remain intrinsic prerequisites.',
      'Amounts and recipient/receiver/owner remain ABI-valid caller choices with no platform caps, owner/feed restrictions, approval pairing, or funding gates. Independent approvals remain separate.',
    ],
  };
}

const minterFunctions = minterAbis.map((abi, index) => toFunction(abi, minter, ['mint-frx-eth', 'mint-frx-eth-and-give', 'submit-and-deposit'][index], 'frax-ether-minter-verified-abi'));
const vaultFunctions = vaultAbis.map((abi) => toFunction(abi, vault, abi.name, 'frax-sfrxeth-verified-abi'));
const functions = [...minterFunctions, ...vaultFunctions];
const chains: DefiChainPolicy[] = [{
  chainId, status: 'active', contracts: [
    { address: minter, status: 'active', functions: minterFunctions },
    { address: vault, status: 'active', functions: vaultFunctions },
  ],
}];

export const FRAX_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildFraxRegistry(): DefiRegistryFragment { return { chains }; }

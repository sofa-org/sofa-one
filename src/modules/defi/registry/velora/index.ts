import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const augustusRFQ = '0xe92b586627ccA7a83dC919cc7127196d70f55a06';
const sourceRef = 'velora-augustus-rfq-pinned-abi';

const abis: readonly AbiFunction[] = [
  {
    type: 'function',
    name: 'fillOrder',
    inputs: [
      {
        components: [
          { internalType: 'uint256', name: 'nonceAndMeta', type: 'uint256' },
          { internalType: 'uint128', name: 'expiry', type: 'uint128' },
          { internalType: 'address', name: 'makerAsset', type: 'address' },
          { internalType: 'address', name: 'takerAsset', type: 'address' },
          { internalType: 'address', name: 'maker', type: 'address' },
          { internalType: 'address', name: 'taker', type: 'address' },
          { internalType: 'uint256', name: 'makerAmount', type: 'uint256' },
          { internalType: 'uint256', name: 'takerAmount', type: 'uint256' },
        ],
        internalType: 'struct AugustusRFQ.Order',
        name: 'order',
        type: 'tuple',
      },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'partialFillOrder',
    inputs: [
      {
        components: [
          { internalType: 'uint256', name: 'nonceAndMeta', type: 'uint256' },
          { internalType: 'uint128', name: 'expiry', type: 'uint128' },
          { internalType: 'address', name: 'makerAsset', type: 'address' },
          { internalType: 'address', name: 'takerAsset', type: 'address' },
          { internalType: 'address', name: 'maker', type: 'address' },
          { internalType: 'address', name: 'taker', type: 'address' },
          { internalType: 'uint256', name: 'makerAmount', type: 'uint256' },
          { internalType: 'uint256', name: 'takerAmount', type: 'uint256' },
        ],
        internalType: 'struct AugustusRFQ.Order',
        name: 'order',
        type: 'tuple',
      },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
      { internalType: 'uint256', name: 'takerTokenFillAmount', type: 'uint256' },
    ],
    outputs: [
      { internalType: 'uint256', name: 'makerTokenFilledAmount', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'orderHash', type: 'bytes32' }],
    name: 'cancelOrder',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes32[]', name: 'orderHashes', type: 'bytes32[]' }],
    name: 'cancelOrders',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

type SignatureParameter = { type: string; components?: readonly SignatureParameter[] };
function canonicalType(parameter: SignatureParameter): string {
  if (!parameter.type.startsWith('tuple')) return parameter.type;
  const suffix = parameter.type.slice('tuple'.length);
  return `(${(parameter.components ?? []).map(canonicalType).join(',')})${suffix}`;
}

function signatureOf(abi: AbiFunction): string {
  return `${abi.name}(${abi.inputs.map((input) => canonicalType(input as SignatureParameter)).join(',')})`;
}

const operationByName = {
  fillOrder: 'fill-order',
  partialFillOrder: 'partial-fill-order',
  cancelOrder: 'cancel-order',
  cancelOrders: 'cancel-orders',
} as const;

const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const operation = operationByName[abi.name as keyof typeof operationByName];
  const signature = signatureOf(abi);
  return {
    capabilityId: `velora:augustus-rfq-v1:${chainId}:${augustusRFQ.toLowerCase()}:${operation}`,
    type: 'contract_call',
    chainId,
    contract: augustusRFQ,
    functionName: abi.name,
    signature,
    abi,
    status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-05', status: 'verified' },
    protocol: 'Velora Augustus RFQ',
    operation,
    label: `Velora Augustus RFQ ${operation}`,
    warnings: [
      'Explicit source-qualified isolated test fixture only; the raw v7 source remains inactive, and this builder is not runtime-wired or automatically granted.',
      'Only these four fixed Ethereum Augustus RFQ functions are selected; this is not complete Velora routing, all Augustus v6 functionality, a current-runtime identity assertion, liquidity evidence, funded execution, or transaction-success certification.',
      'The selected fill methods settle through their fixed order/token path: the fill recipient is msg.sender, and the taker-side transfer is sourced from msg.sender. Signatures, expiry, fill state, ERC-1271 checks and token transfers are contract behavior. ABI-valid order assets, maker/taker addresses, amounts, fill amount and bytes remain caller-selected without platform caps or signature-owner filters.',
      'These selected methods expose no arbitrary execution child or permit parameter. WithTarget variants use a token-recipient argument, not an arbitrary execution target; their omission, along with batch/NFT/permit methods, is bounded source selection rather than a platform security restriction. Token approvals remain independent and are neither included nor paired.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: augustusRFQ, status: 'active', functions }] }];

export const VELORA_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildVeloraRegistry(): DefiRegistryFragment { return { chains }; }

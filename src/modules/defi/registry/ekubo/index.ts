import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const positions = '0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D';
const sourceRef = 'ekubo-positions-sourcify-abi';
const uint = (name: string, bits: 128 | 256 = 128) => ({ name, type: `uint${bits}`, internalType: `uint${bits}` });
const int32 = (name: string) => ({ name, type: 'int32', internalType: 'int32' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const bool = (name: string) => ({ name, type: 'bool', internalType: 'bool' });
const poolKey = {
  name: 'poolKey', type: 'tuple', internalType: 'struct PoolKey',
  components: [address('token0'), address('token1'), { name: 'config', type: 'bytes32', internalType: 'PoolConfig' }],
} as const;

const abis: readonly AbiFunction[] = [
  {
    type: 'function', name: 'mintAndDeposit', stateMutability: 'payable',
    inputs: [poolKey, int32('tickLower'), int32('tickUpper'), uint('maxAmount0'), uint('maxAmount1'), uint('minLiquidity')],
    outputs: [uint('id', 256), uint('liquidity'), uint('amount0'), uint('amount1')],
  },
  {
    type: 'function', name: 'deposit', stateMutability: 'payable',
    inputs: [uint('id', 256), poolKey, int32('tickLower'), int32('tickUpper'), uint('maxAmount0'), uint('maxAmount1'), uint('minLiquidity')],
    outputs: [uint('liquidity'), uint('amount0'), uint('amount1')],
  },
  {
    type: 'function', name: 'withdraw', stateMutability: 'payable',
    inputs: [uint('id', 256), poolKey, int32('tickLower'), int32('tickUpper'), uint('liquidity')],
    outputs: [uint('amount0'), uint('amount1')],
  },
  {
    type: 'function', name: 'withdraw', stateMutability: 'payable',
    inputs: [uint('id', 256), poolKey, int32('tickLower'), int32('tickUpper'), uint('liquidity'), address('recipient'), bool('withFees')],
    outputs: [uint('amount0'), uint('amount1')],
  },
  {
    type: 'function', name: 'collectFees', stateMutability: 'payable',
    inputs: [uint('id', 256), poolKey, int32('tickLower'), int32('tickUpper')],
    outputs: [uint('amount0'), uint('amount1')],
  },
  {
    type: 'function', name: 'collectFees', stateMutability: 'payable',
    inputs: [uint('id', 256), poolKey, int32('tickLower'), int32('tickUpper'), address('recipient')],
    outputs: [uint('amount0'), uint('amount1')],
  },
];

function signatureOf(abi: AbiFunction): string {
  return `${abi.name}(${abi.inputs.map((input) => input.type === 'tuple'
    ? `(${(input as typeof input & { components: readonly { type: string }[] }).components.map(({ type }) => type).join(',')})`
    : input.type).join(',')})`;
}

function operationOf(abi: AbiFunction): string {
  if (abi.name === 'mintAndDeposit') return 'mint-and-deposit';
  if (abi.name === 'deposit') return 'deposit';
  const base = abi.name === 'withdraw' ? 'withdraw' : 'collect-fees';
  return `${base}-${toFunctionSelector(signatureOf(abi)).slice(2)}`;
}

const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const operation = operationOf(abi);
  return {
    capabilityId: `ekubo:positions-v3-1-1:${chainId}:${positions.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: positions, functionName: abi.name,
    signature: signatureOf(abi), abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Ekubo', operation, label: `Ekubo Positions ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current runtime identity, liquidity, or funded-execution certification.',
      'This is one documented Ethereum v3.1.1 Positions LP subset, not a swap/router, other-chain, complete market, or full workflow grant.',
      'The protocol uses its fixed lock callback internally; these direct position calls do not authorize generic locker, callback, multicall, or arbitrary execution.',
      'Position NFT authorization, pool configuration, tick/amount constraints, token approvals and protocol settlement are intrinsic behavior. Caller-controlled pool config, ticks, recipient and amount/minimum values remain uncapped by platform policy.',
      'Approvals remain independent. No platform owner, asset, amount, min-slippage, feed, approval-pairing or funded-execution filter is added.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: positions, status: 'active', functions }] }];

export const EKUBO_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildEkuboRegistry(): DefiRegistryFragment { return { chains }; }

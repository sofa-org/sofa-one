import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const target = '0xd17b3c9784510E33cD5B87b490E79253BcD81e2E';
const sourceRef = 'integral-size-relayer-interface';
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const uint = (name: string, type: 'uint32' | 'uint256') => ({ name, type, internalType: type });
const bool = (name: string) => ({ name, type: 'bool', internalType: 'bool' });

const sellAbi: AbiFunction = {
  type: 'function', name: 'sell', stateMutability: 'payable',
  inputs: [{ name: 'sellParams', type: 'tuple', internalType: 'struct ITwapRelayer.SellParams', components: [
    address('tokenIn'), address('tokenOut'), uint('amountIn', 'uint256'), uint('amountOutMin', 'uint256'), bool('wrapUnwrap'), address('to'), uint('submitDeadline', 'uint32'),
  ] }],
  outputs: [{ name: 'orderId', type: 'uint256', internalType: 'uint256' }],
};
const buyAbi: AbiFunction = {
  type: 'function', name: 'buy', stateMutability: 'payable',
  inputs: [{ name: 'buyParams', type: 'tuple', internalType: 'struct ITwapRelayer.BuyParams', components: [
    address('tokenIn'), address('tokenOut'), uint('amountInMax', 'uint256'), uint('amountOut', 'uint256'), bool('wrapUnwrap'), address('to'), uint('submitDeadline', 'uint32'),
  ] }],
  outputs: [{ name: 'orderId', type: 'uint256', internalType: 'uint256' }],
};

function makeFunction(abi: AbiFunction, operation: 'sell' | 'buy'): DefiFunctionPolicy {
  return {
    capabilityId: `integral:size-relayer-v1:${chainId}:${target.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: target, functionName: operation,
    signature: `${operation}((address,address,uint256,uint256,bool,address,uint32))`, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Integral', operation, label: `Integral Size relayer ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, funded execution, or trade-completion certification.',
      'The contract returns an order ID and routes orders through the delay contract; submission is not a guarantee of synchronous output delivery or eventual settlement. The docs describe different TWAP and instant product delays; no one delay is generalized to all calls.',
      'Caller controls ABI-valid tokens, amounts, output bounds, recipient, wrap flag, deadline, and payable value; no platform financial cap, asset/owner/feed restriction, or approval pairing is added. Protocol checks, dynamic gas prepayment, token allowances, queue operation, and available liquidity remain intrinsic prerequisites.',
    ],
  };
}

const functions: DefiFunctionPolicy[] = [makeFunction(sellAbi, 'sell'), makeFunction(buyAbi, 'buy')];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];

export const INTEGRAL_SIZE_RELAYER_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildIntegralSizeRelayerRegistry(): DefiRegistryFragment { return { chains }; }

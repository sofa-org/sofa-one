import { toFunctionSelector, type AbiFunction } from 'viem';
import { UNISWAP_DEPLOYMENTS, UNISWAP_POOL_MANAGERS, type UniswapExecutionContext, type UniswapExecutionResult } from './uniswap-deployments';
import { decodeUniswapParameters } from './uniswap-wire';

/** Exact deployed fragments retained independently for all seven admitted PMs. */
export const UNISWAP_V4_PRIMITIVES: readonly Readonly<{ signature: string; abi: AbiFunction }>[] = [
  {
    "signature": "initializePool((address,address,uint24,int24,address),uint160)",
    "abi": {
      "name": "initializePool",
      "type": "function",
      "inputs": [
        {
          "name": "key",
          "type": "tuple",
          "components": [
            {
              "name": "currency0",
              "type": "address",
              "internalType": "Currency"
            },
            {
              "name": "currency1",
              "type": "address",
              "internalType": "Currency"
            },
            {
              "name": "fee",
              "type": "uint24",
              "internalType": "uint24"
            },
            {
              "name": "tickSpacing",
              "type": "int24",
              "internalType": "int24"
            },
            {
              "name": "hooks",
              "type": "address",
              "internalType": "contract IHooks"
            }
          ],
          "internalType": "struct PoolKey"
        },
        {
          "name": "sqrtPriceX96",
          "type": "uint160",
          "internalType": "uint160"
        }
      ],
      "outputs": [
        {
          "name": "",
          "type": "int24",
          "internalType": "int24"
        }
      ],
      "stateMutability": "payable"
    }
  },
  {
    "signature": "safeTransferFrom(address,address,uint256)",
    "abi": {
      "name": "safeTransferFrom",
      "type": "function",
      "inputs": [
        {
          "name": "from",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "to",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "id",
          "type": "uint256",
          "internalType": "uint256"
        }
      ],
      "outputs": [],
      "stateMutability": "nonpayable"
    }
  },
  {
    "signature": "safeTransferFrom(address,address,uint256,bytes)",
    "abi": {
      "name": "safeTransferFrom",
      "type": "function",
      "inputs": [
        {
          "name": "from",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "to",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "id",
          "type": "uint256",
          "internalType": "uint256"
        },
        {
          "name": "data",
          "type": "bytes",
          "internalType": "bytes"
        }
      ],
      "outputs": [],
      "stateMutability": "nonpayable"
    }
  },
  {
    "signature": "transferFrom(address,address,uint256)",
    "abi": {
      "name": "transferFrom",
      "type": "function",
      "inputs": [
        {
          "name": "from",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "to",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "id",
          "type": "uint256",
          "internalType": "uint256"
        }
      ],
      "outputs": [],
      "stateMutability": "nonpayable"
    }
  }
];

const ZERO = '0x0000000000000000000000000000000000000000';

/** Direct syntax/known-target policy only; stored subscribers and receiver callbacks remain possible. */
export function validateV4PositionManagerPrimitive(data: string, signature: string, context: UniswapExecutionContext): UniswapExecutionResult {
  const deployment = UNISWAP_DEPLOYMENTS[context.chainId];
  const primitive = UNISWAP_V4_PRIMITIVES.find((entry) => entry.signature === signature);
  const owner = context.executionOwner.toLowerCase();
  if (!deployment || !primitive || context.nativeValue !== 0n || context.callerAddress !== undefined
    || !/^0x[0-9a-f]{40}$/.test(owner) || BigInt(owner) <= 2n) throw new TypeError('Invalid direct Uniswap V4 primitive context');
  if (data.slice(0, 10).toLowerCase() !== toFunctionSelector(signature).toLowerCase()) throw new TypeError('Invalid Uniswap V4 primitive selector');
  const args = decodeUniswapParameters(primitive.abi.inputs, `0x${data.slice(10)}`);
  // transferFrom reads PoolManager lock state too. Stored NFT currencies/subscribers are not observable here.
  const touched = new Set<string>([deployment.positionManager, UNISWAP_POOL_MANAGERS[context.chainId]]);
  if (primitive.abi.name === 'initializePool') {
    const key = args[0] as { currency0: string; currency1: string; hooks: string };
    if (key.hooks.toLowerCase() !== ZERO) throw new TypeError('Uniswap V4 initialization must be hookless');
    for (const currency of [key.currency0, key.currency1]) if (currency.toLowerCase() !== ZERO) touched.add(currency.toLowerCase());
  } else {
    if ((args[1] as string).toLowerCase() !== owner || args.length === 4 && args[3] !== '0x') throw new TypeError('Invalid Uniswap V4 NFT recipient/data');
  }
  return { operationCount: 1, touchedContracts: [...touched], children: [] };
}

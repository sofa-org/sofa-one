import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const exchangeProxy = '0xdef1c0ded9bec7f1a1670819833240f027b25eff';
const abis = [
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerTokenFeeAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "sender",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "feeRecipient",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.LimitOrder[]",
        "name": "orders",
        "type": "tuple[]"
      }
    ],
    "name": "batchCancelLimitOrders",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "txOrigin",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.RfqOrder[]",
        "name": "orders",
        "type": "tuple[]"
      }
    ],
    "name": "batchCancelRfqOrders",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerTokenFeeAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "sender",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "feeRecipient",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.LimitOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "cancelLimitOrder",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "txOrigin",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.RfqOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "cancelRfqOrder",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerTokenFeeAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "sender",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "feeRecipient",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.LimitOrder",
        "name": "order",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      },
      {
        "internalType": "uint128",
        "name": "takerTokenFillAmount",
        "type": "uint128"
      }
    ],
    "name": "fillLimitOrder",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "takerTokenFilledAmount",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "makerTokenFilledAmount",
        "type": "uint128"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerTokenFeeAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "sender",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "feeRecipient",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.LimitOrder",
        "name": "order",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      },
      {
        "internalType": "uint128",
        "name": "takerTokenFillAmount",
        "type": "uint128"
      }
    ],
    "name": "fillOrKillLimitOrder",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "makerTokenFilledAmount",
        "type": "uint128"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "txOrigin",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.RfqOrder",
        "name": "order",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      },
      {
        "internalType": "uint128",
        "name": "takerTokenFillAmount",
        "type": "uint128"
      }
    ],
    "name": "fillOrKillRfqOrder",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "makerTokenFilledAmount",
        "type": "uint128"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "contract IERC20Token",
            "name": "makerToken",
            "type": "address"
          },
          {
            "internalType": "contract IERC20Token",
            "name": "takerToken",
            "type": "address"
          },
          {
            "internalType": "uint128",
            "name": "makerAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "takerAmount",
            "type": "uint128"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "txOrigin",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pool",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "salt",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNativeOrder.RfqOrder",
        "name": "order",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      },
      {
        "internalType": "uint128",
        "name": "takerTokenFillAmount",
        "type": "uint128"
      }
    ],
    "name": "fillRfqOrder",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "takerTokenFilledAmount",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "makerTokenFilledAmount",
        "type": "uint128"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const satisfies readonly AbiFunction[];
const canonicalType = (input: { type: string; components?: readonly any[] }): string => input.type === 'tuple' || input.type === 'tuple[]'
  ? `(${input.components!.map(canonicalType).join(',')})${input.type.endsWith('[]') ? '[]' : ''}`
  : input.type;
const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const operation = abi.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, '');
  return {
    capabilityId: `zero-x:native-orders-v1:${chainId}:${exchangeProxy}:${operation}`,
    type: 'contract_call', chainId, contract: exchangeProxy, functionName: abi.name,
    signature: `${abi.name}(${abi.inputs.map(canonicalType).join(',')})`, abi, status: 'active',
    provenance: { sourceRef: 'zero-x-official-abi', verifiedAt: '2026-10-05', status: 'verified' },
    protocol: '0x', operation, label: `0x ${abi.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current deployment/runtime identity, liquidity, or funded-execution certification.',
      'Native-order fills and maker cancellations are the only selected entrypoints. RFQ txOrigin eligibility is a protocol workflow condition: the actual submitting transaction origin must qualify; this is not a platform-owner restriction.',
      'Fills use fixed ERC20 movement, optional declared fee and bounded signature tuple checks; cancellations update maker/registered-signer order state. No internal-fill, signer-registration, transform, arbitrary callback, or wallet-multicall selectors are included.',
      'Amounts, tokens, counterparties, recipients, fees, and fill amounts remain caller-controlled financial arguments without platform caps or pairing/feed restrictions. Token approvals and protocol order/signature conditions remain separate prerequisites; no approval is automatic.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: exchangeProxy, status: 'active', functions }] }];

export const ZERO_X_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildZeroXRegistry(): DefiRegistryFragment { return { chains }; }

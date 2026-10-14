import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const router = '0x111111125421ca6dc452d289314280a0f8842a65';
const abis = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      }
    ],
    "name": "ethUnoswap",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      }
    ],
    "name": "ethUnoswap2",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex3",
        "type": "uint256"
      }
    ],
    "name": "ethUnoswap3",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "to",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      }
    ],
    "name": "ethUnoswapTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "to",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      }
    ],
    "name": "ethUnoswapTo2",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "to",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex3",
        "type": "uint256"
      }
    ],
    "name": "ethUnoswapTo3",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "token",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      }
    ],
    "name": "unoswap",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "token",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      }
    ],
    "name": "unoswap2",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "token",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex3",
        "type": "uint256"
      }
    ],
    "name": "unoswap3",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "to",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "token",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      }
    ],
    "name": "unoswapTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "to",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "token",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      }
    ],
    "name": "unoswapTo2",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Address",
        "name": "to",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "token",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minReturn",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex2",
        "type": "uint256"
      },
      {
        "internalType": "Address",
        "name": "dex3",
        "type": "uint256"
      }
    ],
    "name": "unoswapTo3",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const satisfies readonly AbiFunction[];
const canonicalType = (input: { type: string; components?: readonly any[] }): string => input.type === 'tuple' || input.type === 'tuple[]'
  ? '(' + input.components!.map(canonicalType).join(',') + (input.type.endsWith('[]') ? ')[]' : ')')
  : input.type;
const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const signature = abi.name + '(' + abi.inputs.map(canonicalType).join(',') + ')';
  const operation = abi.name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()).replace(/^-/, '');
  return {
    capabilityId: 'one-inch:aggregation-router-v6:' + chainId + ':' + router + ':' + operation,
    type: 'contract_call', chainId, contract: router, functionName: abi.name,
    signature, abi, status: 'active',
    provenance: { sourceRef: 'one-inch-official-sdk-abi', verifiedAt: '2026-10-05', status: 'verified' },
    protocol: '1inch', operation, label: '1inch ' + abi.name,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current runtime identity, liquidity, complete-workflow, funded-execution, or financial-safety certification.',
      'Each selected route entrypoint dispatches a fixed one-to-three-hop V2/V3/Curve path. Swap callbacks/payment paths are router-generated protocol operations, not arbitrary wallet callbacks or wallet-call batching.',
      'V3 canonical factory/pool checks apply to the external-payer callback branch only, not every route. Curve callback handling uses router-held balances and assumes no stranded router funds; packed route fields are not authenticated token/pool identities here.',
      'Packed routes, token, amount, minimum return, recipient, direction/fees and native value are caller-controlled financial arguments. There are no platform amount, token-pair, recipient, pool, fee, or feed restrictions; approval/Permit2 prerequisites are separate and never auto-granted.',
    ],
  };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] }];
export const ONE_INCH_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildOneInchRegistry(): DefiRegistryFragment { return { chains }; }

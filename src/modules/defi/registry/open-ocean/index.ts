import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const proxy = '0x6352a56caadc4f1e25cd6c75970fa768a3304e64';
const abis = [
  {
    "inputs": [
      {
        "internalType": "contract IERC20",
        "name": "srcToken",
        "type": "address"
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
        "internalType": "bytes32[]",
        "name": "pools",
        "type": "bytes32[]"
      }
    ],
    "name": "callUniswap",
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
        "internalType": "contract IERC20",
        "name": "srcToken",
        "type": "address"
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
        "internalType": "bytes32[]",
        "name": "pools",
        "type": "bytes32[]"
      },
      {
        "internalType": "address payable",
        "name": "recipient",
        "type": "address"
      }
    ],
    "name": "callUniswapTo",
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
        "internalType": "address payable",
        "name": "recipient",
        "type": "address"
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
        "internalType": "uint256[]",
        "name": "pools",
        "type": "uint256[]"
      }
    ],
    "name": "uniswapV3SwapTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "returnAmount",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  }
] as const satisfies readonly AbiFunction[];
const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const operation = abi.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, '');
  return {
    capabilityId: `open-ocean:uniswap-routes-v1:${chainId}:${proxy}:${operation}`,
    type: 'contract_call', chainId, contract: proxy, functionName: abi.name,
    signature: `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`, abi, status: 'active',
    provenance: { sourceRef: 'open-ocean-implementation-abi', verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'OpenOcean', operation, label: `OpenOcean ${abi.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, current runtime identity, liquidity, or funded-execution certification.',
      'Only these three fixed Uniswap-family proxy methods are selected. simpleSwap, swap, swapGmxV2, makeCalls, permit variants, and arbitrary/callback surfaces are excluded; this is not blanket proof about arbitrary bytes or complete routing workflows.',
      'Selected methods use fixed route execution and fixed settlement, but encoded pool words/arrays remain caller-controlled. Positive-slippage distribution is hardcoded to 0x8dd9433e6F86a035bB318A6f74AD2d3Ac6731861; returned amount is not necessarily the net recipient amount. The inherited methods lack protocol whenNotPaused guards; platform pause policy remains independent.',
      'Amounts, minimum return, route words, pools and (for callUniswapTo/uniswapV3SwapTo) recipient remain caller-controlled without platform caps, pairing/feed restrictions, liquidity, or financial-safety certification. Required approvals are not automatic.',
    ],
  };
});
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: proxy, status: 'active', functions }] }];
export const OPEN_OCEAN_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildOpenOceanRegistry(): DefiRegistryFragment { return { chains }; }

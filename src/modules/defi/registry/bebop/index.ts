import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const router = '0xb098881c587f623fac85eae60809bee7a174cee7';
const abis = [{
  "inputs": [
    {
      "internalType": "address",
      "name": "tokenIn",
      "type": "address"
    },
    {
      "internalType": "address",
      "name": "tokenOut",
      "type": "address"
    },
    {
      "internalType": "uint256",
      "name": "amountIn",
      "type": "uint256"
    },
    {
      "internalType": "uint256",
      "name": "minAmountOut",
      "type": "uint256"
    },
    {
      "internalType": "address",
      "name": "recipient",
      "type": "address"
    },
    {
      "internalType": "uint256",
      "name": "deadline",
      "type": "uint256"
    },
    {
      "internalType": "uint256",
      "name": "fee",
      "type": "uint256"
    }
  ],
  "name": "swapWithAllowance",
  "outputs": [
    {
      "internalType": "uint256",
      "name": "amountOut",
      "type": "uint256"
    }
  ],
  "stateMutability": "payable",
  "type": "function"
}] as const satisfies readonly AbiFunction[];
const functions: DefiFunctionPolicy[] = abis.map((abi) => ({
  capabilityId: `bebop:bop-amm-v1:${chainId}:${router}:swap-with-allowance`,
  type: 'contract_call', chainId, contract: router, functionName: abi.name,
  signature: `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`, abi, status: 'active',
  provenance: { sourceRef: 'bebop-official-full-abi', verifiedAt: '2026-10-04', status: 'verified' },
  protocol: 'Bebop BOP AMM', operation: 'swap-with-allowance', label: 'Bebop BOP AMM swap with allowance',
  warnings: [
    'Explicit source-qualified test fixture only; not production admission, automatic grant, current runtime identity, liquidity, or funded-execution certification.',
    'This is the bounded BOP AMM router allowance entrypoint, not all Bebop RFQ or routing products. The separate core callback entrypoint and adapters are excluded.',
    'Router source collects caller input, performs the core pool swap, then applies the fee and minimum-output check before fixed token/native transfer. Fee and maker hooks, pool eligibility, governance, trust, and workflow conditions remain external dependencies and are not certified here.',
    'Tokens, input/output amounts, minimum output, recipient, deadline, fee, and native value remain caller-controlled without platform caps or pairing/feed restrictions. Required token approvals are not automatic.',
  ],
}));
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] }];
export const BEBOP_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildBebopRegistry(): DefiRegistryFragment { return { chains }; }

import { toFunctionSelector, type AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const router = '0x55084eE0fEf03f14a305cd24286359A35D735151';
const sourceRef = 'hashflow-sourcify-router-abi';
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const uint256 = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const bytes32 = (name: string) => ({ name, type: 'bytes32', internalType: 'bytes32' });
const bytes = (name: string) => ({ name, type: 'bytes', internalType: 'bytes' });

const rfqtComponents = [
  address('pool'), address('externalAccount'), address('trader'), address('effectiveTrader'), address('baseToken'), address('quoteToken'),
  uint256('effectiveBaseTokenAmount'), uint256('baseTokenAmount'), uint256('quoteTokenAmount'), uint256('quoteExpiry'), uint256('nonce'), bytes32('txid'), bytes('signature'),
];
const rfqmComponents = [
  address('pool'), address('externalAccount'), address('trader'), address('baseToken'), address('quoteToken'),
  uint256('baseTokenAmount'), uint256('quoteTokenAmount'), uint256('quoteExpiry'), bytes32('txid'), bytes('takerSignature'), bytes('makerSignature'),
];

const abis: readonly AbiFunction[] = [
  { type: 'function', name: 'tradeRFQT', stateMutability: 'payable', inputs: [{ name: 'quote', type: 'tuple', internalType: 'struct IQuote.RFQTQuote', components: rfqtComponents }], outputs: [] },
  { type: 'function', name: 'tradeRFQM', stateMutability: 'nonpayable', inputs: [{ name: 'quote', type: 'tuple', internalType: 'struct IQuote.RFQMQuote', components: rfqmComponents }], outputs: [] },
];

const functions: DefiFunctionPolicy[] = abis.map((abi) => {
  const quoteInput = abi.inputs[0] as typeof abi.inputs[number] & { components: readonly { type: string }[] };
  const signature = `${abi.name}((${quoteInput.components.map(({ type }) => type).join(',')}))`;
  const operation = abi.name === 'tradeRFQT' ? 'trade-rfqt' : 'trade-rfqm';
  return {
    capabilityId: `hashflow:rfq-v1:${chainId}:${router.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: router, functionName: abi.name,
    signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Hashflow', operation, label: `Hashflow ${operation}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, present deployment/runtime identity, quote availability, liquidity, or funded-execution certification.',
      'RFQT/RFQM signature-bearing tuples are fixed protocol quote payloads for these exact trade methods, not arbitrary wallet execution or a generic embedded-target grant.',
      'Pool authorization, maker signatures/availability, quote expiry, nonce and unique transaction identifiers are protocol conditions. These are not platform amount, trader, asset, counterparty, signature-owner, or feed filters.',
      'RFQT may pull caller tokens or native value according to quote fields; RFQM is nonpayable and pulls token assets from the trader. Token allowance and live quote/liquidity conditions remain protocol prerequisites; approvals are separate and never auto-added.',
    ],
  };
});

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] }];

export const HASHFLOW_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fragment for isolated Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildHashflowRegistry(): DefiRegistryFragment { return { chains }; }

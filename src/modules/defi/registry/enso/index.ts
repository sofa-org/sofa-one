import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import { createEnsoStaticWeirollScope } from '../../execution/enso-identity';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const router = '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf';
const sourceRef = 'enso-router-full-verified-abi';

const abis = [
  {
    type: 'function',
    name: 'routeSingle',
    inputs: [
      {
        components: [
          { internalType: 'enum TokenType', name: 'tokenType', type: 'uint8' },
          { internalType: 'bytes', name: 'data', type: 'bytes' },
        ],
        internalType: 'struct Token',
        name: 'tokenIn',
        type: 'tuple',
      },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
    ],
    outputs: [{ internalType: 'bytes', name: 'response', type: 'bytes' }],
    stateMutability: 'payable',
  },
] as const satisfies readonly AbiFunction[];

const functions: DefiFunctionPolicy[] = abis.map((abi) => ({
  capabilityId: 'enso:router-static-weiroll-v1:1:0xf75584ef6673ad213a685a1b58cc0330b8ea22cf:route-single',
  type: 'contract_call',
  chainId,
  contract: router,
  functionName: abi.name,
  signature: 'routeSingle((uint8,bytes),bytes)',
  abi,
  abiHash: '0xe3045106c2f667460faa9d5d67104b5f7f70c24186421cf1dbc7a2f03624c5c9',
  status: 'active',
  executionScope: createEnsoStaticWeirollScope(),
  provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
  protocol: 'Enso',
  operation: 'route-single',
  label: 'Enso static Weiroll routeSingle',
  warnings: [
    'Explicit candidate/test fixture only; not admitted to the generated production catalog or runtime registry, and grants are never automatic.',
    'The source-fixed shortcuts executor is not independently bound to a current deployment/runtime address. Calls execute from the shortcuts contract; shared or stranded shortcut funds and caller context remain workflow risks.',
    'Native and ERC-20 routeSingle modes only. The bounded child allowlist is static and each child requires an independent grant; approvals are not paired or automatic. No financial caps are added.',
    'Output data is discarded by the proposed command language; this does not establish current runtime identity, liquidity, funded execution, financial safety, or complete workflows.',
  ],
}));

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: router, status: 'active', functions }] }];

export const ENSO_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
/** Candidate fragment for isolated manifest/identity tests only; not wired to production runtime. */
export function buildEnsoRegistry(): DefiRegistryFragment { return { chains }; }

import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const target = '0xAaAaAAAaA24eEeb8d57D431224f73832bC34f688';
const sourceRef = 'ambient-target-sourcify-abi';
const abi: AbiFunction = {
  type: 'function', name: 'userCmd', stateMutability: 'payable',
  inputs: [{ name: 'callpath', type: 'uint16', internalType: 'uint16' }, { name: 'cmd', type: 'bytes', internalType: 'bytes' }],
  outputs: [{ name: '', type: 'bytes', internalType: 'bytes' }],
};
const scope = { kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 1 } as const;
const functions: DefiFunctionPolicy[] = [{
  capabilityId: `ambient:coldpath-v1:1:${target.toLowerCase()}:user-cmd`, type: 'contract_call', chainId,
  contract: target, functionName: 'userCmd', signature: 'userCmd(uint16,bytes)', abi, status: 'active',
  provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Ambient',
  operation: 'swap-and-lp-mint-burn', label: 'Ambient cold-path swap and LP mint/burn',
  warnings: ['Cold-path sidecars are governable and delegate to external liquidity conduits; caller-selected conduit counterparties and assets carry asset-loss risk.', 'Pool eligibility, liquidity, and funded execution are not assured.'],
  executionScope: scope,
}];
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];
export function buildAmbientRegistry(): DefiRegistryFragment { return { chains }; }

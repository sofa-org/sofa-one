import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const deployments = [
  { chainId: 42161, address: '0x5c3b380e5Aeec389d1014Da3Eb372FA2C9e0fc76', sourceRef: 'maverick-arbitrum-sourcify-abi' },
  { chainId: 8453, address: '0x5eDEd0d7E76C563FF081Ca01D9d12D6B404Df527', sourceRef: 'maverick-base-sourcify-abi' },
] as const;
const abi = {
  name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
  inputs: [
    { name: 'recipient', type: 'address', internalType: 'address' },
    { name: 'pool', type: 'address', internalType: 'contract IMaverickV2Pool' },
    { name: 'tokenAIn', type: 'bool', internalType: 'bool' },
    { name: 'amountIn', type: 'uint256', internalType: 'uint256' },
    { name: 'amountOutMinimum', type: 'uint256', internalType: 'uint256' },
  ],
  outputs: [{ name: 'amountOut', type: 'uint256', internalType: 'uint256' }],
} as unknown as AbiFunction;
const warnings = [
  'Caller selects recipient, pool, token direction, quantities, minimum output, and native value; no pool allowlist or protocol financial limits are imposed.',
  'LP callback/workflow and full Maverick coverage are not established; approval pairing, liquidity, and funded execution are not assured.',
];
const chains: DefiChainPolicy[] = deployments.map(({ chainId, address, sourceRef }) => {
  const operation = 'exact-input-single';
  const fn: DefiFunctionPolicy = {
    capabilityId: `maverick-v2:v2:${chainId}:${address.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract: address, functionName: 'exactInputSingle',
    signature: 'exactInputSingle(address,address,bool,uint256,uint256)', abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' }, protocol: 'Maverick V2',
    operation, label: 'Maverick V2 exactInputSingle', warnings,
  };
  return { chainId, status: 'active', contracts: [{ address, status: 'active', functions: [fn] }] };
});
export function buildMaverickV2Registry(): DefiRegistryFragment { return { chains }; }

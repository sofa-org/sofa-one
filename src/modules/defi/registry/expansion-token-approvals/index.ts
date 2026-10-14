import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const tokenSources = [
  {
    chainId: 1,
    symbol: 'DAI',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    sourceRef: 'docs/defi-research/expansion-2-lending-provenance.md; https://github.com/sparkdotfi/spark-address-registry/blob/98091964e0ef9f74bb2b6da3646f8e6d16448588/src/Ethereum.sol (official Ethereum token record; DAI approval admitted separately, not evidence of market listing)',
  },
  {
    chainId: 56,
    symbol: 'BTCB',
    address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    sourceRef: 'docs/defi-research/expansion-2-lending-provenance.md; https://github.com/VenusProtocol/venus-protocol/blob/0cc9211d9722694492553b9c2951724f76c9ee63/deployments/bscmainnet.json (official BNB token record; standard ERC-20 ABI metadata, deployed return behavior not individually runtime-proven)',
  },
  {
    chainId: 56,
    symbol: 'ETH',
    address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    sourceRef: 'docs/defi-research/expansion-2-lending-provenance.md; https://github.com/VenusProtocol/venus-protocol/blob/0cc9211d9722694492553b9c2951724f76c9ee63/deployments/bscmainnet.json (official BNB token record; standard ERC-20 ABI metadata, deployed return behavior not individually runtime-proven)',
  },
] as const;

const functions: DefiFunctionPolicy[] = tokenSources.map((token) => {
  const abi: AbiFunction = {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  };
  return {
    capabilityId: `erc20:${token.chainId}:${token.address.toLowerCase()}:approve`,
    type: 'contract_call', chainId: token.chainId, contract: token.address,
    functionName: 'approve', signature: 'approve(address,uint256)', abi,
    status: 'active', provenance: { sourceRef: token.sourceRef, verifiedAt: '2026-10-03', status: 'verified' },
    protocol: 'ERC-20', operation: 'approve', label: `${token.symbol} approve`,
    warnings: [
      'Independent explicit grant: any spender and any uint256 amount (including zero and maximum) are allowed; no action dependency or automatic approval/cleanup.',
      'Token address provenance is verified; deployed approval return behavior was not individually runtime-proven. Standard bool output is ABI metadata only. Authorization does not decode return data.',
    ],
  };
});

const chains: DefiChainPolicy[] = [1, 56].map((chainId) => ({
  chainId, status: 'active',
  contracts: functions.filter((fn) => fn.chainId === chainId).map((fn) => ({ address: fn.contract, status: 'active', functions: [fn] })),
}));

export function buildExpansionTokenApprovalRegistry(): DefiRegistryFragment { return { chains }; }

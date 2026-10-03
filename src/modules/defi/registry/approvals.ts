import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment } from './defi-manifest.types';

type Token = { chainId: number; symbol: string; address: string; sourceRef: string; noReturn?: boolean };
const aaveSource = 'https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/';
const cometSource = 'https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/arbitrum/usdc/configuration.json';
const tokens: readonly Token[] = [
  { chainId: 1, symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', sourceRef: `${aaveSource}AaveV3Ethereum.ts` },
  { chainId: 1, symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', sourceRef: `${aaveSource}AaveV3Ethereum.ts; https://github.com/tethercoin/USDT/blob/master/TetherToken.sol (no-return interface inspected 2026-10-02)`, noReturn: true },
  { chainId: 1, symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', sourceRef: `${aaveSource}AaveV3Ethereum.ts` },
  { chainId: 8453, symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', sourceRef: `${aaveSource}AaveV3Base.ts` },
  { chainId: 8453, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', sourceRef: `${aaveSource}AaveV3Base.ts` },
  { chainId: 42161, symbol: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', sourceRef: `${aaveSource}AaveV3Arbitrum.ts` },
  { chainId: 42161, symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', sourceRef: `${aaveSource}AaveV3Arbitrum.ts` },
  { chainId: 42161, symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', sourceRef: `${aaveSource}AaveV3Arbitrum.ts` },
  { chainId: 42161, symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', sourceRef: cometSource },
  { chainId: 10, symbol: 'USDC', address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', sourceRef: `${aaveSource}AaveV3Optimism.ts` },
  { chainId: 10, symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', sourceRef: `${aaveSource}AaveV3Optimism.ts` },
  { chainId: 10, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', sourceRef: `${aaveSource}AaveV3Optimism.ts` },
  { chainId: 137, symbol: 'USDC', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', sourceRef: `${aaveSource}AaveV3Polygon.ts` },
  { chainId: 137, symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', sourceRef: `${aaveSource}AaveV3Polygon.ts` },
  { chainId: 56, symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', sourceRef: `${aaveSource}AaveV3BNB.ts` },
  { chainId: 56, symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', sourceRef: `${aaveSource}AaveV3BNB.ts` },
  { chainId: 143, symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', sourceRef: `${aaveSource}AaveV3Monad.ts` },
  { chainId: 143, symbol: 'WETH', address: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242', sourceRef: `${aaveSource}AaveV3Monad.ts` },
];
const lower = (value: string) => value.toLowerCase();
const functions: DefiFunctionPolicy[] = tokens.map((token) => {
  const abi: AbiFunction = {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: token.noReturn ? [] : [{ name: '', type: 'bool' }],
  };
  return {
    capabilityId: `erc20:${token.chainId}:${lower(token.address)}:approve`,
    type: 'contract_call', chainId: token.chainId, contract: token.address,
    functionName: 'approve', signature: 'approve(address,uint256)', abi,
    status: 'active', provenance: { sourceRef: token.sourceRef, verifiedAt: '2026-10-02', status: 'verified' },
    protocol: 'ERC-20', operation: 'approve', label: `${token.symbol} approve`,
    warnings: [
      'Independent explicit grant: any spender and any uint256 amount (including maximum) are allowed; no action dependency or automatic approval/cleanup.',
      ...(token.noReturn ? [] : ['Address provenance is verified; this token’s deployed approval return declaration was not individually verified. Standard bool output is interface metadata only. Authorization does not decode return data.']),
    ],
  };
});
const chains: DefiChainPolicy[] = [...new Set(functions.map((fn) => fn.chainId))].sort((a, b) => a - b).map((chainId) => ({
  chainId, status: 'active',
  contracts: functions.filter((fn) => fn.chainId === chainId).map((fn) => ({ address: fn.contract, status: 'active', functions: [fn] })),
}));
export function buildApprovalFragment(): DefiRegistryFragment { return { chains }; }

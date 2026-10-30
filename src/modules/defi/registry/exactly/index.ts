import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 10;
const familyVersion = 'v1';
const markets = [
  { address: '0x6926B434CCe9b5b7966aE1BfEef6D0A7DCF3A8bb', name: 'Exactly OP Market USDC' },
  { address: '0xc4d4500326981eacD020e20A81b1c479c161c7EF', name: 'Exactly OP Market WETH' },
] as const;
const auditor = '0xaEb62e6F27BC103702E7BC879AE98bceA56f027E';
const marketSource = 'exactly-market-sol';
const auditorSource = 'exactly-auditor-sol';
const erc4626Source = 'exactly-solmate-erc4626-v7';

const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const marketMethods: readonly AbiFunction[] = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver')], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver')], outputs: [{ name: 'assets', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), address('owner')], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [uint('shares'), address('receiver'), address('owner')], outputs: [{ name: 'assets', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'borrow', stateMutability: 'nonpayable', inputs: [uint('assets'), address('receiver'), address('borrower')], outputs: [{ name: 'borrowShares', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'repay', stateMutability: 'nonpayable', inputs: [uint('assets'), address('borrower')], outputs: [{ name: 'actualRepay', type: 'uint256', internalType: 'uint256' }, { name: 'borrowShares', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'depositAtMaturity', stateMutability: 'nonpayable', inputs: [uint('maturity'), uint('assets'), uint('minAssetsRequired'), address('receiver')], outputs: [{ name: 'positionAssets', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'borrowAtMaturity', stateMutability: 'nonpayable', inputs: [uint('maturity'), uint('assets'), uint('maxAssets'), address('receiver'), address('borrower')], outputs: [{ name: 'assetsOwed', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'withdrawAtMaturity', stateMutability: 'nonpayable', inputs: [uint('maturity'), uint('positionAssets'), uint('minAssetsRequired'), address('receiver'), address('owner')], outputs: [{ name: 'assetsDiscounted', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'repayAtMaturity', stateMutability: 'nonpayable', inputs: [uint('maturity'), uint('positionAssets'), uint('maxAssets'), address('borrower')], outputs: [{ name: 'actualRepayAssets', type: 'uint256', internalType: 'uint256' }] },
];
const auditorMethods: readonly AbiFunction[] = [
  { type: 'function', name: 'enterMarket', stateMutability: 'nonpayable', inputs: [{ name: 'market', type: 'address', internalType: 'contract Market' }], outputs: [] },
  { type: 'function', name: 'exitMarket', stateMutability: 'nonpayable', inputs: [{ name: 'market', type: 'address', internalType: 'contract Market' }], outputs: [] },
];

function operationName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function makeFunction(contract: string, abi: AbiFunction, sourceRef: string, marketLabel?: string): DefiFunctionPolicy {
  const signature = `${abi.name}(${abi.inputs.map(({ type }) => type).join(',')})`;
  const operation = operationName(abi.name);
  return {
    capabilityId: `exactly:${familyVersion}:${chainId}:${contract.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract, functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Exactly', operation, label: `${marketLabel ? `${marketLabel} ` : 'Exactly Auditor '}${abi.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, funded execution, liquidity, or economic-success certification.',
      'All ABI-valid amounts, maturities, minimum/maximum values, receivers, owners, borrowers, and market choices remain caller controlled; no platform financial, ownership, solvency, or health-factor cap is imposed.',
      'Exactly protocol configuration, allowance/funding, solvency, and available liquidity remain independent protocol prerequisites; approvals are separate capabilities and are never automatically paired.',
    ],
  };
}

const marketFunctions = markets.flatMap((market) => marketMethods.map((abi) => makeFunction(
  market.address,
  abi,
  abi.name === 'deposit' || abi.name === 'mint' ? erc4626Source : marketSource,
  market.name,
)));
const auditorFunctions = auditorMethods.map((abi) => makeFunction(auditor, abi, auditorSource));
const chains: DefiChainPolicy[] = [{
  chainId,
  status: 'active',
  contracts: [
    ...markets.map((market) => ({ address: market.address, status: 'active' as const, functions: marketFunctions.filter((fn) => fn.contract === market.address) })),
    { address: auditor, status: 'active', functions: auditorFunctions },
  ],
}];

export const EXACTLY_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze([...marketFunctions, ...auditorFunctions]);

/** Explicit active fixture for offline catalog/policy tests; never wired into a runtime registry or grants. */
export function buildExactlyRegistry(): DefiRegistryFragment { return { chains }; }

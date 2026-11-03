import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 8453;
const sourceRef = 'https://docs.moonwell.fi/moonwell/protocol-information/contracts.md; moonwell-fi/moonwell-contracts-v2@6914f05d052e026d909ea14058fc1778bec7bf5a (MTokenInterfaces.sol, MErc20.sol, ComptrollerInterface.sol, Comptroller.sol, TokenErrorReporter.sol)';
const markets = [
  { label: 'mUSDC', address: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22' },
  { label: 'mWETH', address: '0x628ff693426583D9a7FB391E54366292F509D457' },
  { label: 'mUSDbC', address: '0x703843C3379b52F9FF486c9f5892218d2a065cC8' },
] as const;
const comptroller = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
type Method = { name: string; operation: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs'] };
const errorCode: AbiFunction['outputs'] = [{ name: '', type: 'uint256' }];
const tokenMethods: readonly Method[] = [
  { name: 'mint', operation: 'mint', inputs: [{ name: 'mintAmount', type: 'uint256' }], outputs: errorCode },
  { name: 'redeem', operation: 'redeem', inputs: [{ name: 'redeemTokens', type: 'uint256' }], outputs: errorCode },
  { name: 'redeemUnderlying', operation: 'redeem-underlying', inputs: [{ name: 'redeemAmount', type: 'uint256' }], outputs: errorCode },
  { name: 'borrow', operation: 'borrow', inputs: [{ name: 'borrowAmount', type: 'uint256' }], outputs: errorCode },
  { name: 'repayBorrow', operation: 'repay-borrow', inputs: [{ name: 'repayAmount', type: 'uint256' }], outputs: errorCode },
];
function makeCapability(contract: string, market: string, method: Method): DefiFunctionPolicy {
  const abi: AbiFunction = { type: 'function', name: method.name, stateMutability: 'nonpayable', inputs: [...method.inputs], outputs: [...method.outputs] };
  const signature = `${method.name}(${method.inputs.map(({ type }) => type).join(',')})`;
  return {
    capabilityId: `moonwell:v2:${chainId}:${contract.toLowerCase()}:${method.operation}`,
    type: 'contract_call', chainId, contract, functionName: method.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'Moonwell', operation: method.operation, label: `Moonwell ${market} ${method.name}`,
    warnings: [
      'Moonwell mToken methods return protocol error codes: zero is NO_ERROR and nonzero indicates protocol failure; an EVM-successful call is not proof of asset movement or successful protocol action.',
      'Caller controls ABI arguments; market membership, liquidity, solvency, runtime deployment correspondence, and funded execution are not established.',
      ...(method.name === 'borrow' ? ['Borrowing creates debt and carries liquidation, market-condition, liquidity and caller financial risk.'] : []),
    ],
  };
}
const marketFunctions = markets.flatMap((market) => tokenMethods.map((method) => makeCapability(market.address, market.label, method)));
const comptrollerMethods: readonly Method[] = [
  { name: 'enterMarkets', operation: 'enter-markets', inputs: [{ name: 'mTokens', type: 'address[]' }], outputs: [{ name: '', type: 'uint256[]' }] },
  { name: 'exitMarket', operation: 'exit-market', inputs: [{ name: 'mToken', type: 'address' }], outputs: errorCode },
];
const comptrollerFunctions = comptrollerMethods.map((method) => makeCapability(comptroller, 'Comptroller', method));
const chains: DefiChainPolicy[] = [{
  chainId,
  status: 'active',
  contracts: [
    ...markets.map((market) => ({ address: market.address, status: 'active' as const, functions: marketFunctions.filter((fn) => fn.contract === market.address) })),
    { address: comptroller, status: 'active', functions: comptrollerFunctions },
  ],
}];

export const MOONWELL_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze([...marketFunctions, ...comptrollerFunctions]);

/** Explicit fixture fragment only. This family is not added to any runtime registry by this builder. */
export function buildMoonwellRegistry(): DefiRegistryFragment { return { chains }; }

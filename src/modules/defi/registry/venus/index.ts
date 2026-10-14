import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 56;
const sourceRef = 'docs/defi-research/expansion-2-lending-provenance.md; VenusProtocol/venus-protocol@0cc9211d9722694492553b9c2951724f76c9ee63 deployments/bscmainnet.json, contracts/Tokens/VTokens/VBep20.sol, contracts/Tokens/VTokens/VBNB.sol, contracts/Comptroller/ComptrollerInterface.sol (snapshot 2026-10-03)';
const markets = [
  { label: 'vBNB', address: '0xA07c5b74C9B40447a954e1466938b865b6BBea36', native: true },
  { label: 'vBTC', address: '0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B', native: false },
  { label: 'vETH', address: '0xf508fCD89b8bd15579dc79A6827cB4686A3592c8', native: false },
  { label: 'vUSDC', address: '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8', native: false },
  { label: 'vUSDT', address: '0xfD5840Cd36d94D7229439859C0112a4185BC0255', native: false },
] as const;
const unitroller = '0xfD36E2c2a6789Db23113685031d7F16329158384';
type Spec = { name: string; operation: string; mutability: 'payable' | 'nonpayable'; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs'] };
const uint = (name: string) => ({ name, type: 'uint256' as const });
const errorCode: AbiFunction['outputs'] = [{ name: '', type: 'uint256' }];
const tokenMethods: readonly Spec[] = [
  { name: 'mint', operation: 'mint', mutability: 'nonpayable', inputs: [uint('mintAmount')], outputs: errorCode },
  { name: 'redeem', operation: 'redeem', mutability: 'nonpayable', inputs: [uint('redeemTokens')], outputs: errorCode },
  { name: 'redeemUnderlying', operation: 'redeem-underlying', mutability: 'nonpayable', inputs: [uint('redeemAmount')], outputs: errorCode },
  { name: 'borrow', operation: 'borrow', mutability: 'nonpayable', inputs: [uint('borrowAmount')], outputs: errorCode },
  { name: 'repayBorrow', operation: 'repay-borrow', mutability: 'nonpayable', inputs: [uint('repayAmount')], outputs: errorCode },
];
const nativeMethods: readonly Spec[] = [
  { name: 'mint', operation: 'mint', mutability: 'payable', inputs: [], outputs: [] },
  ...tokenMethods.slice(1, 4),
  { name: 'repayBorrow', operation: 'repay-borrow', mutability: 'payable', inputs: [], outputs: [] },
];
function capability(contract: string, market: string, spec: Spec): DefiFunctionPolicy {
  const abi: AbiFunction = { type: 'function', name: spec.name, stateMutability: spec.mutability, inputs: [...spec.inputs], outputs: [...spec.outputs] };
  const signature = `${spec.name}(${spec.inputs.map((input) => input.type).join(',')})`;
  return {
    capabilityId: `venus-core:v1:${chainId}:${contract.toLowerCase()}:${spec.operation}`,
    type: 'contract_call', chainId, contract, functionName: spec.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-03', status: 'verified' },
    protocol: 'Venus', operation: spec.operation, label: `Venus ${market} ${spec.name}`,
    warnings: ['Caller controls ABI arguments; market conditions, liquidity and native protocol validation are unchanged.', 'EVM success does not guarantee Venus protocol success: vToken and Comptroller calls may return nonzero protocol error codes.', ...(spec.name === 'borrow' ? ['Borrowing creates debt and carries liquidation, market-condition, liquidity and caller financial risk.'] : [])],
  };
}
const functions: DefiFunctionPolicy[] = markets.flatMap((market) => (market.native ? nativeMethods : tokenMethods).map((spec) => capability(market.address, market.label, spec)));
const core: DefiFunctionPolicy[] = [
  { name: 'enterMarkets', operation: 'enter-markets', inputs: [{ name: 'vTokens', type: 'address[]' }], outputs: [{ name: '', type: 'uint256[]' }] },
  { name: 'exitMarket', operation: 'exit-market', inputs: [{ name: 'vToken', type: 'address' }], outputs: errorCode },
].map((spec) => capability(unitroller, 'Core', { ...spec, mutability: 'nonpayable' }));
functions.push(...core);
const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [...markets.map((market) => ({ address: market.address, status: 'active' as const, functions: functions.filter((fn) => fn.contract === market.address) })), { address: unitroller, status: 'active', functions: core }] }];

export function buildVenusRegistry(): DefiRegistryFragment { return { chains }; }

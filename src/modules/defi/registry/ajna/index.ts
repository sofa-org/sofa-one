import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const pool = '0x9cdb48fcbd8241bb75887af04d3b1302c410f671';
const sourceRef = 'ajna-erc20-pool-abi';
const uint = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });
const address = (name: string) => ({ name, type: 'address', internalType: 'address' });
const abi = (name: string, inputs: AbiFunction['inputs'], outputs: AbiFunction['outputs']): AbiFunction => ({ type: 'function', name, stateMutability: 'nonpayable', inputs, outputs });
const output = (name: string) => ({ name, type: 'uint256', internalType: 'uint256' });

const functionsAbi: Array<{ abi: AbiFunction; operation: string; signature: string }> = [
  { abi: abi('addQuoteToken', [uint('amount_'), uint('index_'), uint('expiry_')], [output('bucketLP_'), output('addedAmount_')]), operation: 'add-quote-token', signature: 'addQuoteToken(uint256,uint256,uint256)' },
  { abi: abi('removeQuoteToken', [uint('maxAmount_'), uint('index_')], [output('removedAmount_'), output('redeemedLP_')]), operation: 'remove-quote-token', signature: 'removeQuoteToken(uint256,uint256)' },
  { abi: abi('addCollateral', [uint('amountToAdd_'), uint('index_'), uint('expiry_')], [output('bucketLP_')]), operation: 'add-collateral', signature: 'addCollateral(uint256,uint256,uint256)' },
  { abi: abi('removeCollateral', [uint('maxAmount_'), uint('index_')], [output('removedAmount_'), output('redeemedLP_')]), operation: 'remove-collateral', signature: 'removeCollateral(uint256,uint256)' },
  { abi: abi('drawDebt', [address('borrowerAddress_'), uint('amountToBorrow_'), uint('limitIndex_'), uint('collateralToPledge_')], []), operation: 'draw-debt', signature: 'drawDebt(address,uint256,uint256,uint256)' },
  { abi: abi('repayDebt', [address('borrowerAddress_'), uint('maxQuoteTokenAmountToRepay_'), uint('collateralAmountToPull_'), address('collateralReceiver_'), uint('limitIndex_')], [output('amountRepaid_')]), operation: 'repay-debt', signature: 'repayDebt(address,uint256,uint256,address,uint256)' },
];

const functions: DefiFunctionPolicy[] = functionsAbi.map(({ abi: functionAbi, operation, signature }) => ({
  capabilityId: `ajna:erc20-v1:${chainId}:${pool}:${operation}`,
  type: 'contract_call', chainId, contract: pool, functionName: functionAbi.name, signature, abi: functionAbi, status: 'active',
  provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
  protocol: 'Ajna', operation, label: `Ajna rETH/DAI pool ${operation}`,
  warnings: [
    'Explicit source-qualified active test fixture only; not production admission, automatic grant, current runtime-code, market-wide coverage, liquidity, or funded-execution certification.',
    'This exact Ethereum ERC20 pool was selected from a bounded recorded factory observation (224 entries; index 0) and typed rETH collateral / DAI quote getters. Factory and other pools are not authorized targets.',
    'Bucket indices, expiries, amounts, borrower and collateral receiver remain caller-selected within canonical ABI types. Bucket state, token allowances, protocol solvency, quote/collateral liquidity and native pool checks remain intrinsic; no platform index/amount/owner filter or approval pairing is added.',
    'The pinned deployment ABI names repayDebt address input collateralReceiver_; do not substitute a different parameter name based on prose. This does not change the selector but is part of exact ABI fidelity.',
  ],
}));

const chains: DefiChainPolicy[] = [{ chainId, status: 'active', contracts: [{ address: pool, status: 'active', functions }] }];

export const AJNA_ERC20_POOL_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline Catalog/Policy tests only; not runtime wired or automatically granted. */
export function buildAjnaErc20PoolRegistry(): DefiRegistryFragment { return { chains }; }

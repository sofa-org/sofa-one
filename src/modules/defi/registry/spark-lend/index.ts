import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const POOL = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987';
const ADDRESS_BOOK = 'https://github.com/sparkdotfi/spark-address-registry/blob/98091964e0ef9f74bb2b6da3646f8e6d16448588/src/SparkLend.sol';
const IPool = 'https://github.com/sparkdotfi/sparklend-v1-core/blob/900c189feef2fafb97dca24c7b6e502dd035925a/contracts/interfaces/IPool.sol';

const declarations: readonly { name: string; signature: string; inputs: AbiFunction['inputs']; outputs: AbiFunction['outputs']; warning?: string }[] = [
  { name: 'supply', signature: 'supply(address,uint256,address,uint16)', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [] },
  { name: 'withdraw', signature: 'withdraw(address,uint256,address)', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'borrow', signature: 'borrow(address,uint256,uint256,uint16,address)', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'referralCode', type: 'uint16' }, { name: 'onBehalfOf', type: 'address' }], outputs: [], warning: 'Borrow can create debt; the caller assumes position and health-factor risk.' },
  { name: 'repay', signature: 'repay(address,uint256,uint256,address)', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

const functions: DefiFunctionPolicy[] = declarations.map(({ name, signature, inputs, outputs, warning }) => ({
  capabilityId: `spark-lend:v1:1:${POOL.toLowerCase()}:${name}`,
  type: 'contract_call', chainId: 1, contract: POOL, functionName: name, signature,
  abi: { type: 'function', name, stateMutability: 'nonpayable', inputs, outputs },
  status: 'active', provenance: { sourceRef: `${ADDRESS_BOOK}; ${IPool}`, verifiedAt: '2026-10-03', status: 'verified' },
  protocol: 'SparkLend', operation: name, label: `SparkLend ${name}`,
  warnings: [
    ...(warning ? [warning] : []),
    'Caller controls ABI arguments; protocol-native validation and revert semantics are unchanged. Market listing, liquidity, and transaction success are not assured; assess financial suitability independently.',
  ],
}));

const chains: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: POOL, status: 'active', functions }] }];

export const SPARK_LEND_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
export function buildSparkLendRegistry(): DefiRegistryFragment { return { chains }; }

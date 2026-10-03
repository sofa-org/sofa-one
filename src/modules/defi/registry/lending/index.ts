import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const AAVE_SHA = '17567521ae51088c85e01a6d8240f18b383bac2f';
const COMET_SHA = 'f766f51583c23acc33b2a7824654ef2029a96804';
const lower = (value: string) => value.toLowerCase();
const source = (repo: string, sha: string, file: string) => `https://github.com/${repo}/blob/${sha}/${file}`;
const aave = [
  [1, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', 'AaveV3Ethereum.ts'],
  [8453, '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', 'AaveV3Base.ts'],
  [42161, '0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'AaveV3Arbitrum.ts'],
  [10, '0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'AaveV3Optimism.ts'],
  [137, '0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'AaveV3Polygon.ts'],
  [56, '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', 'AaveV3BNB.ts'],
  [143, '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef', 'AaveV3Monad.ts'],
] as const;
const comet = [
  [1, '0xc3d688B66703497DAA19211EEdff47f25384cdc3', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'mainnet'],
  [8453, '0xb125E6687d4313864e53df431d5425969c15Eb2F', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base'],
  [42161, '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'arbitrum'],
] as const;

function fn(chainId: number, contract: string, protocol: string, name: string, signature: string, inputs: AbiFunction['inputs'], outputs: AbiFunction['outputs'], sourceRef: string, warnings: readonly string[] = []): DefiFunctionPolicy {
  return {
    capabilityId: `${protocol === 'Aave V3' ? 'aave-v3' : 'compound-comet'}:${chainId}:${lower(contract)}:${name}`,
    type: 'contract_call', chainId, contract, functionName: name, signature,
    abi: { type: 'function', name, stateMutability: 'nonpayable', inputs, outputs },
    status: 'active', provenance: { sourceRef, verifiedAt: '2026-10-02', status: 'verified' },
    protocol, operation: name, label: `${protocol} ${name}`,
    warnings: [...warnings, 'Caller controls ABI arguments; protocol-native validation and revert semantics are unchanged.'],
  };
}

const functions: DefiFunctionPolicy[] = [];
for (const [chainId, pool, module] of aave) {
  const sourceRef = `${source('aave-dao/aave-address-book', AAVE_SHA, `src/ts/${module}`)}; ${source('aave-dao/aave-v3-origin', '8305565ae342f1773c42cd2e4593f175fe5968a0', 'src/contracts/interfaces/IPool.sol')}`;
  functions.push(
    fn(chainId, pool, 'Aave V3', 'supply', 'supply(address,uint256,address,uint16)', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], [], sourceRef),
    fn(chainId, pool, 'Aave V3', 'withdraw', 'withdraw(address,uint256,address)', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], [{ name: '', type: 'uint256' }], sourceRef),
    fn(chainId, pool, 'Aave V3', 'borrow', 'borrow(address,uint256,uint256,uint16,address)', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'referralCode', type: 'uint16' }, { name: 'onBehalfOf', type: 'address' }], [], sourceRef, ['Borrow can create debt; caller assumes position and health-factor risk.']),
    fn(chainId, pool, 'Aave V3', 'repay', 'repay(address,uint256,uint256,address)', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }], [{ name: '', type: 'uint256' }], sourceRef),
  );
}
for (const [chainId, market, _base, network] of comet) {
  const sourceRef = `${source('compound-finance/comet', COMET_SHA, `deployments/${network}/usdc/roots.json`)}; ${source('compound-finance/comet', COMET_SHA, 'CometMainInterface.sol')}`;
  functions.push(
    fn(chainId, market, 'Compound III', 'supply', 'supply(address,uint256)', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }], [], sourceRef),
    fn(chainId, market, 'Compound III', 'withdraw', 'withdraw(address,uint256)', [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }], [], sourceRef, ['Base-asset withdrawal may create debt; caller assumes resulting position risk.']),
  );
}

const chains: DefiChainPolicy[] = [...new Set(functions.map((policy) => policy.chainId))].sort((a, b) => a - b).map((chainId) => {
  const rows = functions.filter((policy) => policy.chainId === chainId);
  return { chainId, status: 'active', contracts: [...new Set(rows.map((policy) => policy.contract.toLowerCase()))].map((address) => {
    const contractFunctions = rows.filter((policy) => policy.contract.toLowerCase() === address);
    return { address: contractFunctions[0].contract, status: 'active' as const, functions: contractFunctions };
  }) };
});

export const LENDING_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);
export function buildLendingRegistry(): DefiRegistryFragment { return { chains }; }

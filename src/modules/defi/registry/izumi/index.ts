import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const chainId = 1;
const swap = '0x2db0AFD0045F3518c77eC6591a542e326Befd3D7';
const liquidityManager = '0x19b683A2F45012318d9B2aE1280d68d3eC54D663';
const swapSource = 'izumi-swap-interface';
const liquiditySource = 'izumi-liquidity-manager-interface';
const u = (name: string, type: 'uint8' | 'uint24' | 'uint128' | 'uint256') => ({ name, type, internalType: type });
const i24 = (name: string) => ({ name, type: 'int24', internalType: 'int24' });
const a = (name: string) => ({ name, type: 'address', internalType: 'address' });

const swapAbi: AbiFunction = {
  type: 'function', name: 'swapAmount', stateMutability: 'payable',
  inputs: [{
    name: 'params', type: 'tuple', internalType: 'struct ISwap.SwapAmountParams', components: [
      { name: 'path', type: 'bytes', internalType: 'bytes' },
      a('recipient'), u('amount', 'uint128'), u('minAcquired', 'uint256'), u('deadline', 'uint256'),
    ],
  }],
  outputs: [{ name: 'cost', type: 'uint256', internalType: 'uint256' }, { name: 'acquire', type: 'uint256', internalType: 'uint256' }],
};
const mintAbi: AbiFunction = {
  type: 'function', name: 'mint', stateMutability: 'payable',
  inputs: [{
    name: 'mintParam', type: 'tuple', internalType: 'struct ILiquidityManager.MintParam', components: [
      a('miner'), a('tokenX'), a('tokenY'), u('fee', 'uint24'), i24('pl'), i24('pr'),
      u('xLim', 'uint128'), u('yLim', 'uint128'), u('amountXMin', 'uint128'), u('amountYMin', 'uint128'), u('deadline', 'uint256'),
    ],
  }],
  outputs: [{ name: 'lid', type: 'uint256', internalType: 'uint256' }, { name: 'liquidity', type: 'uint128', internalType: 'uint128' }, { name: 'amountX', type: 'uint256', internalType: 'uint256' }, { name: 'amountY', type: 'uint256', internalType: 'uint256' }],
};
const addLiquidityAbi: AbiFunction = {
  type: 'function', name: 'addLiquidity', stateMutability: 'payable',
  inputs: [{
    name: 'addLiquidityParam', type: 'tuple', internalType: 'struct ILiquidityManager.AddLiquidityParam', components: [
      u('lid', 'uint256'), u('xLim', 'uint128'), u('yLim', 'uint128'), u('amountXMin', 'uint128'), u('amountYMin', 'uint128'), u('deadline', 'uint256'),
    ],
  }],
  outputs: [{ name: 'liquidityDelta', type: 'uint128', internalType: 'uint128' }, { name: 'amountX', type: 'uint256', internalType: 'uint256' }, { name: 'amountY', type: 'uint256', internalType: 'uint256' }],
};
const decLiquidityAbi: AbiFunction = {
  type: 'function', name: 'decLiquidity', stateMutability: 'nonpayable',
  inputs: [u('lid', 'uint256'), u('liquidDelta', 'uint128'), u('amountXMin', 'uint256'), u('amountYMin', 'uint256'), u('deadline', 'uint256')],
  outputs: [{ name: 'amountX', type: 'uint256', internalType: 'uint256' }, { name: 'amountY', type: 'uint256', internalType: 'uint256' }],
};
const collectAbi: AbiFunction = {
  type: 'function', name: 'collect', stateMutability: 'payable',
  inputs: [a('recipient'), u('lid', 'uint256'), u('amountXLim', 'uint128'), u('amountYLim', 'uint128')],
  outputs: [{ name: 'amountX', type: 'uint256', internalType: 'uint256' }, { name: 'amountY', type: 'uint256', internalType: 'uint256' }],
};
const declarations: readonly { contract: string; abi: AbiFunction; sourceRef: string; operation: string }[] = [
  { contract: swap, abi: swapAbi, sourceRef: swapSource, operation: 'swap-amount' },
  { contract: liquidityManager, abi: mintAbi, sourceRef: liquiditySource, operation: 'mint' },
  { contract: liquidityManager, abi: addLiquidityAbi, sourceRef: liquiditySource, operation: 'add-liquidity' },
  { contract: liquidityManager, abi: decLiquidityAbi, sourceRef: liquiditySource, operation: 'dec-liquidity' },
  { contract: liquidityManager, abi: collectAbi, sourceRef: liquiditySource, operation: 'collect' },
];

function makeFunction(declaration: typeof declarations[number]): DefiFunctionPolicy {
  const { abi, contract, sourceRef, operation } = declaration;
  const signature = `${abi.name}(${abi.inputs.map(({ type }) => type === 'tuple' ? `(${(abi.inputs[0] as { components: readonly { type: string }[] }).components.map((part) => part.type).join(',')})` : type).join(',')})`;
  return {
    capabilityId: `izumi:v1:${chainId}:${contract.toLowerCase()}:${operation}`,
    type: 'contract_call', chainId, contract, functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-04', status: 'verified' },
    protocol: 'iZUMi', operation, label: `iZUMi ${abi.name}`,
    warnings: [
      'Explicit source-qualified test fixture only; not production admission, automatic grant, funded execution, pool availability, or complete-workflow certification.',
      'Caller controls ABI-valid path, token, miner, recipient, fee, price range, amounts, deadlines, limits, and native value; this fixture adds no financial, asset, owner, or feed restrictions.',
      'iZiSwap path routing and pool/NFT callback behavior are protocol-internal; this fixed ABI is not a generic wallet executor, arbitrary multicall, permit, or callback capability. NFT ownership, token approvals, pool eligibility, and liquidity remain independent prerequisites.',
    ],
  };
}

const functions = declarations.map(makeFunction);
const chains: DefiChainPolicy[] = [{
  chainId, status: 'active', contracts: [
    { address: swap, status: 'active', functions: functions.filter((fn) => fn.contract === swap) },
    { address: liquidityManager, status: 'active', functions: functions.filter((fn) => fn.contract === liquidityManager) },
  ],
}];

export const IZUMI_CAPABILITIES: readonly DefiFunctionPolicy[] = Object.freeze(functions);

/** Explicit active fixture for offline policy tests only; it is not runtime wired or automatically granted. */
export function buildIZumiRegistry(): DefiRegistryFragment { return { chains }; }

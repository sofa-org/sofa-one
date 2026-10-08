import { decodeFunctionData, encodeFunctionData, keccak256, stringToHex, toFunctionSelector } from 'viem';
import type { DefiFunctionPolicy, DefiInteraction } from '../defi.types';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export const POLYMARKET_PUSD_WRAP_IDENTITY = Object.freeze({
  capabilityId: 'polymarket-pusd:v1:137:0x93070a847efef7f70739046a929d47a521f5b8ee:wrap',
  chainId: 137,
  contract: '0x93070a847efef7f70739046a929d47a521f5b8ee',
  signature: 'wrap(address,address,uint256)',
  selector: '0x62355638',
  abiHash: '0x81dc7d5ac39b2555f3745adaf504e4a36d889896f2ce7ea8f38eb85f91596109',
  asset: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  stateMutability: 'nonpayable',
});

export const POLYMARKET_PUSD_WRAP_SCOPE = Object.freeze({
  kind: 'polymarket-pusd-wrap-v1' as const,
  asset: POLYMARKET_PUSD_WRAP_IDENTITY.asset,
  recipientPolicy: 'withdrawal-allowlist-v1' as const,
});

export const POLYMARKET_PUSD_WRAP_ABI = [{
  type: 'function', name: 'wrap', stateMutability: 'nonpayable',
  inputs: [
    { name: '_asset', type: 'address', internalType: 'address' },
    { name: '_to', type: 'address', internalType: 'address' },
    { name: '_amount', type: 'uint256', internalType: 'uint256' },
  ], outputs: [],
}] as const;

/** True for the canonical identity regardless of its catalog capability ID. */
export function isPolymarketPusdWrapIdentity(fn: Pick<DefiFunctionPolicy, 'capabilityId' | 'chainId' | 'contract' | 'signature'>): boolean {
  return fn.capabilityId === POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId
    || (fn.chainId === POLYMARKET_PUSD_WRAP_IDENTITY.chainId
      && fn.contract.toLowerCase() === POLYMARKET_PUSD_WRAP_IDENTITY.contract
      && toFunctionSelector(fn.signature).toLowerCase() === POLYMARKET_PUSD_WRAP_IDENTITY.selector);
}

function invalidPusdWrap(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = 'DEFI_INVALID_PARAMETERS';
  throw error;
}

/** Decode and canonically validate only calls matching the exact Polygon onramp identity. */
export function decodePusdWrapCall(chainId: number, interaction: DefiInteraction): { asset: string; recipient: string; amount: bigint } | null {
  if (chainId !== POLYMARKET_PUSD_WRAP_IDENTITY.chainId
    || interaction.to.toLowerCase() !== POLYMARKET_PUSD_WRAP_IDENTITY.contract
    || interaction.data.slice(0, 10).toLowerCase() !== POLYMARKET_PUSD_WRAP_IDENTITY.selector) return null;
  try {
    const data = interaction.data as `0x${string}`;
    const decoded = decodeFunctionData({ abi: POLYMARKET_PUSD_WRAP_ABI, data });
    const canonical = encodeFunctionData({ abi: POLYMARKET_PUSD_WRAP_ABI, functionName: 'wrap', args: decoded.args });
    if (canonical.toLowerCase() !== data.toLowerCase()) return invalidPusdWrap('Noncanonical pUSD wrap calldata');
    const [asset, recipient, amount] = decoded.args as readonly [`0x${string}`, `0x${string}`, bigint];
    if (asset.toLowerCase() !== POLYMARKET_PUSD_WRAP_IDENTITY.asset) return invalidPusdWrap('Invalid pUSD wrap asset');
    if (interaction.value !== undefined && BigInt(interaction.value) !== 0n) return invalidPusdWrap('pUSD wrap cannot send native value');
    return { asset: asset.toLowerCase(), recipient: recipient.toLowerCase(), amount };
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    return invalidPusdWrap('Invalid pUSD wrap calldata');
  }
}

/** Enforce the fixed identity and mandatory scope without constraining wrap arguments. */
export function validatePolymarketPusdWrapBinding(fn: DefiFunctionPolicy): void {
  const scope = fn.executionScope;
  if (fn.status === 'inactive' && !scope) return;
  if (!isPolymarketPusdWrapIdentity(fn) && scope?.kind !== 'polymarket-pusd-wrap-v1') return;
  if (fn.type !== 'contract_call' || fn.capabilityId !== POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId
    || fn.chainId !== POLYMARKET_PUSD_WRAP_IDENTITY.chainId
    || fn.contract.toLowerCase() !== POLYMARKET_PUSD_WRAP_IDENTITY.contract
    || fn.functionName !== 'wrap' || fn.signature !== POLYMARKET_PUSD_WRAP_IDENTITY.signature
    || toFunctionSelector(fn.signature).toLowerCase() !== POLYMARKET_PUSD_WRAP_IDENTITY.selector
    || keccak256(stringToHex(canonical([fn.abi]))) !== POLYMARKET_PUSD_WRAP_IDENTITY.abiHash
    || fn.abi.stateMutability !== POLYMARKET_PUSD_WRAP_IDENTITY.stateMutability
    || fn.abi.inputs.length !== 3
    || fn.abi.inputs[0].name !== '_asset' || fn.abi.inputs[0].type !== 'address' || fn.abi.inputs[0].internalType !== 'address'
    || fn.abi.inputs[1].name !== '_to' || fn.abi.inputs[1].type !== 'address' || fn.abi.inputs[1].internalType !== 'address'
    || fn.abi.inputs[2].name !== '_amount' || fn.abi.inputs[2].type !== 'uint256' || fn.abi.inputs[2].internalType !== 'uint256'
    || fn.abi.outputs.length !== 0 || scope?.kind !== 'polymarket-pusd-wrap-v1'
    || scope.asset !== POLYMARKET_PUSD_WRAP_IDENTITY.asset
    || scope.recipientPolicy !== 'withdrawal-allowlist-v1') throw new Error('Invalid Polymarket pUSD wrap identity or mandatory scope');
}

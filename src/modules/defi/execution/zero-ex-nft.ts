import { toFunctionSelector, type AbiFunction, type AbiParameter } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const SCOPE_KIND = 'zero-ex-nft-settlement-v1';
const EXCHANGE_PROXY = '0xdef1c0ded9bec7f1a1670819833240f027b25eff';

// Exact feature ABIs, with internalType removed. Names and mutability remain
// part of the binding; no umbrella ABI or other deployment supplies a variant.
const feeComponents = [
  { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'feeData', type: 'bytes' },
] as const;
const propertyComponents = [
  { name: 'propertyValidator', type: 'address' },
  { name: 'propertyData', type: 'bytes' },
] as const;
const signatureComponents = [
  { name: 'signatureType', type: 'uint8' },
  { name: 'v', type: 'uint8' },
  { name: 'r', type: 'bytes32' },
  { name: 's', type: 'bytes32' },
] as const;
const orderPrefix = [
  { name: 'direction', type: 'uint8' },
  { name: 'maker', type: 'address' },
  { name: 'taker', type: 'address' },
  { name: 'expiry', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'erc20Token', type: 'address' },
  { name: 'erc20TokenAmount', type: 'uint256' },
  { name: 'fees', type: 'tuple[]', components: feeComponents },
] as const;
const erc721Components = [
  ...orderPrefix,
  { name: 'erc721Token', type: 'address' },
  { name: 'erc721TokenId', type: 'uint256' },
  { name: 'erc721TokenProperties', type: 'tuple[]', components: propertyComponents },
] as const;
const erc1155Components = [
  ...orderPrefix,
  { name: 'erc1155Token', type: 'address' },
  { name: 'erc1155TokenId', type: 'uint256' },
  { name: 'erc1155TokenProperties', type: 'tuple[]', components: propertyComponents },
  { name: 'erc1155TokenAmount', type: 'uint128' },
] as const;
const signature = { name: 'signature', type: 'tuple', components: signatureComponents } as const;
const signatures = { name: 'signatures', type: 'tuple[]', components: signatureComponents } as const;
const callback = { name: 'callbackData', type: 'bytes' } as const;
const callbacks = { name: 'callbackData', type: 'bytes[]' } as const;
const incomplete = { name: 'revertIfIncomplete', type: 'bool' } as const;
const unwrap = { name: 'unwrapNativeToken', type: 'bool' } as const;
const successes = { name: 'successes', type: 'bool[]' } as const;
const erc721SellOrder = { name: 'sellOrder', type: 'tuple', components: erc721Components } as const;
const erc721BuyOrder = { name: 'buyOrder', type: 'tuple', components: erc721Components } as const;
const erc721SellOrders = { name: 'sellOrders', type: 'tuple[]', components: erc721Components } as const;
const erc721BuyOrders = { name: 'buyOrders', type: 'tuple[]', components: erc721Components } as const;
const erc1155SellOrder = { name: 'sellOrder', type: 'tuple', components: erc1155Components } as const;
const erc1155BuyOrder = { name: 'buyOrder', type: 'tuple', components: erc1155Components } as const;
const erc1155SellOrders = { name: 'sellOrders', type: 'tuple[]', components: erc1155Components } as const;

const abis: readonly AbiFunction[] = [
  { name: 'buyERC721', type: 'function', inputs: [erc721SellOrder, signature, callback], outputs: [], stateMutability: 'payable' },
  { name: 'sellERC721', type: 'function', inputs: [erc721BuyOrder, signature, { name: 'erc721TokenId', type: 'uint256' }, unwrap, callback], outputs: [], stateMutability: 'nonpayable' },
  { name: 'batchBuyERC721s', type: 'function', inputs: [erc721SellOrders, signatures, callbacks, incomplete], outputs: [successes], stateMutability: 'payable' },
  { name: 'matchERC721Orders', type: 'function', inputs: [erc721SellOrder, erc721BuyOrder, { ...signature, name: 'sellOrderSignature' }, { ...signature, name: 'buyOrderSignature' }], outputs: [{ name: 'profit', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'batchMatchERC721Orders', type: 'function', inputs: [erc721SellOrders, erc721BuyOrders, { ...signatures, name: 'sellOrderSignatures' }, { ...signatures, name: 'buyOrderSignatures' }], outputs: [{ name: 'profits', type: 'uint256[]' }, successes], stateMutability: 'nonpayable' },
  { name: 'buyERC1155', type: 'function', inputs: [erc1155SellOrder, signature, { name: 'erc1155BuyAmount', type: 'uint128' }, callback], outputs: [], stateMutability: 'payable' },
  { name: 'sellERC1155', type: 'function', inputs: [erc1155BuyOrder, signature, { name: 'erc1155TokenId', type: 'uint256' }, { name: 'erc1155SellAmount', type: 'uint128' }, unwrap, callback], outputs: [], stateMutability: 'nonpayable' },
  { name: 'batchBuyERC1155s', type: 'function', inputs: [erc1155SellOrders, signatures, { name: 'erc1155FillAmounts', type: 'uint128[]' }, callbacks, incomplete], outputs: [successes], stateMutability: 'payable' },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function canonicalType(param: AbiParameter): string {
  return param.type.startsWith('tuple')
    ? `(${(param as AbiParameter & { components: readonly AbiParameter[] }).components.map(canonicalType).join(',')})${param.type.slice(5)}`
    : param.type;
}

// Unnamed tuples decode positionally. This changes neither wire types nor the
// independently pinned, named ABI used for identity comparison above.
function positional(param: AbiParameter): AbiParameter {
  const wire = { ...param };
  delete wire.name;
  return 'components' in wire ? { ...wire, components: wire.components.map(positional) } as AbiParameter : wire as AbiParameter;
}

const methods = abis.map((abi) => {
  const signature = `${abi.name}(${abi.inputs.map(canonicalType).join(',')})`;
  return { abi, signature, selector: toFunctionSelector(signature), canonicalAbi: canonical(abi), parameters: abi.inputs.map(positional) };
});

/** Selected root identities must never fall through to outer-ABI-only policy. */
export function validateZeroExNftBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.chainId === 1 && fn.contract.toLowerCase() === EXCHANGE_PROXY;
  if (!root && !marked) return;
  const selector = root ? toFunctionSelector(fn.signature) : undefined;
  const method = root ? methods.find((entry) => entry.signature === fn.signature || entry.abi.name === fn.functionName || entry.selector === selector) : undefined;
  if (!method && !marked) return;
  if (!root || !method || !marked || fn.type !== 'contract_call'
    || fn.signature !== method.signature || fn.functionName !== method.abi.name
    || canonical(fn.abi) !== method.canonicalAbi || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid 0x NFT deployment/ABI/mandatory scope binding');
  }
}

function emptyBytes(value: unknown): void {
  if (value !== '0x') throw new TypeError('0x NFT configurable callback data must be empty');
}

function order(value: unknown): void {
  const fields = value as readonly unknown[];
  for (const fee of fields[7] as readonly (readonly unknown[])[]) emptyBytes(fee[2]);
  if ((fields[10] as readonly unknown[]).length !== 0) throw new TypeError('0x NFT property validators are not admitted');
}

/** No configurable settlement callbacks; token/ETH recipient code can still run. */
export function validateZeroExNftSettlement(data: string): void {
  const selector = data.slice(0, 10).toLowerCase();
  const method = methods.find((entry) => entry.selector === selector);
  if (!method) throw new TypeError('Unsupported 0x NFT settlement selector');
  const args = decodeUniswapParameters(method.parameters, `0x${data.slice(10)}`);
  switch (method.abi.name) {
    case 'buyERC721':
      order(args[0]);
      emptyBytes(args[2]);
      break;
    case 'sellERC721':
      order(args[0]);
      emptyBytes(args[4]);
      break;
    case 'buyERC1155':
      order(args[0]);
      emptyBytes(args[3]);
      break;
    case 'sellERC1155':
      order(args[0]);
      emptyBytes(args[5]);
      break;
    case 'batchBuyERC721s':
    case 'batchBuyERC1155s':
      for (const item of args[0] as readonly unknown[]) order(item);
      for (const item of args[method.abi.name === 'batchBuyERC721s' ? 2 : 3] as readonly unknown[]) emptyBytes(item);
      break;
    case 'matchERC721Orders':
      order(args[0]);
      order(args[1]);
      break;
    case 'batchMatchERC721Orders':
      // Check both complete arrays even when the source will catch a pair's
      // failure or reject mismatched lengths. No attempted item bypasses scope.
      for (const items of [args[0], args[1]]) for (const item of items as readonly unknown[]) order(item);
      break;
  }
}

import { toFunctionSelector, type AbiFunction, type AbiParameter } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { decodeUniswapParameters } from './uniswap-wire';

const SCOPE_KIND = 'velora-empty-permit-settlement-v1';
const TARGET = '0xe92b586627cca7a83dc919cc7127196d70f55a06';

function parameter(name: string, type: 'uint256' | 'uint128' | 'address' | 'bytes'): AbiParameter {
  return { name, type, internalType: type };
}
const order: AbiParameter = {
  name: 'order', type: 'tuple', internalType: 'struct AugustusRFQ.Order',
  components: [
    parameter('nonceAndMeta', 'uint256'), parameter('expiry', 'uint128'),
    parameter('makerAsset', 'address'), parameter('takerAsset', 'address'),
    parameter('maker', 'address'), parameter('taker', 'address'),
    parameter('makerAmount', 'uint256'), parameter('takerAmount', 'uint256'),
  ],
};
const nftOrder: AbiParameter = {
  name: 'order', type: 'tuple', internalType: 'struct AugustusRFQ.OrderNFT',
  components: [
    parameter('nonceAndMeta', 'uint256'), parameter('expiry', 'uint128'),
    parameter('makerAsset', 'uint256'), parameter('makerAssetId', 'uint256'),
    parameter('takerAsset', 'uint256'), parameter('takerAssetId', 'uint256'),
    parameter('maker', 'address'), parameter('taker', 'address'),
    parameter('makerAmount', 'uint256'), parameter('takerAmount', 'uint256'),
  ],
};
const proof = parameter('signature', 'bytes');
const fillAmount = parameter('takerTokenFillAmount', 'uint256');
const takerPermit = parameter('permitTakerAsset', 'bytes');
const makerPermit = parameter('permitMakerAsset', 'bytes');
const target = parameter('target', 'address');
const makerFilled = parameter('makerTokenFilledAmount', 'uint256');
const orderInfos: AbiParameter = {
  name: 'orderInfos', type: 'tuple[]', internalType: 'struct AugustusRFQ.OrderInfo[]',
  components: [order, proof, fillAmount, takerPermit, makerPermit],
};
const nftOrderInfos: AbiParameter = {
  name: 'orderInfos', type: 'tuple[]', internalType: 'struct AugustusRFQ.OrderNFTInfo[]',
  components: [nftOrder, proof, fillAmount, takerPermit, makerPermit],
};
const abis: readonly AbiFunction[] = [
  { name: 'batchFillOrderWithTarget', type: 'function', inputs: [orderInfos, target], outputs: [], stateMutability: 'nonpayable' },
  { name: 'batchFillOrderWithTargetNFT', type: 'function', inputs: [nftOrderInfos, target], outputs: [], stateMutability: 'nonpayable' },
  { name: 'partialFillOrderWithTargetPermit', type: 'function', inputs: [order, proof, fillAmount, target, takerPermit, makerPermit], outputs: [makerFilled], stateMutability: 'nonpayable' },
  { name: 'partialFillOrderWithTargetPermitNFT', type: 'function', inputs: [nftOrder, proof, fillAmount, target, takerPermit, makerPermit], outputs: [makerFilled], stateMutability: 'nonpayable' },
  { name: 'tryBatchFillOrderMakerAmount', type: 'function', inputs: [orderInfos, parameter('makerFillAmount', 'uint256'), target], outputs: [], stateMutability: 'nonpayable' },
  { name: 'tryBatchFillOrderTakerAmount', type: 'function', inputs: [orderInfos, parameter('takerFillAmount', 'uint256'), target], outputs: [], stateMutability: 'nonpayable' },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function parameterType(input: AbiParameter): string {
  return 'components' in input ? `(${input.components.map(parameterType).join(',')})${input.type.slice(5)}` : input.type;
}
// Positional decoding prevents named tuple objects from obscuring permit positions.
function positional(input: AbiParameter): AbiParameter {
  const result = { ...input };
  delete result.name;
  if ('components' in result) result.components = result.components.map(positional);
  return result;
}
const methods = abis.map((abi) => {
  const signature = `${abi.name}(${abi.inputs.map(parameterType).join(',')})`;
  return { abi, signature, selector: toFunctionSelector(signature), canonicalAbi: canonical(abi), inputs: abi.inputs.map(positional), batch: abi.inputs[0].type === 'tuple[]' };
});

/** Reserve the six exact entrypoints even when a policy omits or substitutes their marker. */
export function validateVeloraOrderBinding(fn: DefiFunctionPolicy): void {
  const marked = fn.executionScope?.kind === SCOPE_KIND;
  const root = fn.contract.toLowerCase() === TARGET;
  if (!root && !marked) return;
  const selector = root ? toFunctionSelector(fn.signature) : undefined;
  const method = root ? methods.find((entry) => entry.signature === fn.signature || entry.abi.name === fn.functionName || entry.selector === selector) : undefined;
  if (!method && !marked) return;
  if (!root || fn.chainId !== 1 || !method || !marked || fn.type !== 'contract_call'
    || fn.signature !== method.signature || fn.functionName !== method.abi.name
    || canonical(fn.abi) !== method.canonicalAbi || Object.keys(fn.executionScope!).length !== 1) {
    throw new TypeError('Invalid Velora settlement deployment/ABI/mandatory scope binding');
  }
}

/** Inspect all items, including those the contract might skip or catch after sufficient fill. */
export function validateVeloraOrderSettlement(data: string): void {
  const selector = typeof data === 'string' ? data.slice(0, 10).toLowerCase() : undefined;
  const method = methods.find((entry) => entry.selector === selector);
  if (!method) throw new TypeError('Unsupported Velora settlement selector');
  const args = decodeUniswapParameters(method.inputs, `0x${data.slice(10)}`);
  if (method.batch) {
    for (const item of args[0] as readonly (readonly unknown[])[]) {
      if (item[3] !== '0x' || item[4] !== '0x') throw new TypeError('Velora settlement permits must be empty');
    }
  } else if (args[4] !== '0x' || args[5] !== '0x') {
    throw new TypeError('Velora settlement permits must be empty');
  }
}

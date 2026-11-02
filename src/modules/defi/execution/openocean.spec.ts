import { encodeFunctionData, type Hex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';
import { validateOpenOceanSwap, validateOpenOceanSwapBinding } from './openocean';

const scopeKind = 'openocean-empty-permit-swap-v1';
const receiver = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const pool = '0x0000000000000000000000004444444444444444444444444444444444444444';
const methods = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope?.kind === scopeKind);
function request(fn: DefiFunctionPolicy, permit: Hex = '0x', count = 1): Hex {
  const v3 = fn.functionName === 'uniswapV3SwapToWithPermit';
  const args = [v3 ? receiver : token, 100n, 90n, Array.from({ length: count }, () => v3 ? BigInt(pool) : pool), permit];
  if (fn.abi.inputs.length === 6) args.push(v3 ? token : receiver);
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args });
}
function word(data: string, index: number, value: bigint): string {
  const offset = 10 + index * 64;
  return `${data.slice(0, offset)}${value.toString(16).padStart(64, '0')}${data.slice(offset + 64)}`;
}

describe('OpenOcean exact-empty permit swap boundary', () => {
  it.each(methods)('rejects short, EIP2612 and Permit2 payloads for $functionName', (fn) => {
    for (const permit of ['0x00', '0x01', ...[224, 256, 352, 384].map((size) => `0x${'00'.repeat(size)}`)] as Hex[]) {
      expect(() => validateOpenOceanSwap(request(fn, permit))).toThrow();
    }
  });

  it.each(methods)('bounds the entire $functionName route even when permit is empty', (fn) => {
    const data = request(fn);
    const routeOffset = Number(BigInt(`0x${data.slice(10 + 3 * 64, 10 + 4 * 64)}`)) / 32;
    const permitOffset = Number(BigInt(`0x${data.slice(10 + 4 * 64, 10 + 5 * 64)}`)) / 32;
    for (const invalid of [request(fn, '0x', 65), word(data, routeOffset, 65n),
      word(data, routeOffset, (1n << 256n) - 1n), word(data, permitOffset, 65_537n),
      word(data, 3, 1n), word(data, 3, (1n << 256n) - 1n), word(data, 4, 1n),
      word(data, 4, (1n << 256n) - 1n)]) {
      expect(() => validateOpenOceanSwap(invalid)).toThrow();
    }
  });

  it.each(methods)('rejects noncanonical or malformed $functionName calldata', (fn) => {
    const data = request(fn);
    const invalid = ['0x', data.slice(0, 10), data.slice(0, -2), `${data}00`,
      word(data, 0, (1n << 160n) + BigInt(receiver)),
      `${data.slice(0, 10)}${'00'.repeat(65_537)}`, `${data.slice(0, -1)}g`];
    if (fn.abi.inputs.length === 6) invalid.push(word(data, 5, (1n << 160n) + BigInt(token)));
    for (const payload of invalid) expect(() => validateOpenOceanSwap(payload)).toThrow();
  });

  it.each(methods)('does not admit the ordinary route selector through the $functionName decoder', (fn) => {
    const ordinaryName = fn.functionName.replace('WithPermit', '');
    const ordinary = PRODUCTION_DEFI_MANIFEST.capabilities.find((entry) => entry.chainId === fn.chainId
      && entry.contract.toLowerCase() === fn.contract.toLowerCase() && entry.functionName === ordinaryName)!;
    const args = fn.functionName === 'uniswapV3SwapToWithPermit'
      ? [receiver, 100n, 90n, [BigInt(pool)]]
      : [token, 100n, 90n, [pool], ...(ordinaryName === 'callUniswapTo' ? [receiver] : [])];
    const data = encodeFunctionData({ abi: [ordinary.abi], functionName: ordinary.functionName, args });
    expect(() => validateOpenOceanSwap(data)).toThrow();
  });

  it.each(methods)('cannot strip, widen or transplant the $functionName binding', (fn) => {
    const variants: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 4 } },
      { ...fn, executionScope: { ...fn.executionScope, permitIndex: 4 } as unknown as DefiExecutionScope },
      { ...fn, contract: receiver }, { ...fn, chainId: 56 }, { ...fn, type: 'typed_data_sign' },
      { ...fn, signature: 'callUniswap(address,uint256,uint256,bytes32[])' },
      { ...fn, functionName: 'callUniswap' },
      { ...fn, abi: { ...fn.abi, stateMutability: 'payable' } },
      { ...fn, abi: { ...fn.abi, outputs: [] } },
      { ...fn, abi: { ...fn.abi, inputs: fn.abi.inputs.map((input, i) => i === 4 ? { ...input, name: 'uncheckedData' } : input) } },
      { ...fn, abi: { ...fn.abi, inputs: fn.abi.inputs.map((input, i) => i === 0 ? { ...input, internalType: 'address' } : input) } },
      { ...fn, abi: { ...fn.abi, outputs: fn.abi.outputs.map((output) => ({ ...output, name: '' })) } },
    ];
    for (const variant of variants) expect(() => validateOpenOceanSwapBinding(variant)).toThrow();
  });
});

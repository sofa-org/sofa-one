import { decodeAbiParameters, encodeAbiParameters, type AbiParameter, type Hex } from 'viem';

const MAX_BYTES = 65_536;
const MAX_ITEMS = 64;
const MAX_DEPTH = 8;

/** Bound every dynamic length before viem can allocate; reject alternate ABI encodings afterward. */
export function decodeUniswapParameters(parameters: readonly AbiParameter[], data: string): readonly unknown[] {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data) || data.length > 2 + MAX_BYTES * 2) throw new TypeError('Invalid Uniswap ABI bytes');
  const bytes = (data.length - 2) / 2;
  let visited = 0;
  const word = (offset: number): number => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > bytes) throw new TypeError('Uniswap ABI out of bounds');
    const value = BigInt(`0x${data.slice(2 + offset * 2, 2 + (offset + 32) * 2)}`);
    if (value > BigInt(MAX_BYTES)) throw new TypeError('Uniswap ABI length bound exceeded');
    return Number(value);
  };
  const array = (param: AbiParameter): { child: AbiParameter; length: number | null } | null => {
    const match = /^(.*)\[([0-9]*)\]$/.exec(param.type);
    return match ? { child: { ...param, type: match[1] } as AbiParameter, length: match[2] ? Number(match[2]) : null } : null;
  };
  const dynamic = (param: AbiParameter): boolean => {
    const items = array(param);
    if (items) return items.length === null || dynamic(items.child);
    if (param.type === 'tuple') return (param as AbiParameter & { components: readonly AbiParameter[] }).components.some(dynamic);
    return param.type === 'bytes' || param.type === 'string';
  };
  const size = (param: AbiParameter): number => {
    if (dynamic(param)) return 32;
    const items = array(param);
    if (items) {
      if (items.length === null || items.length > MAX_ITEMS) throw new TypeError('Uniswap ABI array bound exceeded');
      return items.length * size(items.child);
    }
    if (param.type === 'tuple') return (param as AbiParameter & { components: readonly AbiParameter[] }).components.reduce((sum, child) => sum + size(child), 0);
    return 32;
  };
  const sequence = (params: readonly AbiParameter[], base: number, depth: number): void => {
    if (depth > MAX_DEPTH) throw new TypeError('Uniswap ABI nesting bound exceeded');
    const head = params.reduce((sum, param) => sum + size(param), 0);
    if (base + head > bytes) throw new TypeError('Truncated Uniswap ABI head');
    let offset = base;
    for (const param of params) {
      if (++visited > 1024) throw new TypeError('Uniswap ABI node bound exceeded');
      let start = offset;
      if (dynamic(param)) {
        const relative = word(offset);
        if (relative % 32 !== 0 || relative < head) throw new TypeError('Invalid Uniswap ABI offset');
        start = base + relative;
      }
      value(param, start, depth + 1);
      offset += size(param);
    }
  };
  const value = (param: AbiParameter, base: number, depth: number): void => {
    const items = array(param);
    if (items) {
      const count = items.length ?? word(base);
      if (!Number.isSafeInteger(count) || count > MAX_ITEMS) throw new TypeError('Uniswap ABI array bound exceeded');
      sequence(Array.from({ length: count }, () => items.child), base + (items.length === null ? 32 : 0), depth);
    } else if (param.type === 'tuple') {
      sequence((param as AbiParameter & { components: readonly AbiParameter[] }).components, base, depth);
    } else if (param.type === 'bytes' || param.type === 'string') {
      const length = word(base);
      if (base + 32 + Math.ceil(length / 32) * 32 > bytes) throw new TypeError('Truncated Uniswap ABI bytes');
    } else if (base + 32 > bytes) throw new TypeError('Truncated Uniswap ABI word');
  };
  sequence(parameters, 0, 0);
  const decoded = decodeAbiParameters(parameters, data as Hex);
  if (encodeAbiParameters(parameters, decoded).toLowerCase() !== data.toLowerCase()) throw new TypeError('Noncanonical Uniswap ABI');
  return decoded;
}

import { decodeAbiParameters, encodeAbiParameters } from 'viem';

export const AMBIENT_CHAIN_ID = 1;
export const AMBIENT_TARGET = '0xAaAaAAAaA24eEeb8d57D431224f73832bC34f688';
export const AMBIENT_SIGNATURE = 'userCmd(uint16,bytes)';
export const AMBIENT_SELECTOR = '0xa15112f9';

const PATH1_TYPES = [
  { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' },
  { type: 'uint128' }, { type: 'uint16' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' },
] as const;
const PATH2_TYPES = [
  { type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'int24' },
  { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }, { type: 'address' },
] as const;
const LP_CODES = new Set([1, 2, 3, 4, 11, 12, 21, 22, 31, 32, 41, 42]);

/** Bounds the known root wire shape and extracts only bounded dynamic bytes before any ABI decode. */
export function preflightAmbientRoot(data: string): { callpath: 1 | 2; payload: `0x${string}` } {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(data) || data.length < 10 + 64 * 2 + 32 * 2) throw new TypeError('Malformed Ambient userCmd');
  if (data.slice(0, 10).toLowerCase() !== AMBIENT_SELECTOR) throw new TypeError('Wrong Ambient selector');
  const body = data.slice(10);
  const read = (byteOffset: number): bigint => {
    const start = byteOffset * 2;
    const word = body.slice(start, start + 64);
    if (word.length !== 64) throw new TypeError('Malformed Ambient userCmd');
    return BigInt(`0x${word}`);
  };
  const rawCallpath = read(0);
  if (rawCallpath > 0xffffn || (rawCallpath !== 1n && rawCallpath !== 2n)) throw new TypeError('Unsupported Ambient callpath');
  if (read(32) !== 64n) throw new TypeError('Noncanonical Ambient bytes offset');
  const declared = read(64);
  const expected = rawCallpath === 1n ? 320n : 352n;
  if (declared !== expected || BigInt(body.length / 2) !== 96n + expected) throw new TypeError('Invalid Ambient payload length');
  const payload = `0x${body.slice(96 * 2)}` as `0x${string}`;
  return { callpath: Number(rawCallpath) as 1 | 2, payload };
}

/** The only inner-language admission: canonical static ABI data for the two reviewed cold paths. */
export function validateAmbientColdpathPayload(callpath: number, payload: string): void {
  if (callpath !== 1 && callpath !== 2) throw new TypeError('Unsupported Ambient callpath');
  const types = callpath === 1 ? PATH1_TYPES : PATH2_TYPES;
  const expectedBytes = callpath === 1 ? 320 : 352;
  if (typeof payload !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(payload) || payload.length !== 2 + expectedBytes * 2) throw new TypeError('Invalid Ambient payload length');
  const decoded = decodeAbiParameters(types, payload as `0x${string}`);
  if (encodeAbiParameters(types, decoded).toLowerCase() !== payload.toLowerCase()) throw new TypeError('Noncanonical Ambient payload');
  if (callpath === 2 && !LP_CODES.has(Number(decoded[0]))) throw new TypeError('Unsupported Ambient LP command');
}

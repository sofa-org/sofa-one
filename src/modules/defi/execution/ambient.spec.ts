import { encodeAbiParameters } from 'viem';
import { validateAmbientColdpathPayload } from './ambient';

const tokenA = '0x1111111111111111111111111111111111111111';
const tokenB = '0x2222222222222222222222222222222222222222';
const conduit = '0x3333333333333333333333333333333333333333';
const path1Types = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'uint128' }, { type: 'uint16' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }] as const;
const path2Types = [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }, { type: 'address' }] as const;

describe('Ambient cold-path grammar', () => {
  it('accepts path 1 with unrestricted well-typed financial values', () => {
    const payload = encodeAbiParameters(path1Types, [tokenA, tokenB, (1n << 256n) - 1n, true, false, (1n << 128n) - 1n, 65535, (1n << 128n) - 1n, (1n << 128n) - 1n, 255]);
    expect(() => validateAmbientColdpathPayload(1, payload)).not.toThrow();
  });

  it.each([1, 2, 3, 4, 11, 12, 21, 22, 31, 32, 41, 42])('accepts reviewed LP command code %s and arbitrary signed ticks/conduit', (code) => {
    const payload = encodeAbiParameters(path2Types, [code, tokenA, tokenB, (1n << 256n) - 1n, -8388608, 8388607, (1n << 128n) - 1n, 0n, (1n << 128n) - 1n, 255, conduit]);
    expect(() => validateAmbientColdpathPayload(2, payload)).not.toThrow();
  });

  it('rejects unsupported path/code, malformed booleans, address padding, signed padding and wrong byte lengths', () => {
    const validPath1 = encodeAbiParameters(path1Types, [tokenA, tokenB, 1n, true, false, 1n, 2, 3n, 4n, 5]);
    const boolWordStart = 2 + 3 * 64;
    const badBool = `${validPath1.slice(0, boolWordStart)}${'0'.repeat(63)}2${validPath1.slice(boolWordStart + 64)}`;
    expect(() => validateAmbientColdpathPayload(1, badBool)).toThrow();
    const addressWordStart = 2;
    const badAddress = `${validPath1.slice(0, addressWordStart)}${'1'.repeat(24)}${validPath1.slice(addressWordStart + 24)}`;
    expect(() => validateAmbientColdpathPayload(1, badAddress)).toThrow();
    expect(() => validateAmbientColdpathPayload(3, validPath1)).toThrow();
    expect(() => validateAmbientColdpathPayload(1, `${validPath1}00`)).toThrow();

    const validPath2 = encodeAbiParameters(path2Types, [1, tokenA, tokenB, 1n, -1, 1, 1n, 2n, 3n, 4, conduit]);
    const tickWordStart = 2 + 4 * 64;
    const badSignedPadding = `${validPath2.slice(0, tickWordStart)}${'0'.repeat(2)}${validPath2.slice(tickWordStart + 2)}`;
    expect(() => validateAmbientColdpathPayload(2, badSignedPadding)).toThrow();
    const commandWordStart = 2;
    const badCode = `${validPath2.slice(0, commandWordStart)}${'0'.repeat(63)}5${validPath2.slice(commandWordStart + 64)}`;
    expect(() => validateAmbientColdpathPayload(2, badCode)).toThrow();
  });
});

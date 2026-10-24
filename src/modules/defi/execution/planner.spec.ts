import { encodeFunctionData, parseAbi } from 'viem';
import { preflightBytesArray } from './planner';

const abi = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)']);
const encode = (items: `0x${string}`[]) => encodeFunctionData({ abi, functionName: 'multicall', args: [items] });

describe('preflightBytesArray', () => {
  it('uses canonical offsets relative to the array head base for actual viem-encoded arrays', () => {
    expect(preflightBytesArray(encode(['0x12345678']))).toBe(1);
    expect(preflightBytesArray(encode(['0x12345678', '0xabcdef01']))).toBe(2);
    expect(preflightBytesArray(encode(Array.from({ length: 10 }, () => '0x12345678')))).toBe(10);
  });

  it('rejects excessive declared counts, malformed offsets, and truncated element lengths before ABI decoding', () => {
    const valid = encode(['0x12345678']);
    const giantCount = `${valid.slice(0, 74)}${'f'.repeat(64)}${valid.slice(138)}`;
    expect(() => preflightBytesArray(giantCount)).toThrow();
    const badOffset = `${valid.slice(0, 10)}${'0'.repeat(62)}01${valid.slice(74)}`;
    expect(() => preflightBytesArray(badOffset)).toThrow();
    const giantElement = `${valid.slice(0, 202)}${'f'.repeat(64)}${valid.slice(266)}`;
    expect(() => preflightBytesArray(giantElement)).toThrow();
    expect(() => preflightBytesArray(`${valid.slice(0, -2)}`)).toThrow();
    expect(() => preflightBytesArray('0x1234567')).toThrow();
  });
});

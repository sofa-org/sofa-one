import { hashTypedData } from 'viem';
import { polymarketDepositBatchDigest, validatePolymarketDepositBatch } from './polymarket-deposit-batch';

const nowMs = 1_700_000_000_000;
const wallet = '0x1111111111111111111111111111111111111111';
const targetA = '0x2222222222222222222222222222222222222222';
const targetB = '0x3333333333333333333333333333333333333333';
const callFields = () => [['target', 'address'], ['value', 'uint256'], ['data', 'bytes']].map(([name, type]) => ({ name, type }));
const batchFields = () => [['wallet', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'], ['calls', 'Call[]']].map(([name, type]) => ({ name, type }));
const sample = () => ({
  domain: { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: wallet },
  types: { Call: callFields(), Batch: batchFields() },
  primaryType: 'Batch',
  message: {
    wallet,
    nonce: '7',
    deadline: '1700000300',
    calls: [
      { target: targetA, value: '0', data: '0x12345678' },
      { target: targetB, value: 0, data: '0xaabbccdd' },
    ],
  },
});

describe('Polymarket DepositWallet Batch typed-data validator', () => {
  it('accepts the exact Batch schema, canonicalizes uints, freezes the complete ordered payload and hashes it', () => {
    const input = sample();
    const payload = validatePolymarketDepositBatch(input, nowMs);
    expect(payload.primaryType).toBe('Batch');
    expect(payload.domain).toEqual({ name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: wallet });
    expect(payload.message).toEqual({ ...input.message, nonce: '7', deadline: '1700000300', calls: [
      { target: targetA, value: '0', data: '0x12345678' },
      { target: targetB, value: '0', data: '0xaabbccdd' },
    ] });
    expect(polymarketDepositBatchDigest(payload)).toBe(hashTypedData(payload as any));
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.message.calls)).toBe(true);
    expect(Object.isFrozen(payload.message.calls[0])).toBe(true);
    expect(Object.isFrozen(payload.types.Call[0])).toBe(true);
    expect(() => ((payload.message.calls as any)[0].data = '0x')).toThrow();
  });

  it('commits the ordered full calls array into the digest', () => {
    const original = validatePolymarketDepositBatch(sample(), nowMs);
    const reordered = sample();
    reordered.message.calls.reverse();
    const changed = validatePolymarketDepositBatch(reordered, nowMs);
    expect(polymarketDepositBatchDigest(changed)).not.toBe(polymarketDepositBatchDigest(original));
  });

  it('matches the independent literal EIP-712 Batch digest golden vector', () => {
    const payload = validatePolymarketDepositBatch(sample(), nowMs);
    expect(polymarketDepositBatchDigest(payload)).toBe('0xacd51c482e14a3777121289c375c9a86adc62f618dfb96e7022c6c05f23453f3');
  });

  it.each([
    ['extra root field', (input: any) => { input.extra = true; }],
    ['extra domain field', (input: any) => { input.domain.salt = '0x00'; }],
    ['wrong domain name', (input: any) => { input.domain.name = 'OtherWallet'; }],
    ['wrong chain', (input: any) => { input.domain.chainId = 1; }],
    ['wallet/domain mismatch', (input: any) => { input.message.wallet = targetA; }],
    ['extra message field', (input: any) => { input.message.extra = 'x'; }],
    ['extra call field', (input: any) => { input.message.calls[0].extra = 1; }],
    ['type field order', (input: any) => { input.types.Batch.reverse(); }],
    ['call type mismatch', (input: any) => { input.types.Call[1].type = 'bytes32'; }],
    ['wrong primary type', (input: any) => { input.primaryType = 'Call'; }],
  ])('rejects %s', (_label, mutate) => {
    const input = sample();
    mutate(input);
    expect(() => validatePolymarketDepositBatch(input, nowMs)).toThrow();
  });

  it.each([
    ['empty calls', (input: any) => { input.message.calls = []; }],
    ['33 calls', (input: any) => { input.message.calls = Array.from({ length: 33 }, () => ({ target: targetA, value: '0', data: '0x' })); }],
    ['nonzero value', (input: any) => { input.message.calls[0].value = '1'; }],
    ['per-call bytes over 8 KiB', (input: any) => { input.message.calls[0].data = `0x${'aa'.repeat(8193)}`; }],
    ['total bytes over 32 KiB', (input: any) => { input.message.calls = Array.from({ length: 5 }, () => ({ target: targetA, value: '0', data: `0x${'aa'.repeat(8192)}` })); }],
    ['odd-length hex', (input: any) => { input.message.calls[0].data = '0x123'; }],
    ['non-hex calldata', (input: any) => { input.message.calls[0].data = '0xgg'; }],
    ['zero target', (input: any) => { input.message.calls[0].target = '0x0000000000000000000000000000000000000000'; }],
    ['unsafe numeric uint', (input: any) => { input.message.nonce = Number.MAX_SAFE_INTEGER + 1; }],
    ['negative uint', (input: any) => { input.message.nonce = -1; }],
    ['hex uint string', (input: any) => { input.message.nonce = '0x01'; }],
    ['uint256 overflow', (input: any) => { input.message.nonce = (1n << 256n).toString(); }],
    ['oversized nonce decimal', (input: any) => { input.message.nonce = '9'.repeat(100_000); }],
    ['oversized deadline decimal', (input: any) => { input.message.deadline = '9'.repeat(100_000); }],
    ['expired deadline', (input: any) => { input.message.deadline = '1700000000'; }],
    ['deadline beyond 300 seconds', (input: any) => { input.message.deadline = '1700000301'; }],
  ])('rejects %s', (_label, mutate) => {
    const input = sample();
    mutate(input);
    expect(() => validatePolymarketDepositBatch(input, nowMs)).toThrow();
  });

  it('revalidates deadline at the supplied current time', () => {
    const payload = sample();
    expect(() => validatePolymarketDepositBatch(payload, nowMs)).not.toThrow();
    expect(() => validatePolymarketDepositBatch(payload, nowMs + 300_000)).toThrow();
  });
});

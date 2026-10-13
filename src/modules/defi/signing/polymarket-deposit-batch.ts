import { BadRequestException } from '@nestjs/common';
import { hashTypedData, isAddress } from 'viem';

const UINT256_MAX = (1n << 256n) - 1n;
const MAX_CALLS = 32;
const MAX_CALL_BYTES = 8 * 1024;
const MAX_TOTAL_CALL_BYTES = 32 * 1024;
const CALL_FIELDS = [['target', 'address'], ['value', 'uint256'], ['data', 'bytes']] as const;
const BATCH_FIELDS = [['wallet', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'], ['calls', 'Call[]']] as const;

type Field = Readonly<{ name: string; type: string }>;
export type PolymarketDepositBatchCall = Readonly<{ target: string; value: string; data: `0x${string}` }>;
export type ValidatedPolymarketDepositBatch = Readonly<{
  domain: Readonly<{ name: 'DepositWallet'; version: '1'; chainId: 137; verifyingContract: string }>;
  types: Readonly<{ Call: readonly Field[]; Batch: readonly Field[] }>;
  primaryType: 'Batch';
  message: Readonly<{ wallet: string; nonce: string; deadline: string; calls: readonly PolymarketDepositBatchCall[] }>;
}>;

/** Validate and normalize the bounded DepositWallet EIP-712 Batch envelope. */
export function validatePolymarketDepositBatch(input: unknown, nowMs = Date.now()): ValidatedPolymarketDepositBatch {
  const fail = (): never => { throw new BadRequestException('Invalid typed-data signing request'); };
  const obj = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  const fields = (value: unknown, expected: readonly (readonly [string, string])[]) => Array.isArray(value)
    && value.length === expected.length
    && value.every((field, i) => obj(field) && exact(field, ['name', 'type']) && field.name === expected[i][0] && field.type === expected[i][1]);
  const uint = (value: unknown): string | null => {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) return null;
      value = String(value);
    }
    if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    try { return BigInt(value) <= UINT256_MAX ? value : null; } catch { return null; }
  };
  const address = (value: unknown): value is string => typeof value === 'string'
    && isAddress(value)
    && value.toLowerCase() !== '0x0000000000000000000000000000000000000000';

  if (!obj(input) || !exact(input, ['domain', 'types', 'primaryType', 'message']) || !obj(input.domain) || !obj(input.types) || !obj(input.message) || input.primaryType !== 'Batch') return fail();
  const domain = input.domain;
  if (!exact(domain, ['name', 'version', 'chainId', 'verifyingContract'])
    || domain.name !== 'DepositWallet' || domain.version !== '1' || domain.chainId !== 137 || !address(domain.verifyingContract)) return fail();

  const types = input.types;
  if (!exact(types, ['Call', 'Batch']) || !fields(types.Call, CALL_FIELDS) || !fields(types.Batch, BATCH_FIELDS)) return fail();

  const message = input.message;
  if (!exact(message, ['wallet', 'nonce', 'deadline', 'calls']) || !address(message.wallet)
    || message.wallet.toLowerCase() !== domain.verifyingContract.toLowerCase()
    || !Array.isArray(message.calls) || message.calls.length < 1 || message.calls.length > MAX_CALLS) return fail();

  const nonce = uint(message.nonce);
  const deadline = uint(message.deadline);
  if (nonce === null || deadline === null || !Number.isSafeInteger(nowMs) || nowMs < 0) return fail();
  const nowSeconds = Math.floor(nowMs / 1000);
  const deadlineValue = BigInt(deadline);
  if (deadlineValue <= BigInt(nowSeconds) || deadlineValue > BigInt(nowSeconds + 300)) return fail();

  let totalCallBytes = 0;
  const calls: PolymarketDepositBatchCall[] = message.calls.map((call: unknown) => {
    if (!obj(call) || !exact(call, ['target', 'value', 'data']) || !address(call.target)) return fail();
    const value = uint(call.value);
    if (value === null || value !== '0' || typeof call.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data)) return fail();
    const byteLength = (call.data.length - 2) / 2;
    if (byteLength > MAX_CALL_BYTES) return fail();
    totalCallBytes += byteLength;
    if (totalCallBytes > MAX_TOTAL_CALL_BYTES) return fail();
    return { target: call.target, value, data: call.data as `0x${string}` };
  });

  return deepFreeze({
    domain: { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: domain.verifyingContract },
    types: {
      Call: CALL_FIELDS.map(([name, type]) => ({ name, type })),
      Batch: BATCH_FIELDS.map(([name, type]) => ({ name, type })),
    },
    primaryType: 'Batch',
    message: { wallet: message.wallet, nonce, deadline, calls },
  }) as ValidatedPolymarketDepositBatch;
}

/** Hash the complete typed-data Batch, including each ordered target/value/calldata tuple. */
export function polymarketDepositBatchDigest(payload: ValidatedPolymarketDepositBatch): `0x${string}` {
  return hashTypedData(payload as any);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as object).forEach(deepFreeze);
  }
  return value;
}

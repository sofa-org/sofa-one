import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WithdrawDto } from './withdraw.dto';

describe('WithdrawDto', () => {
  const validateDto = (input: Record<string, unknown>) => validate(plainToInstance(WithdrawDto, input));

  it('accepts a valid withdrawal DTO', async () => {
    const errors = await validateDto({
      chainId: 84532,
      to: '0x1111111111111111111111111111111111111111',
      amount: '10000',
      token: 'USDC',
      idempotencyKey: 'withdraw-123_abc',
    });

    expect(errors).toHaveLength(0);
  });

  it('requires chainId to be a positive integer', async () => {
    const invalidValues = [0, -1, 1.5, '84532'];

    for (const chainId of invalidValues) {
      const errors = await validateDto({
        chainId,
        to: '0x1111111111111111111111111111111111111111',
        amount: '10000',
        token: 'USDC',
        idempotencyKey: 'withdraw-chain',
      });

      expect(errors.some((error) => error.property === 'chainId')).toBe(true);
    }
  });

  it('requires to to be a 0x-prefixed 40-hex-character address', async () => {
    const invalidValues = [
      '0x111111111111111111111111111111111111111',
      '1111111111111111111111111111111111111111',
      '0xZZ11111111111111111111111111111111111111',
    ];

    for (const to of invalidValues) {
      const errors = await validateDto({
        chainId: 84532,
        to,
        amount: '10000',
        token: 'USDC',
        idempotencyKey: 'withdraw-to',
      });

      expect(errors.some((error) => error.property === 'to')).toBe(true);
    }
  });

  it('requires amount to be a numeric string within stablecoin micro-unit bounds', async () => {
    const invalidInputs = ['9999', '10000000001', 'abc', '10.5', '-10000'];

    for (const amount of invalidInputs) {
      const errors = await validateDto({
        chainId: 84532,
        to: '0x1111111111111111111111111111111111111111',
        amount,
        token: 'USDC',
        idempotencyKey: 'withdraw-amount',
      });

      expect(errors.some((error) => error.property === 'amount')).toBe(true);
    }
  });

  it('accepts USDT withdrawals with stablecoin micro-unit bounds', async () => {
    const errors = await validateDto({
      chainId: 84532,
      to: '0x1111111111111111111111111111111111111111',
      amount: '10000',
      token: 'USDT',
      idempotencyKey: 'withdraw-usdt',
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts the maximum single-withdrawal amount', async () => {
    const errors = await validateDto({
      chainId: 84532,
      to: '0x1111111111111111111111111111111111111111',
      amount: '10000000000',
      token: 'USDC',
      idempotencyKey: 'withdraw-max',
    });

    expect(errors).toHaveLength(0);
  });

  it('requires token to be USDC, USDT, or NATIVE', async () => {
    const errors = await validateDto({
      chainId: 84532,
      to: '0x1111111111111111111111111111111111111111',
      amount: '10000',
      token: 'DAI',
      idempotencyKey: 'withdraw-token',
    });

    expect(errors.some((error) => error.property === 'token')).toBe(true);
  });

  it('rejects invalid idempotencyKey characters and overlong values', async () => {
    const invalidValues = ['bad key', 'bad$key', 'a'.repeat(65)];

    for (const idempotencyKey of invalidValues) {
      const errors = await validateDto({
        chainId: 84532,
        to: '0x1111111111111111111111111111111111111111',
        amount: '10000',
        token: 'USDC',
        idempotencyKey,
      });

      expect(errors.some((error) => error.property === 'idempotencyKey')).toBe(true);
    }
  });
});

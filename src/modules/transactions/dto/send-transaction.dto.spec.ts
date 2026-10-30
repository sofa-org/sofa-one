import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_INTERACTION_CALLDATA_HEX_LENGTH,
  MAX_TRANSACTION_INTERACTIONS,
  SendTransactionDto,
} from './send-transaction.dto';
import { SignDto } from '../../wallet/dto/sign.dto';

describe('SendTransactionDto', () => {
  it('rejects empty interactions arrays', async () => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'empty-interactions',
      interactions: [],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'interactions')).toBe(true);
  });

  it.each([undefined, 'session_key'])('accepts transaction executionMode %p', async (executionMode) => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'mode-test',
      interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
      executionMode,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it.each(['eoa', 'invalid', '', null, 1])('rejects unsupported transaction executionMode %p', async (executionMode) => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'invalid-mode-test',
      interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
      executionMode,
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'executionMode')).toBe(true);
  });

  it('keeps EOA off-chain signing separate from session-key transaction execution', async () => {
    const sign = plainToInstance(SignDto, {
      executionMode: 'eoa',
      chainId: 137,
      type: 'typed_data',
      typedData: { domain: { chainId: 137 }, types: {}, primaryType: 'ClobAuth', message: {} },
    });
    expect(await validate(sign)).toHaveLength(0);
    sign.executionMode = 'session_key' as unknown as SignDto['executionMode'];
    expect((await validate(sign)).some((error) => error.property === 'executionMode')).toBe(true);
  });

  it('rejects more than ten interactions at the DTO boundary', async () => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'too-many-interactions',
      interactions: Array.from({ length: MAX_TRANSACTION_INTERACTIONS + 1 }, () => ({
        to: '0x1111111111111111111111111111111111111111',
        data: '0x',
        value: '0',
      })),
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'interactions')).toBe(true);
  });

  it('rejects oversized calldata at the DTO boundary', async () => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'oversized-calldata',
      interactions: [
        {
          to: '0x1111111111111111111111111111111111111111',
          data: `0x${'11'.repeat(MAX_INTERACTION_CALLDATA_HEX_LENGTH / 2)}`,
          value: '0',
        },
      ],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'interactions')).toBe(true);
  });

  it('rejects odd-length calldata', async () => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'odd-calldata',
      interactions: [
        {
          to: '0x1111111111111111111111111111111111111111',
          data: '0x123',
          value: '0',
        },
      ],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'interactions')).toBe(true);
  });
});

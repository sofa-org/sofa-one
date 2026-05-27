import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_INTERACTION_CALLDATA_HEX_LENGTH,
  MAX_TRANSACTION_INTERACTIONS,
  SendTransactionDto,
} from './send-transaction.dto';

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

  it('accepts executionMode', async () => {
    const dto = plainToInstance(SendTransactionDto, {
      chainId: 84532,
      idempotencyKey: 'mode-test',
      interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }],
      executionMode: 'eoa',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
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

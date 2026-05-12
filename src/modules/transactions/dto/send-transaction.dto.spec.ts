import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendTransactionDto } from './send-transaction.dto';

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
});

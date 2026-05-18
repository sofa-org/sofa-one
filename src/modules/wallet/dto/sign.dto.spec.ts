import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignDto } from './sign.dto';

describe('SignDto', () => {
  const validateDto = (input: Record<string, unknown>) => validate(plainToInstance(SignDto, input));

  it('accepts valid plain string message signing', async () => {
    const errors = await validateDto({
      type: 'message',
      message: 'Hello, world',
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts valid raw hex message signing', async () => {
    const errors = await validateDto({
      type: 'message',
      message: { raw: '0x48656c6c6f' },
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects invalid signing types', async () => {
    const invalidTypes = ['hash', 'raw_hash', 'raw-hash', 'rawHash'];

    for (const type of invalidTypes) {
      const errors = await validateDto({ type, message: 'Hello' });

      expect(errors.some((error) => error.property === 'type')).toBe(true);
    }
  });

  it('requires a non-empty valid message for message signing', async () => {
    const invalidInputs = [
      '',
      { raw: 'not-hex' },
      { raw: '0x123', extra: true },
      { raw: '0xzz' },
    ];

    for (const message of invalidInputs) {
      const errors = await validateDto({ type: 'message', message });

      expect(errors.some((error) => error.property === 'message')).toBe(true);
    }
  });

  it('accepts valid typed data signing payloads', async () => {
    const errors = await validateDto({
      type: 'typed_data',
      typedData: {
        domain: { name: 'App', version: '1', chainId: 84532 },
        types: {
          Mail: [
            { name: 'to', type: 'address' },
            { name: 'body', type: 'string' },
          ],
        },
        primaryType: 'Mail',
        message: { to: '0x1111111111111111111111111111111111111111', body: 'Hi' },
      },
    });

    expect(errors).toHaveLength(0);
  });

  it('requires typedData to be an object for typed data signing', async () => {
    const invalidValues = [undefined, '', 'not-an-object', []];

    for (const typedData of invalidValues) {
      const errors = await validateDto({ type: 'typed_data', typedData });

      expect(errors.some((error) => error.property === 'typedData')).toBe(true);
    }
  });

  it('accepts executionMode session_key and eoa only', async () => {
    for (const executionMode of ['session_key', 'eoa'] as const) {
      const errors = await validateDto({
        type: 'message',
        message: 'Hello',
        executionMode,
      });

      expect(errors).toHaveLength(0);
    }
  });

  it('rejects invalid executionMode values', async () => {
    const invalidValues = ['sessionKey', 'wallet', '', 'eoa '];

    for (const executionMode of invalidValues) {
      const errors = await validateDto({
        type: 'message',
        message: 'Hello',
        executionMode,
      });

      expect(errors.some((error) => error.property === 'executionMode')).toBe(true);
    }
  });

  it('requires chainId to be a positive integer', async () => {
    const invalidValues = [0, -1, 1.5, '84532'];

    for (const chainId of invalidValues) {
      const errors = await validateDto({
        type: 'message',
        message: 'Hello',
        chainId,
      });

      expect(errors.some((error) => error.property === 'chainId')).toBe(true);
    }
  });
});

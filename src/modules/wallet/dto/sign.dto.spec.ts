import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignDto } from './sign.dto';

describe('SignDto', () => {
  const validateDto = (input: Record<string, unknown>) => validate(plainToInstance(SignDto, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  it.each(['Hello, world', { raw: '0x48656c6c6f' }])('rejects message signing (%p)', async (message) => {
    const errors = await validateDto({ type: 'message', message });
    expect(errors.some((error) => error.property === 'type')).toBe(true);
    expect(errors.some((error) => error.property === 'message')).toBe(true);
  });

  it('rejects invalid signing types', async () => {
    const invalidTypes = ['message', 'hash', 'raw_hash', 'raw-hash', 'rawHash'];

    for (const type of invalidTypes) {
      const errors = await validateDto({ type, message: 'Hello' });

      expect(errors.some((error) => error.property === 'type')).toBe(true);
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

  it('accepts explicit EOA execution and omission of executionMode', async () => {
    for (const executionMode of ['eoa', undefined]) {
      const errors = await validateDto({
        type: 'typed_data',
        typedData: {},
        executionMode,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects invalid executionMode values', async () => {
    const invalidValues = ['session_key', 'sessionKey', 'wallet', '', 'eoa '];

    for (const executionMode of invalidValues) {
      const errors = await validateDto({
        type: 'typed_data',
        typedData: {},
        executionMode,
      });

      expect(errors.some((error) => error.property === 'executionMode')).toBe(true);
    }
  });

  it('requires chainId to be a positive integer', async () => {
    const invalidValues = [0, -1, 1.5, '84532'];

    for (const chainId of invalidValues) {
      const errors = await validateDto({
        type: 'typed_data',
        typedData: {},
        chainId,
      });

      expect(errors.some((error) => error.property === 'chainId')).toBe(true);
    }
  });
});

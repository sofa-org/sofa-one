import { validate } from 'class-validator';
import { UsdcQuoteDto } from './usdc-quote.dto';

describe('UsdcQuoteDto', () => {
  it('allows an omitted wallet selector', async () => {
    const dto = Object.assign(new UsdcQuoteDto(), { chainId: 84532 });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts a UUID wallet selector', async () => {
    const dto = Object.assign(new UsdcQuoteDto(), {
      walletId: '123e4567-e89b-12d3-a456-426614174000',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects malformed wallet selectors', async () => {
    const dto = Object.assign(new UsdcQuoteDto(), { walletId: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('walletId');
  });
});

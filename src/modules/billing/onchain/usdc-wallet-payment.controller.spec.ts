import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UsdcWalletPayDto } from './dto/usdc-wallet-pay.dto';


describe('UsdcWalletPayDto', () => {
  it('accepts only paymentAttemptId UUID', async () => {
    const ok = plainToInstance(UsdcWalletPayDto, {
      paymentAttemptId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    });
    expect(await validate(ok)).toHaveLength(0);
  });

  it('rejects missing paymentAttemptId', async () => {
    const bad = plainToInstance(UsdcWalletPayDto, {});
    const errors = await validate(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-uuid paymentAttemptId', async () => {
    const bad = plainToInstance(UsdcWalletPayDto, { paymentAttemptId: 'not-a-uuid' });
    const errors = await validate(bad);
    expect(errors.length).toBeGreaterThan(0);
  });
});

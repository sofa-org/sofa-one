import { validate } from 'class-validator';

jest.mock('./usdc-payment.service', () => ({
  UsdcPaymentService: class UsdcPaymentService {},
}));
jest.mock('../../../common/guards/app-session.guard', () => ({ AppSessionGuard: class AppSessionGuard {} }));
jest.mock('../../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

import { UsdcPaymentController } from './usdc-payment.controller';
import { UsdcQuoteDto } from './dto/usdc-quote.dto';
import { UsdcClaimDto } from './dto/usdc-claim.dto';
import { UsdcCancelDto } from './dto/usdc-cancel.dto';

describe('UsdcPaymentController', () => {
  const usdcPaymentService = {
    quote: jest.fn(),
    claim: jest.fn(),
    cancel: jest.fn(),
  };

  let controller: UsdcPaymentController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new UsdcPaymentController(usdcPaymentService as any);
  });

  it('delegates quote to the service with the user id, invoice id, and optional chain selector', async () => {
    usdcPaymentService.quote.mockResolvedValue({ paymentAttemptId: 'att-1' });

    const result = await controller.quote('user-1', 'inv-1', { chainId: 8453 } as any);

    expect(usdcPaymentService.quote).toHaveBeenCalledWith('user-1', 'inv-1', 8453, undefined);
    expect(result).toEqual({ paymentAttemptId: 'att-1' });
  });

  it('delegates quote without a chain selector (server default)', async () => {
    usdcPaymentService.quote.mockResolvedValue({ paymentAttemptId: 'att-1' });

    await controller.quote('user-1', 'inv-1', {} as any);

    expect(usdcPaymentService.quote).toHaveBeenCalledWith('user-1', 'inv-1', undefined, undefined);
  });

  it('delegates claim to the service with the minimal body', async () => {
    usdcPaymentService.claim.mockResolvedValue({ status: 'confirming' });

    const result = await controller.claim('user-1', 'inv-1', {
      paymentAttemptId: 'att-1',
      txHash: '0x' + 'a'.repeat(64),
    } as any);

    expect(usdcPaymentService.claim).toHaveBeenCalledWith('user-1', 'inv-1', {
      paymentAttemptId: 'att-1',
      txHash: '0x' + 'a'.repeat(64),
    });
    expect(result).toEqual({ status: 'confirming' });
  });

  it('delegates cancel to the service with paymentAttemptId only (BILL-003)', async () => {
    usdcPaymentService.cancel.mockResolvedValue({ status: 'cancelled' });

    const result = await controller.cancel('user-1', 'inv-1', {
      paymentAttemptId: 'att-1',
    } as any);

    expect(usdcPaymentService.cancel).toHaveBeenCalledWith('user-1', 'inv-1', 'att-1');
    expect(result).toEqual({ status: 'cancelled' });
  });

});

describe('USDC DTO validation (global whitelist + forbidNonWhitelisted contract)', () => {
  it('accepts an optional integer chainId on the quote body', async () => {
    const dto = new UsdcQuoteDto();
    dto.chainId = 8453;
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts an empty quote body (server-derived default chain)', async () => {
    expect(await validate(new UsdcQuoteDto())).toEqual([]);
  });

  it('rejects a non-integer chainId on the quote body', async () => {
    const dto = new UsdcQuoteDto();
    dto.chainId = '8453' as unknown as number;
    expect(await validate(dto)).not.toEqual([]);
  });

  it('accepts a valid claim body', async () => {
    const dto = new UsdcClaimDto();
    dto.paymentAttemptId = '3f8f1a2e-9b2d-4c5e-8a1f-1234567890ab';
    dto.txHash = '0x' + 'a'.repeat(64);
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects a malformed paymentAttemptId', async () => {
    const dto = new UsdcClaimDto();
    dto.paymentAttemptId = 'not-a-uuid';
    dto.txHash = '0x' + 'a'.repeat(64);
    expect(await validate(dto)).not.toEqual([]);
  });

  it('rejects a malformed txHash', async () => {
    const dto = new UsdcClaimDto();
    dto.paymentAttemptId = '3f8f1a2e-9b2d-4c5e-8a1f-1234567890ab';
    dto.txHash = '0x1234';
    expect(await validate(dto)).not.toEqual([]);
  });

  it('rejects a missing txHash', async () => {
    const dto = new UsdcClaimDto();
    dto.paymentAttemptId = '3f8f1a2e-9b2d-4c5e-8a1f-1234567890ab';
    expect(await validate(dto)).not.toEqual([]);
  });

  it('accepts a valid cancel body (paymentAttemptId only)', async () => {
    const dto = new UsdcCancelDto();
    dto.paymentAttemptId = '3f8f1a2e-9b2d-4c5e-8a1f-1234567890ab';
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects a malformed paymentAttemptId on cancel', async () => {
    const dto = new UsdcCancelDto();
    dto.paymentAttemptId = 'not-a-uuid';
    expect(await validate(dto)).not.toEqual([]);
  });

  it('rejects a missing paymentAttemptId on cancel', async () => {
    expect(await validate(new UsdcCancelDto())).not.toEqual([]);
  });
});

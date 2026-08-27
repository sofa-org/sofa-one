import { GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { validate } from 'class-validator';

jest.mock('./usdc-payment.service', () => ({
  UsdcPaymentService: class UsdcPaymentService {},
}));
jest.mock('../../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));
jest.mock('../../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

import { UsdcPaymentController } from './usdc-payment.controller';
import { OpenfortUserGuard } from '../../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../../common/guards/frontend-only.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../../common/decorators/frontend-only.decorator';
import { UsdcQuoteDto } from './dto/usdc-quote.dto';
import { UsdcClaimDto } from './dto/usdc-claim.dto';

describe('UsdcPaymentController', () => {
  const usdcPaymentService = {
    quote: jest.fn(),
    claim: jest.fn(),
  };

  let controller: UsdcPaymentController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new UsdcPaymentController(usdcPaymentService as any);
  });

  it('delegates quote to the service with the user id, invoice id, and optional chain selector', async () => {
    usdcPaymentService.quote.mockResolvedValue({ paymentAttemptId: 'att-1' });

    const result = await controller.quote('user-1', 'inv-1', { chainId: 8453 } as any);

    expect(usdcPaymentService.quote).toHaveBeenCalledWith('user-1', 'inv-1', 8453);
    expect(result).toEqual({ paymentAttemptId: 'att-1' });
  });

  it('delegates quote without a chain selector (server default)', async () => {
    usdcPaymentService.quote.mockResolvedValue({ paymentAttemptId: 'att-1' });

    await controller.quote('user-1', 'inv-1', {} as any);

    expect(usdcPaymentService.quote).toHaveBeenCalledWith('user-1', 'inv-1', undefined);
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

  it('protects both routes with OpenfortUserGuard and FrontendOnlyGuard', () => {
    const routes = [controller.quote, controller.claim];

    for (const route of routes) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, route) ?? [];
      expect(guards).toContain(OpenfortUserGuard);
      expect(guards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, route)).toBe(true);
    }
  });

  it('applies a tight route-level throttle to claim (RPC amplification bound) but not to quote', () => {
    // Claim performs RPC lookups (receipt + chain head) and must carry a tight
    // throttle; quote is a local DB operation and keeps the global defaults.
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'short', controller.claim)).toBe(5);
    expect(Reflect.getMetadata(THROTTLER_TTL + 'short', controller.claim)).toBe(60000);
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'medium', controller.claim)).toBe(20);
    expect(Reflect.getMetadata(THROTTLER_TTL + 'medium', controller.claim)).toBe(3600000);

    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'short', controller.quote)).toBeUndefined();
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'medium', controller.quote)).toBeUndefined();
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
});

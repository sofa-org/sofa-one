import { GUARDS_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

jest.mock('./usdc-wallet-payment.service', () => ({
  UsdcWalletPaymentService: class UsdcWalletPaymentService {},
}));
jest.mock('../../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));
jest.mock('../../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));
jest.mock('../../../common/guards/step-up.guard', () => ({
  StepUpGuard: class StepUpGuard {},
}));

import { UsdcWalletPaymentController } from './usdc-wallet-payment.controller';
import { OpenfortUserGuard } from '../../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../../common/decorators/frontend-only.decorator';
import { STEP_UP_KEY } from '../../../common/decorators/step-up.decorator';
import { UsdcWalletPayDto } from './dto/usdc-wallet-pay.dto';

describe('UsdcWalletPaymentController', () => {
  const walletPayment = {
    payFromWallet: jest.fn(),
    getPaymentStatus: jest.fn(),
  };

  let controller: UsdcWalletPaymentController;
  const reflector = new Reflector();

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new UsdcWalletPaymentController(walletPayment as never);
  });

  it('is mounted under v1/billing/invoices/:id/usdc', () => {
    const path = Reflect.getMetadata(PATH_METADATA, UsdcWalletPaymentController);
    expect(path).toBe('v1/billing/invoices/:id/usdc');
  });

  it('pay-from-wallet requires IAM + FrontendOnly + StepUp', () => {
    const pay = UsdcWalletPaymentController.prototype.payFromWallet;
    const guards = Reflect.getMetadata(GUARDS_METADATA, pay) as unknown[];
    expect(guards).toEqual(
      expect.arrayContaining([OpenfortUserGuard, FrontendOnlyGuard, StepUpGuard]),
    );
    expect(reflector.get(STEP_UP_KEY, pay)).toBe(true);
    expect(reflector.get(IS_FRONTEND_ONLY_KEY, pay)).toBe(true);
  });

  it('payment-status requires IAM + FrontendOnly but not StepUp', () => {
    const status = UsdcWalletPaymentController.prototype.paymentStatus;
    const guards = Reflect.getMetadata(GUARDS_METADATA, status) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([OpenfortUserGuard, FrontendOnlyGuard]));
    expect(guards).not.toContain(StepUpGuard);
    expect(reflector.get(STEP_UP_KEY, status)).toBeFalsy();
  });

  it('pay-from-wallet is POST; payment-status is GET', () => {
    expect(
      Reflect.getMetadata(METHOD_METADATA, UsdcWalletPaymentController.prototype.payFromWallet),
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(METHOD_METADATA, UsdcWalletPaymentController.prototype.paymentStatus),
    ).toBe(RequestMethod.GET);
  });

  it('delegates payFromWallet with only paymentAttemptId', async () => {
    walletPayment.payFromWallet.mockResolvedValue({ paid: false, accepted: true });
    await controller.payFromWallet('user-1', 'inv-1', { paymentAttemptId: 'att-1' });
    expect(walletPayment.payFromWallet).toHaveBeenCalledWith('user-1', 'inv-1', 'att-1');
  });
});

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

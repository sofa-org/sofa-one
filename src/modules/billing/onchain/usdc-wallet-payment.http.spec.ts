import 'reflect-metadata';
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { UsdcWalletPaymentController } from './usdc-wallet-payment.controller';
import { UsdcWalletPaymentService } from './usdc-wallet-payment.service';
import { AppSessionGuard } from '../../../common/guards/app-session.guard';
import { FrontendOnlyGuard } from '../../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
jest.mock('../../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));

class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = { id: 'payment-status-user' }; return true;
  }
}

describe('USDC wallet payment HTTP status', () => {
  let app: INestApplication;
  const pay = jest.fn().mockResolvedValue({ status: 'accepted' });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UsdcWalletPaymentController],
      providers: [{ provide: UsdcWalletPaymentService, useValue: { payFromWallet: pay, getPaymentStatus: jest.fn() } }],
    })
      .overrideGuard(AppSessionGuard).useClass(AuthGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .overrideGuard(StepUpGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());

  it('returns 202 for accepted asynchronous payment', async () => {
    const invoiceId = '00000000-0000-4000-8000-000000000001';
    const paymentAttemptId = '00000000-0000-4000-8000-000000000002';
    await request(app.getHttpServer())
      .post(`/v1/billing/invoices/${invoiceId}/usdc/pay-from-wallet`)
      .set('X-Step-Up-Token', 'proof')
      .send({ paymentAttemptId })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/billing/invoices/${invoiceId}/usdc/pay-from-wallet`)
      .set('X-Step-Up-Token', 'proof')
      .send({ paymentAttemptId })
      .expect(202)
      .expect({ status: 'accepted' });
  });
});

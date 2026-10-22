import 'reflect-metadata';
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
import { WalletController, DashboardWalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { ApiKeyPermissionGuard } from '../../common/guards/api-key-permission.guard';
import { AppSessionGuard } from '../../common/guards/app-session.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';

// Authentication is bypassed here to isolate request validation; real audience guards are tested separately.

class KeyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers['x-api-key']) return false;
    req.user = { id: 'api-user' }; req.apiKeyRecord = { id: 'key-id' }; return true;
  }
}
class ValidationUserGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = { id: 'validation-user' }; return true;
  }
}

describe('wallet HTTP request validation', () => {
  let app: INestApplication;
  const service = { getDepositInfo: jest.fn().mockResolvedValue({ walletAddress: '0xabc' }), sign: jest.fn(), withdraw: jest.fn().mockResolvedValue({ transactionId: 'tx' }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [WalletController, DashboardWalletController], providers: [{ provide: WalletService, useValue: service }] })
      .overrideGuard(ApiKeyAuthGuard).useClass(KeyGuard)
      .overrideGuard(ApiKeyPermissionGuard).useValue({ canActivate: () => true })
      .overrideGuard(AppSessionGuard).useClass(ValidationUserGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .overrideGuard(StepUpGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('validates the canonical GET query and removes the duplicate POST route', async () => {
    const walletId = '00000000-0000-4000-8000-000000000001';
    await request(app.getHttpServer()).get('/wallets/deposit-info?chainId=84532').expect(404);
    await request(app.getHttpServer()).get('/wallets/deposits?chainId=invalid').expect(400);
    await request(app.getHttpServer()).get('/wallets/deposits').expect(400);
    await request(app.getHttpServer()).get('/wallets/deposits?chainId=84532&extra=x').expect(400);
    expect(service.getDepositInfo).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get(`/wallets/deposits?chainId=84532&walletId=${walletId}`).expect(200);
    await request(app.getHttpServer()).post('/wallets/deposits').send({ chainId: 84532 }).expect(404);
  });


  it('rejects message and session-key signing before invoking the service', async () => {
    await request(app.getHttpServer()).post('/v1/wallets/sign').set('X-API-Key', 'key')
      .send({ type: 'message', message: 'Hello', chainId: 137 }).expect(400);
    await request(app.getHttpServer()).post('/v1/wallets/sign').set('X-API-Key', 'key')
      .send({ type: 'typed_data', executionMode: 'session_key', typedData: {} }).expect(400);
    expect(service.sign).not.toHaveBeenCalled();
  });

});

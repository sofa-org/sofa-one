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
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';

// These guards are route fixtures only; no IAM identity or API-key credential is verified here.

class KeyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers['x-api-key']) return false;
    req.user = { id: 'api-user' }; req.apiKeyRecord = { id: 'key-id' }; return true;
  }
}
class IamGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    req.user = { id: 'iam-user' }; return true;
  }
}
class StepUpRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers['x-step-up-token']) return false;
    req.stepUpVerified = true;
    return true;
  }
}

describe('wallet HTTP route auth and deposit query contract', () => {
  let app: INestApplication;
  const service = { getDepositInfo: jest.fn().mockResolvedValue({ walletAddress: '0xabc' }), sign: jest.fn(), withdraw: jest.fn().mockResolvedValue({ transactionId: 'tx' }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [WalletController, DashboardWalletController], providers: [{ provide: WalletService, useValue: service }] })
      .overrideGuard(ApiKeyAuthGuard).useClass(KeyGuard)
      .overrideGuard(ApiKeyPermissionGuard).useValue({ canActivate: () => true })
      .overrideGuard(OpenfortUserGuard).useClass(IamGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .overrideGuard(StepUpGuard).useClass(StepUpRouteGuard)
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
    await request(app.getHttpServer()).get('/wallets/deposits?chainId=invalid').set('Authorization', 'Bearer iam').expect(400);
    await request(app.getHttpServer()).get('/wallets/deposits').set('Authorization', 'Bearer iam').expect(400);
    await request(app.getHttpServer()).get('/wallets/deposits?chainId=84532&extra=x').set('Authorization', 'Bearer iam').expect(400);
    await request(app.getHttpServer()).get(`/wallets/deposits?chainId=84532&walletId=${walletId}`).set('X-API-Key', 'key').expect(403);
    expect(service.getDepositInfo).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get(`/wallets/deposits?chainId=84532&walletId=${walletId}`).set('Authorization', 'Bearer iam').expect(200);
    await request(app.getHttpServer()).post('/wallets/deposits').set('Authorization', 'Bearer iam').send({ chainId: 84532 }).expect(404);
    expect(service.getDepositInfo).toHaveBeenCalledTimes(1);
    expect(service.getDepositInfo).toHaveBeenNthCalledWith(1, 'iam-user', 84532, walletId);
  });

  it('wires signing through the API-key route only (signing policy is not exercised)', async () => {
    const clobAuth = {
      type: 'typed_data', executionMode: 'eoa', chainId: 137,
      typedData: {
        domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
        types: {
          EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
          ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }],
        },
        primaryType: 'ClobAuth',
        message: { address: '0x1111111111111111111111111111111111111111', timestamp: '1760000000', nonce: 0, message: 'This message attests that I control the given wallet' },
      },
    };
    await request(app.getHttpServer()).post('/v1/wallets/sign').set('Authorization', 'Bearer iam').send(clobAuth).expect(403);
    await request(app.getHttpServer()).post('/v1/wallets/sign').set('X-API-Key', 'key').send(clobAuth).expect(200);
    expect(service.sign).toHaveBeenCalledWith('api-user', expect.objectContaining({ type: 'typed_data' }), { id: 'key-id' });
  });

  it('registers step-up IAM withdrawal at the canonical path and removes /withdraw', async () => {
    const body = { chainId: 84532, to: '0x1111111111111111111111111111111111111111', amount: '1000000', token: 'USDC', idempotencyKey: 'stable-retry' };
    await request(app.getHttpServer()).post('/wallets/withdraw').set('Authorization', 'Bearer iam').set('X-Step-Up-Token', 'proof').send(body).expect(404);
    await request(app.getHttpServer()).post('/wallets/withdrawals').set('X-API-Key', 'key').send(body).expect(403);
    await request(app.getHttpServer()).post('/wallets/withdrawals').set('Authorization', 'Bearer iam').send(body).expect(403);
    await request(app.getHttpServer()).post('/wallets/withdrawals').set('Authorization', 'Bearer iam').set('X-Step-Up-Token', 'proof').send(body).expect(201);
  });
});

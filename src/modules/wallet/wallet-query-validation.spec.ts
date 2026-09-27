import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
jest.mock('./wallet.service', () => ({ WalletService: class WalletService {} }));
jest.mock('../../common/guards/openfort-user.guard', () => ({ OpenfortUserGuard: class OpenfortUserGuard {} }));
jest.mock('../../common/guards/frontend-only.guard', () => ({ FrontendOnlyGuard: class FrontendOnlyGuard {} }));
jest.mock('../../common/guards/step-up.guard', () => ({ StepUpGuard: class StepUpGuard {} }));
jest.mock('../../common/guards/api-key-auth.guard', () => ({ ApiKeyAuthGuard: class ApiKeyAuthGuard {} }));
jest.mock('../../common/guards/api-key-permission.guard', () => ({ ApiKeyPermissionGuard: class ApiKeyPermissionGuard {} }));
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';

describe('Wallet query HTTP validation', () => {
  let app: INestApplication;
  const walletService = {
    getBalances: jest.fn().mockResolvedValue({}),
    getDepositInfo: jest.fn().mockResolvedValue({}),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [{ provide: WalletService, useValue: walletService }],
    })
      .overrideGuard(OpenfortUserGuard).useValue({ canActivate: () => true })
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => { req.user = { id: 'user-1' }; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => app?.close());

  it('rejects malformed wallet UUIDs', async () => {
    await request(app.getHttpServer()).get('/v1/wallets/balances?chainId=84532&walletId=bad').expect(400);
  });

  it('rejects missing or invalid chainId', async () => {
    await request(app.getHttpServer()).get('/v1/wallets/balances').expect(400);
    await request(app.getHttpServer()).get('/v1/wallets/balances?chainId=not-a-number').expect(400);
    await request(app.getHttpServer()).post('/v1/wallets/deposit-info').send({}).expect(400);
    await request(app.getHttpServer()).post('/v1/wallets/deposit-info').send({ chainId: 'not-a-number' }).expect(400);
  });

  it('rejects unknown query fields and forwards a valid selected wallet UUID', async () => {
    await request(app.getHttpServer()).get('/v1/wallets/balances?chainId=84532&unexpected=x').expect(400);
    const walletId = '123e4567-e89b-42d3-a456-426614174000';
    await request(app.getHttpServer()).get(`/v1/wallets/balances?chainId=84532&walletId=${walletId}`).expect(200);
    expect(walletService.getBalances).toHaveBeenCalledWith('user-1', 84532, walletId);
  });
});

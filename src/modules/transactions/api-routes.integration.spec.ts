import 'reflect-metadata';
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
import { TransactionsController, DashboardTransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { ApiKeyPermissionGuard } from '../../common/guards/api-key-permission.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';

// Authentication guards are deliberately mocked: this proves Nest route registration and
// audience separation only, not Openfort identity verification or API-key cryptography.

class ApiKeyRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers['x-api-key']) return false;
    req.user = { id: 'api-user' };
    req.apiKeyRecord = { id: 'key-id' };
    return true;
  }
}
class DashboardRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    req.user = { id: 'dashboard-user' };
    return true;
  }
}

describe('transaction HTTP route separation and compatibility', () => {
  let app: INestApplication;
  const service = { send: jest.fn().mockResolvedValue({ transactionId: 'tx', status: 'pending' }),
    getStatus: jest.fn().mockResolvedValue({ status: 'pending' }), list: jest.fn(), getDashboardDetail: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TransactionsController, DashboardTransactionsController],
      providers: [{ provide: TransactionsService, useValue: service }],
    })
      .overrideGuard(ApiKeyAuthGuard).useClass(ApiKeyRouteGuard)
      .overrideGuard(ApiKeyPermissionGuard).useValue({ canActivate: () => true })
      .overrideGuard(OpenfortUserGuard).useClass(DashboardRouteGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  const payload = { chainId: 84532, idempotencyKey: 'retry-key', interactions: [{ to: '0x1111111111111111111111111111111111111111', data: '0x' }] };

  it('registers API-key send at the canonical path, rejects IAM-only auth, and removes /send', async () => {
    await request(app.getHttpServer()).post('/v1/transactions/send').set('X-API-Key', 'test').send(payload).expect(404);
    await request(app.getHttpServer()).post('/v1/transactions').set('Authorization', 'Bearer iam').send(payload).expect(403);
    await request(app.getHttpServer()).post('/v1/transactions').set('X-API-Key', 'test').send(payload).expect(201);
    expect(service.send).toHaveBeenCalledWith('api-user', expect.objectContaining({ chainId: 84532 }), { id: 'key-id' });
  });

  it('keeps dashboard list/detail unversioned, API-key-only status versioned, and denies old dashboard paths', async () => {
    const transactionId = '00000000-0000-4000-8000-000000000001';
    await request(app.getHttpServer()).get('/v1/transactions').set('Authorization', 'Bearer iam').expect(404);
    await request(app.getHttpServer()).get('/transactions').set('X-API-Key', 'test').expect(403);
    await request(app.getHttpServer()).get('/transactions').set('Authorization', 'Bearer iam').expect(200);
    await request(app.getHttpServer()).get(`/v1/transactions/${transactionId}`).set('Authorization', 'Bearer iam').expect(403);
    await request(app.getHttpServer()).get(`/v1/transactions/${transactionId}`).set('X-API-Key', 'test').expect(200);
    expect(service.getStatus).toHaveBeenCalledWith('api-user', transactionId, { id: 'key-id' });
    await request(app.getHttpServer()).get(`/v1/transactions/${transactionId}/detail`).expect(404);
    await request(app.getHttpServer()).get(`/transactions/${transactionId}/detail`).set('X-API-Key', 'test').expect(403);
    await request(app.getHttpServer()).get(`/transactions/${transactionId}/detail`).set('Authorization', 'Bearer iam').expect(200);
    expect(service.getDashboardDetail).toHaveBeenCalledWith('dashboard-user', transactionId);
  });
});

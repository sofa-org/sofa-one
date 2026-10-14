import 'reflect-metadata';
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';

// These guards prove route wiring only; they do not validate provider identity or credentials.

class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    req.user = { id: 'user-id' }; return true;
  }
}
class StepUpRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return Boolean(context.switchToHttp().getRequest().headers['x-step-up-token']);
  }
}

describe('API-key rotation HTTP route', () => {
  let app: INestApplication;
  const rotateApiKey = jest.fn().mockResolvedValue({ rawKey: 'sk_once' });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ApiKeyController], providers: [{ provide: ApiKeyService, useValue: { rotateApiKey } }] })
      .overrideGuard(OpenfortUserGuard).useClass(AuthGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .overrideGuard(StepUpGuard).useClass(StepUpRouteGuard)
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('validates walletId and returns the same safe shape as legacy refresh', async () => {
    const walletId = '00000000-0000-4000-8000-000000000001';
    await request(app.getHttpServer()).post('/v1/api-keys/rotations').expect(404);
    await request(app.getHttpServer()).post('/api-keys/rotations').set('X-API-Key', 'key').set('X-Step-Up-Token', 'proof').send({ walletId }).expect(403);
    await request(app.getHttpServer()).post('/api-keys/rotations').set('Authorization', 'Bearer iam').set('X-Step-Up-Token', 'proof').send({ walletId: 'bad' }).expect(400);
    await request(app.getHttpServer()).post('/api-keys/rotations').set('Authorization', 'Bearer iam').send({ walletId }).expect(403);
    await request(app.getHttpServer()).post('/api-keys/rotations').set('Authorization', 'Bearer iam').set('X-Step-Up-Token', 'proof').send({ walletId }).expect(201).expect({ apiKey: 'sk_once' });
    expect(rotateApiKey).toHaveBeenCalledWith('user-id', 'Refreshed', walletId);
  });
});

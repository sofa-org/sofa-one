import 'reflect-metadata';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OpenfortAuthGuard } from '../../common/guards/openfort-auth.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
// This mocked guard verifies route registration only, not Openfort identity or provider proof.

class IamGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    req.openfortUserId = 'provider-user'; req.openfortEmail = 'user@example.test'; return true;
  }
}

describe('unversioned auth routes', () => {
  let app: INestApplication;
  const syncOpenfortSession = jest.fn().mockResolvedValue({ userId: 'user-id' });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AuthController], providers: [{ provide: AuthService, useValue: { syncOpenfortSession } }] })
      .overrideGuard(OpenfortAuthGuard).useClass(IamGuard)
      .overrideGuard(OpenfortUserGuard).useValue({ canActivate: () => true })
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .overrideGuard(StepUpGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication(); await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('registers canonical IAM session sync at /auth/session and removes the added versioned alias', async () => {
    await request(app.getHttpServer()).post('/v1/auth/session').expect(404);
    await request(app.getHttpServer()).post('/auth/social').set('Authorization', 'Bearer iam').expect(404);
    await request(app.getHttpServer()).post('/auth/refresh-api-key').set('Authorization', 'Bearer iam').expect(404);
    const path = '/auth/session';
    await request(app.getHttpServer()).post(path).expect(403);
    await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer iam').expect(201).expect({ userId: 'user-id' });
    expect(syncOpenfortSession).toHaveBeenCalledWith('provider-user', 'user@example.test', '::ffff:127.0.0.1', undefined);
  });
});

import 'reflect-metadata';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { SecurityNotificationController } from './security-notification.controller';
import { SecurityNotificationService } from './security-notification.service';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));

// Mock guard tests verify route registration/audience plumbing, not IAM identity proof.
class MockIamGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    req.user = { id: 'mock-user' };
    return true;
  }
}

describe('security notification dashboard routes', () => {
  let app: INestApplication;
  const listForUser = jest.fn().mockResolvedValue([]);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SecurityNotificationController],
      providers: [{ provide: SecurityNotificationService, useValue: { listForUser } }],
    })
      .overrideGuard(OpenfortUserGuard).useClass(MockIamGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('serves unversioned IAM route and removes versioned dashboard route', async () => {
    await request(app.getHttpServer()).get('/v1/security-notifications').expect(404);
    await request(app.getHttpServer()).get('/security-notifications').set('X-API-Key', 'ignored').expect(403);
    await request(app.getHttpServer())
      .get('/security-notifications')
      .set('Authorization', 'Bearer mock-token')
      .expect(200)
      .expect([]);
    expect(listForUser).toHaveBeenCalledWith('mock-user', { unreadOnly: false, limit: undefined });
  });
});

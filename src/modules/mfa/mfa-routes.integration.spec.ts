import 'reflect-metadata';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));

// Route guards are mocked to test registration/compatibility only, not IAM identity verification.
class MockIamGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers.authorization?.startsWith('Bearer ')) return false;
    req.user = { id: 'mock-user' };
    return true;
  }
}

describe('MFA route compatibility', () => {
  let app: INestApplication;
  const getStatus = jest.fn().mockResolvedValue({ enabled: false, recoveryCodesRemaining: 0 });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [{ provide: MfaService, useValue: { getStatus } }],
    })
      .overrideGuard(OpenfortUserGuard).useClass(MockIamGuard)
      .overrideGuard(FrontendOnlyGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('serves unversioned MFA and removes the old versioned path', async () => {
    await request(app.getHttpServer()).get('/v1/auth/mfa/status').expect(404);
    await request(app.getHttpServer()).get('/auth/mfa/status').expect(403);
    await request(app.getHttpServer())
      .get('/auth/mfa/status')
      .set('Authorization', 'Bearer mock-token')
      .expect(200)
      .expect({ enabled: false, recoveryCodesRemaining: 0 });
    expect(getStatus).toHaveBeenCalledWith('mock-user');
  });
});

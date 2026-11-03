import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService, AuthenticatedAppSession } from '../app-session/app-session.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';

describe('pending-MFA HTTP boundaries', () => {
  let app: INestApplication;
  const token = 'a'.repeat(64);
  const origin = 'https://app.example.test';
  const now = new Date();
  const session: AuthenticatedAppSession = {
    id: 'session-1', userId: 'user-1', tokenHash: 'hash', mfaVerified: false,
    mfaPendingUntil: new Date(now.getTime() + 15 * 60_000), expiresAt: new Date(now.getTime() + 60 * 60_000), revokedAt: null, createdAt: now,
    user: { id: 'user-1', socialId: 'provider-1', socialProvider: 'openfort', email: 'user@example.test', frozenAt: null, frozenReason: null, createdAt: now },
  };
  const mfa = {
    getStatus: jest.fn().mockResolvedValue({ enabled: false, recoveryCodesRemaining: 0 }),
    setupTotp: jest.fn().mockResolvedValue({ secret: 'factor-secret', otpauthUrl: 'otpauth://totp/test' }),
    enableTotp: jest.fn().mockResolvedValue({ recoveryCodes: ['ABCD-EFGH-JKLM'] }),
    verifyTotp: jest.fn().mockResolvedValue({ proofToken: 'proof', expiresAt: new Date() }),
    disableTotp: jest.fn(),
  };
  let sessions: AppSessionService;

  beforeAll(async () => {
    const config = new ConfigService({ NODE_ENV: 'production', CORS_ORIGIN: origin });
    // Real guards and cookie/CSRF validation are backed by a local session lookup double.
    const prisma = { appSession: { findUnique: jest.fn().mockResolvedValue(session) } } as unknown as PrismaService;
    sessions = new AppSessionService(prisma, config);
    const module = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [FrontendOnlyGuard, { provide: MfaService, useValue: mfa }, { provide: AppSessionService, useValue: sessions }, { provide: ConfigService, useValue: config }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => { jest.clearAllMocks(); session.mfaVerified = false; });

  it('allows pending status introspection through a trusted production Referer without IAM', async () => {
    await request(app.getHttpServer()).get('/auth/mfa/status')
      .set('Referer', `${origin}/dashboard`).set('Cookie', `__Host-sofa_session=${token}`)
      .expect(200).expect('Cache-Control', 'no-store').expect({ enabled: false, recoveryCodesRemaining: 0 });
    expect(mfa.getStatus).toHaveBeenCalledWith('user-1');
  });

  it.each(['setup', 'enable', 'verify'])('allows pending %s only with cookie + CSRF + trusted Origin', async (action) => {
    const path = `/auth/mfa/totp/${action}`;
    await request(app.getHttpServer()).post(path).set('Origin', origin).set('Cookie', `__Host-sofa_session=${token}`).send({ code: '123456' }).expect(403);
    await request(app.getHttpServer()).post(path).set('Origin', origin).set('Cookie', `__Host-sofa_session=${token}`)
      .set('X-CSRF-Token', sessions.csrfToken(token)).send(action === 'setup' ? {} : { code: '123456' })
      .expect(201).expect('Cache-Control', 'no-store');
    if (action === 'setup') expect(mfa.setupTotp).toHaveBeenCalledWith('user-1', 'session-1', session.user.email);
    if (action === 'enable') expect(mfa.enableTotp).toHaveBeenCalledWith('user-1', 'session-1', '123456');
    if (action === 'verify') expect(mfa.verifyTotp).toHaveBeenCalledWith('user-1', 'session-1', '123456');
  });

  it('never allows pending factor disable and clears the cookie after a full-session disable', async () => {
    const disable = () => request(app.getHttpServer()).post('/auth/mfa/totp/disable').set('Origin', origin)
      .set('Cookie', `__Host-sofa_session=${token}`).set('X-CSRF-Token', sessions.csrfToken(token)).send({ code: '123456' });
    await disable().expect(403);
    expect(mfa.disableTotp).not.toHaveBeenCalled();
    session.mfaVerified = true;
    const response = await disable().expect(201).expect('Cache-Control', 'no-store');
    expect(mfa.disableTotp).toHaveBeenCalledWith('user-1', 'session-1', '123456');
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('__Host-sofa_session=;')]));
  });
});

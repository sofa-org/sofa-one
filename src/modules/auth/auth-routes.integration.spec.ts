import 'reflect-metadata';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));
import { OpenfortService } from '../../core/openfort/openfort.service';
import { PrismaService } from '../../core/database/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppSessionService, AppSessionSnapshot, AuthenticatedAppSession } from '../app-session/app-session.service';
import { StepUpService } from '../step-up/step-up.service';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';

describe('application session HTTP boundaries', () => {
  let app: INestApplication;
  let sessions: AppSessionService;
  const rows = new Map<string, AuthenticatedAppSession>();
  const user = { id: 'user-1', socialProvider: 'openfort', socialId: 'provider-1', email: 'user@example.test', frozenAt: null, frozenReason: null, createdAt: new Date() };
  const verifyIamSession = jest.fn();
  const auth = { syncOpenfortSession: jest.fn().mockResolvedValue({ userId: user.id }), getMe: jest.fn().mockResolvedValue({ userId: user.id, wallet: { id: 'stable-wallet' } }), authorizeEmbeddedWallet: jest.fn() };
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: { findUnique: jest.fn(async () => user) },
    appSession: {
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null),
      create: jest.fn(async ({ data }: { data: Omit<AuthenticatedAppSession, 'id' | 'user' | 'revokedAt'> }) => {
        const row = { ...data, id: randomUUID(), user, revokedAt: null };
        rows.set(row.tokenHash, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id?: string; userId?: string }; data: { revokedAt: Date } }) => {
        let count = 0;
        for (const row of rows.values()) {
          if ((!where.id || where.id === row.id) && (!where.userId || where.userId === row.userId)) { row.revokedAt = data.revokedAt; count += 1; }
        }
        return { count };
      }),
    },
    stepUpChallenge: { deleteMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => callback(db as unknown as Prisma.TransactionClient)),
  };

  beforeAll(async () => {
    const config = new ConfigService({ NODE_ENV: 'development', CORS_ORIGIN: 'https://app.example.test' });
    // The persistence double backs real cookie, CSRF, session, origin and IAM guards.
    const prisma = db as unknown as PrismaService;
    sessions = new AppSessionService(prisma, config);
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        FrontendOnlyGuard,
        { provide: AuthService, useValue: auth }, { provide: AppSessionService, useValue: sessions },
        { provide: StepUpService, useValue: new StepUpService(prisma, sessions) },
        { provide: ConfigService, useValue: config }, { provide: OpenfortService, useValue: { verifyIamSession } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    rows.clear();
    jest.clearAllMocks();
    verifyIamSession.mockResolvedValue({ openfortUserId: user.socialId, email: user.email, session: {} });
  });

  async function login() {
    const response = await request(app.getHttpServer()).post('/auth/session')
      .set('Origin', 'https://app.example.test').set('Authorization', 'Bearer provider-token').expect(201);
    const cookies: unknown = response.headers['set-cookie'];
    if (!Array.isArray(cookies) || typeof cookies[0] !== 'string') throw new Error('session cookie missing');
    return { cookie: cookies[0].split(';')[0], snapshot: response.body as AppSessionSnapshot };
  }

  it('exchanges IAM for an HttpOnly cookie and a pending app snapshot, never a bearer session or wallet bootstrap', async () => {
    const { cookie, snapshot } = await login();
    expect(cookie).toMatch(/^sofa_session=[a-f0-9]{64}$/);
    expect(snapshot).toMatchObject({ userId: user.id, mfaVerified: false, email: user.email });
    expect(snapshot).not.toHaveProperty('token');
    expect(snapshot).not.toHaveProperty('wallet');
    expect(auth.getMe).not.toHaveBeenCalled();
    expect(verifyIamSession).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get('/auth/session').set('Origin', 'https://app.example.test').set('Cookie', cookie)
      .expect(200).expect('Cache-Control', 'no-store').expect(snapshot);
    expect(verifyIamSession).toHaveBeenCalledTimes(1);
  });

  it('rejects bearer fallback and pending access to real wallet projection', async () => {
    await request(app.getHttpServer()).get('/auth/me').set('Origin', 'https://app.example.test').set('Authorization', 'Bearer provider-token').expect(401);
    const { cookie } = await login();
    await request(app.getHttpServer()).get('/auth/me').set('Origin', 'https://app.example.test').set('Cookie', cookie).expect(403);
    expect(auth.getMe).not.toHaveBeenCalled();
  });

  it('logs out pending sessions only with trusted Origin and CSRF, then rejects the old cookie', async () => {
    const { cookie, snapshot } = await login();
    await request(app.getHttpServer()).delete('/auth/session').set('Origin', 'https://app.example.test').set('Cookie', cookie).expect(403);
    await request(app.getHttpServer()).delete('/auth/session').set('Cookie', cookie).set('X-CSRF-Token', snapshot.csrfToken).expect(403);
    await request(app.getHttpServer()).delete('/auth/session').set('Origin', 'https://app.example.test').set('Cookie', cookie).set('X-CSRF-Token', snapshot.csrfToken)
      .expect(204).expect('Cache-Control', 'no-store');
    await request(app.getHttpServer()).get('/auth/session').set('Origin', 'https://app.example.test').set('Cookie', cookie).expect(401);
  });

  it('rejects provider/local subject mismatch before touching wallet identity', async () => {
    const { cookie, snapshot } = await login();
    for (const row of rows.values()) row.mfaVerified = true;
    verifyIamSession.mockResolvedValue({ openfortUserId: 'another-provider-user', session: {} });
    await request(app.getHttpServer()).post('/auth/embedded-wallet/authorize')
      .set('Origin', 'https://app.example.test').set('Cookie', cookie).set('X-CSRF-Token', snapshot.csrfToken)
      .set('Authorization', 'Bearer fresh-provider-token').send({ embeddedWalletAddress: `0x${'1'.repeat(40)}` }).expect(403);
    expect(auth.authorizeEmbeddedWallet).not.toHaveBeenCalled();
  });

  it('rejects invalid IAM without creating a local session', async () => {
    verifyIamSession.mockRejectedValue(new UnauthorizedException('Invalid provider token'));
    await request(app.getHttpServer()).post('/auth/session').set('Origin', 'https://app.example.test').set('Authorization', 'Bearer invalid').expect(401);
    expect(rows.size).toBe(0);
  });
});

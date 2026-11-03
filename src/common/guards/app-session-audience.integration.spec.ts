import 'reflect-metadata';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import * as request from 'supertest';
import { PrismaService } from '../../core/database/prisma.service';
import { AppSessionService, type AuthenticatedAppSession } from '../../modules/app-session/app-session.service';
import { ApiKeyController } from '../../modules/api-key/api-key.controller';
import { ApiKeyService } from '../../modules/api-key/api-key.service';
import { StepUpService } from '../../modules/step-up/step-up.service';
import { TransactionsController, DashboardTransactionsController } from '../../modules/transactions/transactions.controller';
import { TransactionsService } from '../../modules/transactions/transactions.service';
import { WalletController, ApiKeyWalletController, DashboardWalletController } from '../../modules/wallet/wallet.controller';
import { WalletService } from '../../modules/wallet/wallet.service';
import { SecurityEventService } from '../../modules/security-events/security-event.service';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { FrontendOnlyGuard } from './frontend-only.guard';
import { IpAllowlistService } from './ip-allowlist.service';

jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));

const token = 'ab'.repeat(32);
const cookie = `sofa_session=${token}`;
const origin = 'https://app.example.test';
const csrf = createHash('sha256').update(`csrf:${token}`).digest('hex');
const transactionId = '00000000-0000-4000-8000-000000000001';

function fullSession(): AuthenticatedAppSession {
  const now = new Date();
  return {
    id: '00000000-0000-4000-8000-000000000002',
    userId: '00000000-0000-4000-8000-000000000003',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    mfaVerified: true,
    mfaPendingUntil: new Date(now.getTime() + 900_000),
    expiresAt: new Date(now.getTime() + 3_600_000),
    revokedAt: null,
    createdAt: now,
    user: {
      id: '00000000-0000-4000-8000-000000000003',
      socialProvider: 'openfort_email_otp', socialId: 'provider-user',
      email: 'user@example.test', frozenAt: null, frozenReason: null, createdAt: now,
    },
  };
}

describe('dashboard/application-cookie and public/API-key HTTP boundaries', () => {
  let app: INestApplication;
  let session = fullSession();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ApiKeyController, WalletController, ApiKeyWalletController, DashboardWalletController,
        TransactionsController, DashboardTransactionsController],
      providers: [
        AppSessionService, FrontendOnlyGuard,
        { provide: ConfigService, useValue: new ConfigService({ NODE_ENV: 'test', CORS_ORIGIN: origin }) },
        { provide: PrismaService, useValue: { appSession: {
          findUnique: async ({ where }: { where: { tokenHash: string } }) =>
            where.tokenHash === session.tokenHash ? session : null,
        } } },
        { provide: ApiKeyService, useValue: { listApiKeys: async () => [] } },
        { provide: WalletService, useValue: {} },
        { provide: TransactionsService, useValue: {} },
        { provide: StepUpService, useValue: { validateProof: async () => false } },
        { provide: SecurityEventService, useValue: {} },
        { provide: IpAllowlistService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => { session = fullSession(); });

  it.each([
    ['post', '/v1/wallets/sign'],
    ['post', '/v1/transactions'],
    ['get', `/v1/transactions/${transactionId}`],
    ['get', '/v1/wallets'],
  ] as const)('rejects cookie and IAM substitutes on public %s %s', async (method, path) => {
    for (const header of [{ Cookie: cookie }, { Authorization: 'Bearer provider-token' }]) {
      const response = await request(app.getHttpServer())[method](path).set(header).expect(401);
      expect(response.body.message).toBe('Missing API key');
    }
  });

  it.each(['/api-keys', '/transactions', '/wallets/deposits?chainId=84532'])(
    'blocks business reads before server-side MFA: %s', async (path) => {
      session.mfaVerified = false;
      await request(app.getHttpServer()).get(path).set('Cookie', cookie).set('Origin', origin)
        .expect(403).expect((response) => { expect(response.body.code).toBe('MFA_REQUIRED'); });
    },
  );

  it('requires the live cookie rather than an IAM token or API key and respects later revocation', async () => {
    await request(app.getHttpServer()).get('/api-keys').set('Origin', origin)
      .set('Authorization', 'Bearer provider-token').set('X-API-Key', 'sk_example').expect(401);
    await request(app.getHttpServer()).get('/api-keys').set('Origin', origin).set('Cookie', cookie).expect(200).expect([]);
    session.revokedAt = new Date();
    await request(app.getHttpServer()).get('/api-keys').set('Origin', origin).set('Cookie', cookie).expect(401);
  });

  it('requires both trusted Origin and CSRF before a sensitive operation can reach step-up', async () => {
    const mutation = () => request(app.getHttpServer()).post('/api-keys').set('Cookie', cookie);
    const missing = await mutation().set('Origin', origin).expect(403);
    expect(missing.body.message).toBe('Invalid CSRF token');
    await mutation().set('Origin', 'https://evil.example.test').set('X-CSRF-Token', csrf).expect(403);
    const protectedResponse = await mutation().set('Origin', origin).set('X-CSRF-Token', csrf).expect(403);
    expect(protectedResponse.body.message).toContain('Step-up verification required');
  });
});

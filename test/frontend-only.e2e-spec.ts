import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { OpenfortUserGuard } from '../src/common/guards/openfort-user.guard';

process.env.NODE_ENV = 'test';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agent_wallet';
process.env.REDIS_URL = '';

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => ({})),
}));

describe('Frontend-only access control (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let testUserId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getStorageToken())
      .useValue({
        increment: jest.fn().mockResolvedValue({
          totalHits: 0,
          timeToExpire: 0,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      })
      .overrideGuard(OpenfortUserGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: testUserId };
          req.openfortUserId = 'frontend_only_openfort_id_e2e';
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await cleanDatabase();
    const user = await prisma.user.create({
      data: {
        socialProvider: 'openfort_email_otp',
        socialId: 'frontend_only_openfort_id_e2e',
        email: 'frontend-only@example.com',
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  it('rejects frontend-only routes when Origin/Referer is absent', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/api-keys')
      .set('Authorization', 'Bearer fake-openfort-token')
      .expect(403);

    expect(res.body).toEqual(
      expect.objectContaining({
        statusCode: 403,
        code: 'BAD_REQUEST',
        requestId: expect.any(String),
        path: '/v1/api-keys',
      }),
    );
  });

  it('allows frontend-only routes from the configured development frontend origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/api-keys')
      .set('Authorization', 'Bearer fake-openfort-token')
      .set('Origin', 'http://localhost:3000')
      .expect(200);

    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(res.body).toEqual([]);
  });

  async function cleanDatabase() {
    await prisma.signingRequest.deleteMany();
    // RESTRICT: payment attempts reference transactions — delete attempts first.
    await prisma.billingPaymentAttempt.deleteMany().catch(() => undefined);
    await prisma.transaction.deleteMany();
    await prisma.apiKeyEvent.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.billingInvoiceLine.deleteMany();
    await prisma.billingUsageEvent.deleteMany();
    await prisma.billingInvoice.deleteMany();
    await prisma.billingPlanAssignment.deleteMany();
    await prisma.billingAccount.deleteMany();
    await prisma.user.deleteMany();
  }
});

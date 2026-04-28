import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { ClerkUserGuard } from '../src/common/guards/clerk-user.guard';

process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_fake_clerk_key_for_testing';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agent_wallet';

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
      .overrideProvider(APP_GUARD)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ClerkUserGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: testUserId };
          req.clerkUserId = 'frontend_only_social_id_e2e';
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
        socialProvider: 'google',
        socialId: 'frontend_only_social_id_e2e',
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
      .set('Authorization', 'Bearer fake-clerk-token')
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
      .set('Authorization', 'Bearer fake-clerk-token')
      .set('Origin', 'http://localhost:3000')
      .expect(200);

    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(res.body).toEqual([]);
  });

  async function cleanDatabase() {
    await prisma.signingRequest.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.apiKeyEvent.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.user.deleteMany();
  }
});

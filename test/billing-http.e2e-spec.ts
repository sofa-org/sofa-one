/**
 * E2E: dashboard billing HTTP surface (guard/origin, plans, summary,
 * plan assignment, invoice ownership/validation).
 *
 * Real: AppModule + PostgreSQL.
 * Mocked: Openfort IAM session verification, Stripe client (never confirms payment).
 * Does not fake successful payment or expose secrets.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import * as request from 'supertest';
import { PrismaService } from '../src/core/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { STRIPE_CLIENT } from '../src/modules/billing/stripe/stripe.constants';

process.env.NODE_ENV = 'test';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agent_wallet';
process.env.REDIS_URL = '';
process.env.BILLING_WORKER_ENABLED = 'false';
// Stripe success/cancel URLs so checkout eligibility is reachable with a mocked
// client; payment is never confirmed here (webhook path is out of scope).
process.env.STRIPE_SUCCESS_URL = 'https://example.test/billing/success';
process.env.STRIPE_CANCEL_URL = 'https://example.test/billing/cancel';
// Leave STRIPE_SECRET_KEY unset so the real provider stays null; we override
// STRIPE_CLIENT below with a non-null mock that refuses to complete payment.

const FRONTEND_ORIGIN = 'http://localhost:3000';
const SUITE_ID = randomUUID().replace(/-/g, '').slice(0, 12);

type TestUser = {
  token: string;
  socialId: string;
  email: string;
  userId: string;
};

/** Token → IAM session mapping for the Openfort mock. */
const iamSessions = new Map<string, { openfortUserId: string; email: string }>();

const mockOpenfortService = {
  verifyIamSession: jest.fn(async (accessToken: string) => {
    const session = iamSessions.get(accessToken);
    if (!session) {
      throw new Error('invalid openfort token');
    }
    return {
      openfortUserId: session.openfortUserId,
      email: session.email,
      session: { id: `sess_${session.openfortUserId}` },
    };
  }),
  createBackendWallet: jest.fn(),
  createAgentWallet: jest.fn(),
  getTransactionReceipt: jest.fn(),
  signData: jest.fn(),
  sendUserOperation: jest.fn(),
  sendBackendTransaction: jest.fn(),
};

/** Stripe mock: never succeeds at creating a payable session for this suite. */
const mockStripe = {
  customers: {
    create: jest.fn().mockRejectedValue(new Error('stripe customer create blocked in e2e')),
  },
  checkout: {
    sessions: {
      create: jest.fn().mockRejectedValue(new Error('stripe checkout create blocked in e2e')),
      retrieve: jest.fn().mockRejectedValue(new Error('stripe checkout retrieve blocked in e2e')),
    },
  },
  paymentIntents: {
    create: jest.fn().mockRejectedValue(new Error('stripe PI create blocked in e2e')),
    retrieve: jest.fn().mockRejectedValue(new Error('stripe PI retrieve blocked in e2e')),
  },
  webhooks: {
    constructEventAsync: jest.fn().mockRejectedValue(new Error('stripe webhook blocked in e2e')),
  },
};

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => mockOpenfortService),
}));

import { AppModule } from '../src/app.module';

describe('Billing HTTP dashboard flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let primary: TestUser;
  let other: TestUser;

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
      .overrideProvider(STRIPE_CLIENT)
      .useValue(mockStripe)
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
    jest.clearAllMocks();
    iamSessions.clear();
    await cleanDatabase();

    primary = await seedUser('primary');
    other = await seedUser('other');
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  // ── Guard / origin / IAM ──────────────────────────────────────────────────

  describe('guard and origin', () => {
    it('rejects billing routes without Origin/Referer', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/billing/plans')
        .set('Authorization', `Bearer ${primary.token}`)
        .expect(403);

      expectApiError(res.body, 403, 'BAD_REQUEST', '/v1/billing/plans');
      expect(res.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('rejects billing routes without a bearer token', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/billing/plans')
        .set('Origin', FRONTEND_ORIGIN)
        .expect(401);

      expectApiError(res.body, 401, 'UNAUTHORIZED', '/v1/billing/plans');
    });

    it('rejects billing routes with an invalid IAM token', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/billing/plans')
        .set('Authorization', 'Bearer not-a-real-token')
        .set('Origin', FRONTEND_ORIGIN)
        .expect(401);

      expectApiError(res.body, 401, 'UNAUTHORIZED', '/v1/billing/plans');
      expect(mockOpenfortService.verifyIamSession).toHaveBeenCalledWith('not-a-real-token');
    });

    it('rejects a disallowed Origin even with a valid token', async () => {
      await request(app.getHttpServer())
        .get('/v1/billing/plans')
        .set('Authorization', `Bearer ${primary.token}`)
        .set('Origin', 'https://evil.example')
        .expect(403);
    });

    it('does not accept an API key for dashboard billing routes', async () => {
      await request(app.getHttpServer())
        .get('/v1/billing/plans')
        .set('X-API-Key', 'sk_00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        .set('Origin', FRONTEND_ORIGIN)
        .expect(401);
    });

    it('allows billing routes from the development frontend origin with IAM', async () => {
      const res = await dashboardGet(primary, '/v1/billing/plans').expect(200);

      expect(res.headers['x-request-id']).toEqual(expect.any(String));
      expect(res.body).toEqual(
        expect.objectContaining({
          currentPlanId: 'free',
          plans: expect.any(Array),
        }),
      );
      expect(mockOpenfortService.verifyIamSession).toHaveBeenCalledWith(primary.token);
      assertNoSecrets(res.body);
    });
  });

  // ── Plans ─────────────────────────────────────────────────────────────────

  describe('GET /v1/billing/plans', () => {
    it('returns the catalog and defaults the account to Free', async () => {
      const res = await dashboardGet(primary, '/v1/billing/plans').expect(200);

      expect(res.body.currentPlanId).toBe('free');
      expect(res.body.scheduledPlan).toBeUndefined();

      const codes = res.body.plans.map((p: { id: string }) => p.id).sort();
      expect(codes).toEqual(
        expect.arrayContaining(['free', 'starter', 'growth', 'scale', 'business', 'enterprise']),
      );

      for (const plan of res.body.plans) {
        expect(plan).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
            description: expect.any(String),
            basePrice: expect.any(String),
            currency: 'USD',
            billingPeriod: 'Monthly',
            features: expect.any(Array),
          }),
        );
        // JSON-safe: no BigInt leaks, no internal fee micros.
        expect(plan).not.toHaveProperty('monthlyFeeMicros');
        expect(typeof plan.basePrice).toBe('string');
      }

      const account = await prisma.billingAccount.findUnique({ where: { userId: primary.userId } });
      expect(account).not.toBeNull();
      assertNoSecrets(res.body);
    });
  });

  // ── Plan assignment ───────────────────────────────────────────────────────

  describe('POST /v1/billing/plan', () => {
    it('schedules a self-service plan change for the next UTC month', async () => {
      const nextPeriod = nextUtcMonthPeriod();

      const res = await dashboardPost(primary, '/v1/billing/plan', { planCode: 'starter' }).expect(
        201,
      );

      expect(res.body).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: nextPeriod,
        effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
        outcome: 'changed',
      });
      expect(res.body.effectiveFrom.startsWith(`${nextPeriod}-01`)).toBe(true);

      const plans = await dashboardGet(primary, '/v1/billing/plans').expect(200);
      expect(plans.body.currentPlanId).toBe('free');
      expect(plans.body.scheduledPlan).toEqual({
        planCode: 'starter',
        planName: 'Starter',
        effectivePeriod: nextPeriod,
      });

      // Open zero-usage estimate invoice for the future period.
      const invoices = await dashboardGet(primary, '/v1/billing/invoices').expect(200);
      expect(invoices.body.total).toBeGreaterThanOrEqual(1);
      const open = invoices.body.items.find(
        (i: { period: string; status: string }) => i.period === nextPeriod && i.status === 'open',
      );
      expect(open).toEqual(
        expect.objectContaining({
          period: nextPeriod,
          status: 'open',
          amount: '49',
          currency: 'USD',
          paidAt: null,
          pdfUrl: null,
          planVersionId: expect.any(String),
        }),
      );
      assertNoSecrets(res.body);
      assertNoSecrets(invoices.body);
    });

    it('is idempotent when the same future plan is requested again', async () => {
      await dashboardPost(primary, '/v1/billing/plan', { planCode: 'starter' }).expect(201);

      const again = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'starter',
      }).expect(201);
      expect(again.body.outcome).toBe('unchanged');
      expect(again.body.planCode).toBe('starter');

      const invoices = await prisma.billingInvoice.count({
        where: { billingAccount: { userId: primary.userId } },
      });
      expect(invoices).toBe(1);
    });

    it('rejects enterprise self-service and unknown plan codes', async () => {
      const enterprise = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'enterprise',
      }).expect(409);
      expect(enterprise.body.message).toEqual(expect.any(String));

      const unknown = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'nonexistent',
      }).expect(400);
      expectApiError(unknown.body, 400, 'BAD_REQUEST', '/v1/billing/plan');
    });

    it('rejects unknown body fields and empty planCode', async () => {
      await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'starter',
        effectiveFrom: '2099-01-01',
      }).expect(400);

      await dashboardPost(primary, '/v1/billing/plan', { planCode: '' }).expect(400);

      await dashboardPost(primary, '/v1/billing/plan', {}).expect(400);
    });
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  describe('GET /v1/billing/summary', () => {
    it('returns a JSON-safe Free-plan estimate for the current UTC month', async () => {
      const current = currentUtcMonthPeriod();
      const res = await dashboardGet(primary, '/v1/billing/summary').expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          period: current,
          planId: 'free',
          planName: 'Free',
          outboundVolume: '0',
          apiCalls: '0',
          activeWallets: '0',
          estimatedBaseCost: '0',
          estimatedTotal: '0',
          currency: 'USD',
          tierBreakdown: expect.any(Array),
        }),
      );
      // Decimal/count strings only — never raw micros or BigInt.
      for (const key of [
        'outboundVolume',
        'outboundFreeAllowance',
        'apiCalls',
        'estimatedBaseCost',
        'estimatedTotal',
      ]) {
        expect(typeof res.body[key]).toBe('string');
      }
      assertNoSecrets(res.body);
    });

    it('accepts an explicit YYYY-MM period and rejects malformed periods', async () => {
      const ok = await dashboardGet(primary, '/v1/billing/summary?period=2026-01').expect(200);
      expect(ok.body.period).toBe('2026-01');

      await dashboardGet(primary, '/v1/billing/summary?period=2026-13').expect(400);
      await dashboardGet(primary, '/v1/billing/summary?period=not-a-period').expect(400);
      await dashboardGet(primary, '/v1/billing/summary?period=2026-1').expect(400);
    });
  });

  // ── Invoices ownership / validation ───────────────────────────────────────

  describe('invoices ownership and validation', () => {
    it('lists only the caller account invoices and enforces pagination bounds', async () => {
      await dashboardPost(primary, '/v1/billing/plan', { planCode: 'growth' }).expect(201);
      await dashboardPost(other, '/v1/billing/plan', { planCode: 'starter' }).expect(201);

      const list = await dashboardGet(primary, '/v1/billing/invoices?page=1&limit=20').expect(200);
      expect(list.body).toEqual(
        expect.objectContaining({
          total: 1,
          page: 1,
          limit: 20,
          items: expect.any(Array),
        }),
      );
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].status).toBe('open');
      expect(list.body.items[0].amount).toBe('199');

      // Other user's open invoice must not appear.
      const otherInv = await prisma.billingInvoice.findFirstOrThrow({
        where: { billingAccount: { userId: other.userId } },
      });
      expect(list.body.items.some((i: { id: string }) => i.id === otherInv.id)).toBe(false);

      await dashboardGet(primary, '/v1/billing/invoices?page=0').expect(400);
      await dashboardGet(primary, '/v1/billing/invoices?limit=0').expect(400);
      await dashboardGet(primary, '/v1/billing/invoices?limit=101').expect(400);
      assertNoSecrets(list.body);
    });

    it('returns owned invoices and 404s cross-account / missing ids', async () => {
      await dashboardPost(primary, '/v1/billing/plan', { planCode: 'starter' }).expect(201);
      await dashboardPost(other, '/v1/billing/plan', { planCode: 'growth' }).expect(201);

      const mine = await prisma.billingInvoice.findFirstOrThrow({
        where: { billingAccount: { userId: primary.userId } },
      });
      const theirs = await prisma.billingInvoice.findFirstOrThrow({
        where: { billingAccount: { userId: other.userId } },
      });

      const owned = await dashboardGet(primary, `/v1/billing/invoices/${mine.id}`).expect(200);
      expect(owned.body).toEqual(
        expect.objectContaining({
          id: mine.id,
          status: 'open',
          amount: '49',
          currency: 'USD',
          paidAt: null,
          pdfUrl: null,
          planVersionId: expect.any(String),
        }),
      );
      assertNoSecrets(owned.body);

      const cross = await dashboardGet(primary, `/v1/billing/invoices/${theirs.id}`).expect(404);
      expectApiError(cross.body, 404, 'NOT_FOUND', `/v1/billing/invoices/${theirs.id}`);

      const missing = randomUUID();
      await dashboardGet(primary, `/v1/billing/invoices/${missing}`).expect(404);

      await dashboardGet(primary, '/v1/billing/invoices/not-a-uuid').expect(400);
    });

    it('does not allow checkout of open invoices or another account invoice', async () => {
      await dashboardPost(primary, '/v1/billing/plan', { planCode: 'starter' }).expect(201);

      const openInvoice = await prisma.billingInvoice.findFirstOrThrow({
        where: { billingAccount: { userId: primary.userId }, status: 'open' },
      });

      // Open invoices are not payable — fail closed before any Stripe session.
      const openCheckout = await dashboardPost(
        primary,
        `/v1/billing/invoices/${openInvoice.id}/checkout`,
        {},
      ).expect(409);
      expect(openCheckout.body.message).toMatch(/finalized/i);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(mockStripe.customers.create).not.toHaveBeenCalled();

      // Ensure the other account exists (lazy-created on first billing access).
      await dashboardGet(other, '/v1/billing/plans').expect(200);

      // Seed a finalized invoice on the other account and prove ownership 404.
      const otherAccount = await prisma.billingAccount.findUniqueOrThrow({
        where: { userId: other.userId },
      });
      const planVersion = await prisma.billingPlanVersion.findFirstOrThrow({
        where: { code: 'starter' },
        orderBy: { version: 'desc' },
      });
      const finalizedId = randomUUID();
      const periodStart = new Date('2025-06-01T00:00:00.000Z');
      const periodEnd = new Date('2025-07-01T00:00:00.000Z');
      await prisma.billingInvoice.create({
        data: {
          id: finalizedId,
          billingAccountId: otherAccount.id,
          planVersionId: planVersion.id,
          periodStart,
          periodEnd,
          status: 'finalized',
          currency: 'USD',
          grossOutboundMicros: 0n,
          billableOutboundMicros: 0n,
          apiCalls: 0n,
          activeWallets: 0,
          monthlyFeeMicros: 49_000_000n,
          outboundOverageMicros: 0n,
          apiOverageMicros: 0n,
          walletOverageMicros: 0n,
          totalMicros: 49_000_000n,
          snapshotJson: { version: 1, period: '2025-06' },
          snapshotHash: 'billing-http-e2e-finalized',
          finalizedAt: new Date('2025-07-02T00:00:00.000Z'),
        },
      });

      const crossCheckout = await dashboardPost(
        primary,
        `/v1/billing/invoices/${finalizedId}/checkout`,
        {},
      ).expect(404);
      expectApiError(
        crossCheckout.body,
        404,
        'NOT_FOUND',
        `/v1/billing/invoices/${finalizedId}/checkout`,
      );
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();

      // Own finalized invoice still never fabricates payment success: Stripe
      // mock rejects session creation (503), invoice stays unpaid.
      const ownFinalizedId = randomUUID();
      const primaryAccount = await prisma.billingAccount.findUniqueOrThrow({
        where: { userId: primary.userId },
      });
      await prisma.billingInvoice.create({
        data: {
          id: ownFinalizedId,
          billingAccountId: primaryAccount.id,
          planVersionId: planVersion.id,
          periodStart: new Date('2025-05-01T00:00:00.000Z'),
          periodEnd: new Date('2025-06-01T00:00:00.000Z'),
          status: 'finalized',
          currency: 'USD',
          grossOutboundMicros: 0n,
          billableOutboundMicros: 0n,
          apiCalls: 0n,
          activeWallets: 0,
          monthlyFeeMicros: 49_000_000n,
          outboundOverageMicros: 0n,
          apiOverageMicros: 0n,
          walletOverageMicros: 0n,
          totalMicros: 49_000_000n,
          snapshotJson: { version: 1, period: '2025-05' },
          snapshotHash: 'billing-http-e2e-own-finalized',
          finalizedAt: new Date('2025-06-02T00:00:00.000Z'),
        },
      });

      const ownCheckout = await dashboardPost(
        primary,
        `/v1/billing/invoices/${ownFinalizedId}/checkout`,
        {},
      );
      // Eligibility passed; mocked Stripe refuses session creation → 5xx.
      expect(ownCheckout.status).toBeGreaterThanOrEqual(500);
      expect(ownCheckout.body).not.toEqual(
        expect.objectContaining({
          checkoutUrl: expect.any(String),
          sessionId: expect.any(String),
        }),
      );

      const stillUnpaid = await prisma.billingInvoice.findUniqueOrThrow({
        where: { id: ownFinalizedId },
      });
      expect(stillUnpaid.status).toBe('finalized');
      expect(stillUnpaid.paidAt).toBeNull();
      expect(stillUnpaid.settlementAttemptId).toBeNull();
      assertNoSecrets(ownCheckout.body);
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function dashboardGet(user: TestUser, path: string) {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Origin', FRONTEND_ORIGIN);
  }

  function dashboardPost(user: TestUser, path: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Origin', FRONTEND_ORIGIN)
      .send(body);
  }

  async function seedUser(label: string): Promise<TestUser> {
    const token = `billing-http-token-${SUITE_ID}-${label}-${randomUUID()}`;
    const socialId = `billing_http_e2e_${SUITE_ID}_${label}_${randomUUID()}`;
    const email = `${socialId}@example.com`;

    const user = await prisma.user.create({
      data: {
        socialProvider: 'openfort_email_otp',
        socialId,
        email,
      },
    });

    iamSessions.set(token, { openfortUserId: socialId, email });

    return { token, socialId, email, userId: user.id };
  }

  function currentUtcMonthPeriod(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function nextUtcMonthPeriod(): string {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const y = next.getUTCFullYear();
    const m = String(next.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function expectApiError(
    body: Record<string, unknown>,
    statusCode: number,
    code: string,
    path: string,
  ) {
    expect(body).toEqual(
      expect.objectContaining({
        statusCode,
        code,
        message: expect.any(String),
        timestamp: expect.any(String),
        path,
        requestId: expect.any(String),
      }),
    );
    expect(body).not.toHaveProperty('error');
  }

  /** Responses must never leak secrets, provider keys, or raw BigInt amounts. */
  function assertNoSecrets(payload: unknown) {
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/sk_(live|test)_/i);
    expect(text).not.toMatch(/whsec_/i);
    expect(text).not.toMatch(/STRIPE_SECRET/i);
    expect(text).not.toMatch(/OPENFORT_API_KEY/i);
    expect(text).not.toMatch(/OPENFORT_WALLET_SECRET/i);
    expect(text).not.toMatch(/"monthlyFeeMicros"/);
    expect(text).not.toMatch(/"totalMicros"/);
    expect(text).not.toContain('stripe customer create blocked');
    expect(text).not.toContain('stripe checkout create blocked');
  }

  async function cleanDatabase() {
    // Break settlement FK before deleting payment attempts.
    await prisma.billingInvoice.updateMany({ data: { settlementAttemptId: null } });
    await prisma.billingPaymentAttempt.deleteMany();
    await prisma.billingInvoiceLine.deleteMany();
    await prisma.billingUsageEvent.deleteMany();
    await prisma.billingInvoice.deleteMany();
    await prisma.billingPlanAssignment.deleteMany();
    await prisma.billingReconciliationRun.deleteMany();
    await prisma.billingAccount.deleteMany();
    // Shared catalog (plan versions/tiers) is left intact for other suites.
    await prisma.signingRequest.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.apiKeyEvent.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.securityNotification.deleteMany();
    await prisma.securityEvent.deleteMany();
    await prisma.stripeWebhookEvent.deleteMany();
    await prisma.user.deleteMany();
  }
});

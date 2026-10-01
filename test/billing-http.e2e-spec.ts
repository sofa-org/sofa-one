/**
 * E2E: dashboard billing HTTP surface (guard/origin, plans, summary,
 * plan assignment, invoice ownership/validation).
 *
 * Real: AppModule + PostgreSQL (runner-provisioned BILLING_E2E_* target only).
 * Mocked: Openfort IAM session verification, Stripe client (never confirms payment).
 * Does not fake successful payment or expose secrets.
 *
 * Database isolation: see test/billing-e2e-database.ts + scripts/billing-e2e-runner.ts.
 * Run via `npm run test:e2e:billing` (never against a static shared database).
 */
import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as request from 'supertest';
import { PrismaService } from '../src/core/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { STRIPE_CLIENT } from '../src/modules/billing/stripe/stripe.constants';
import { calculateUpgradeProrationMicros } from '../src/modules/billing/billing-plan-change.proration';
import { microsToDecimalUsd } from '../src/modules/billing/billing.utils';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
  type BillingE2eDatabaseTarget,
} from './billing-e2e-database';

// Runner-provisioned target only (no dotenv; no DATABASE_URL fallback).
const billingE2eDb: BillingE2eDatabaseTarget = applyBillingE2eDatabaseUrl(
  resolveBillingE2eDatabaseTarget(),
);

process.env.NODE_ENV = 'test';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
// Fixed 32-byte test-only MFA key (base64). Never inherit a real key from .env.
process.env.MFA_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
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

// AppModule is required dynamically in beforeAll AFTER the runner target is
// applied and live identity is verified — avoids loading Nest config against
// an unverified / inherited DATABASE_URL.

describe('Billing HTTP dashboard flow (e2e)', () => {
  // Real Nest AppModule + Prisma against a fresh runner DB exceeds Jest's
  // default 5s hook budget; keep a hard upper bound so hangs still fail.
  jest.setTimeout(30_000);

  let app: INestApplication | undefined;
  let moduleFixture: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let preflightPrisma: PrismaClient | undefined;
  let primary: TestUser;
  let other: TestUser;
  let dbIdentityVerified = false;

  beforeAll(async () => {
    try {
      // 1) Live identity on a dedicated preflight client BEFORE Nest init.
      //    Never clean/seed until this passes.
      preflightPrisma = new PrismaClient({ adapter: new PrismaPg(billingE2eDb.url) });
      await preflightPrisma.$connect();
      await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
        queryBillingE2eIdentityWithPrisma(preflightPrisma!),
      );

      // 2) Load AppModule only after the target is applied + verified.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');

      moduleFixture = await Test.createTestingModule({
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

      // Re-check via the Nest-bound client (same target URL).
      await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
        queryBillingE2eIdentityWithPrisma(prisma!),
      );
      dbIdentityVerified = true;
    } catch (err) {
      dbIdentityVerified = false;
      await teardownClients();
      throw err;
    }
  });

  beforeEach(async () => {
    if (!prisma || !dbIdentityVerified) {
      throw new Error('billing HTTP e2e: database not initialized or identity unverified');
    }
    jest.clearAllMocks();
    iamSessions.clear();
    await cleanDatabase();

    primary = await seedUser('primary');
    other = await seedUser('other');
  });

  afterAll(async () => {
    try {
      if (prisma && dbIdentityVerified) {
        await cleanDatabase();
      }
    } finally {
      await teardownClients();
    }
  });

  async function teardownClients(): Promise<void> {
    const errors: unknown[] = [];
    if (app) {
      try {
        await app.close();
      } catch (e) {
        errors.push(e);
      }
      app = undefined;
    }
    if (moduleFixture) {
      try {
        await moduleFixture.close();
      } catch (e) {
        errors.push(e);
      }
      moduleFixture = undefined;
    }
    prisma = undefined;
    if (preflightPrisma) {
      try {
        await preflightPrisma.$disconnect();
      } catch (e) {
        errors.push(e);
      }
      preflightPrisma = undefined;
    }
    if (errors.length) {
      // Prefer the first close error without leaking connection strings.
      throw errors[0];
    }
  }

  // ── Guard / origin / IAM ──────────────────────────────────────────────────

  describe('guard and origin', () => {
    it('rejects billing routes without Origin/Referer', async () => {
      const res = await request(app!.getHttpServer())
        .get('/v1/billing/plans')
        .set('Authorization', `Bearer ${primary.token}`)
        .expect(403);

      expectApiError(res.body, 403, 'BAD_REQUEST', '/v1/billing/plans');
      expect(res.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('rejects billing routes without a bearer token', async () => {
      const res = await request(app!.getHttpServer())
        .get('/v1/billing/plans')
        .set('Origin', FRONTEND_ORIGIN)
        .expect(401);

      expectApiError(res.body, 401, 'UNAUTHORIZED', '/v1/billing/plans');
    });

    it('rejects billing routes with an invalid IAM token', async () => {
      const res = await request(app!.getHttpServer())
        .get('/v1/billing/plans')
        .set('Authorization', 'Bearer not-a-real-token')
        .set('Origin', FRONTEND_ORIGIN)
        .expect(401);

      expectApiError(res.body, 401, 'UNAUTHORIZED', '/v1/billing/plans');
      expect(mockOpenfortService.verifyIamSession).toHaveBeenCalledWith('not-a-real-token');
    });

    it('rejects a disallowed Origin even with a valid token', async () => {
      await request(app!.getHttpServer())
        .get('/v1/billing/plans')
        .set('Authorization', `Bearer ${primary.token}`)
        .set('Origin', 'https://evil.example')
        .expect(403);
    });

    it('does not accept an API key for dashboard billing routes', async () => {
      await request(app!.getHttpServer())
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

      const account = await prisma!.billingAccount.findUnique({
        where: { userId: primary.userId },
      });
      expect(account).not.toBeNull();
      assertNoSecrets(res.body);
    });
  });

  // ── Plan assignment ───────────────────────────────────────────────────────

  describe('POST /v1/billing/plan', () => {
    it('requires payment for Free→Starter upgrade with current-period proration', async () => {
      const current = currentUtcMonthPeriod();

      const res = await dashboardPost(primary, '/v1/billing/plan', { planCode: 'starter' }).expect(
        201,
      );

      expect(res.body).toEqual(
        expect.objectContaining({
          planCode: 'starter',
          planName: 'Starter',
          outcome: 'payment_required',
          kind: 'upgrade',
          currency: 'USD',
          changeId: expect.any(String),
          invoiceId: expect.any(String),
          amount: expect.any(String),
          effectivePeriod: current,
          effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
        }),
      );
      expect(res.body.effectiveFrom.startsWith(`${current}-01`)).toBe(true);

      // Entitlements stay Free until the plan_charge is paid.
      const plans = await dashboardGet(primary, '/v1/billing/plans').expect(200);
      expect(plans.body.currentPlanId).toBe('free');
      expect(plans.body.scheduledPlan).toBeUndefined();

      const invoice = await prisma!.billingInvoice.findUniqueOrThrow({
        where: { id: res.body.invoiceId },
      });
      expect(invoice.purpose).toBe('plan_charge');
      expect(invoice.status).toBe('finalized');
      expect(formatUtcMonth(invoice.periodStart)).toBe(current);
      expect(invoice.paidAt).toBeNull();

      // Dynamic proration: recompute from the server snapshot timestamp (not calendar-bound).
      const starter = await prisma!.billingPlanVersion.findFirstOrThrow({
        where: { code: 'starter' },
        orderBy: { version: 'desc' },
      });
      expect(starter.monthlyFeeMicros).not.toBeNull();
      const snap = invoice.snapshotJson as { computedAt?: string };
      expect(typeof snap.computedAt).toBe('string');
      const expectedMicros = calculateUpgradeProrationMicros({
        currentMonthlyFeeMicros: 0n,
        targetMonthlyFeeMicros: starter.monthlyFeeMicros!,
        now: new Date(snap.computedAt!),
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      });
      expect(expectedMicros).not.toBeNull();
      expect(invoice.totalMicros).toBe(expectedMicros);
      expect(res.body.amount).toBe(microsToDecimalUsd(expectedMicros!));
      // Full-month sticker price must not be assumed as the charge.
      expect(invoice.totalMicros).toBeGreaterThan(0n);
      expect(invoice.totalMicros).toBeLessThanOrEqual(starter.monthlyFeeMicros!);

      const listed = await dashboardGet(primary, '/v1/billing/invoices').expect(200);
      expect(listed.body.total).toBeGreaterThanOrEqual(1);
      const charge = listed.body.items.find((i: { id: string }) => i.id === invoice.id);
      expect(charge).toEqual(
        expect.objectContaining({
          id: invoice.id,
          period: current,
          status: 'finalized',
          amount: res.body.amount,
          currency: 'USD',
          paidAt: null,
          pdfUrl: null,
          planVersionId: expect.any(String),
        }),
      );
      assertNoSecrets(res.body);
      assertNoSecrets(listed.body);
    });

    it('is idempotent when the same pending upgrade is requested again', async () => {
      const first = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'starter',
      }).expect(201);
      expect(first.body.outcome).toBe('payment_required');

      const again = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'starter',
      }).expect(201);
      expect(again.body.outcome).toBe('payment_required');
      expect(again.body.changeId).toBe(first.body.changeId);
      expect(again.body.invoiceId).toBe(first.body.invoiceId);
      expect(again.body.amount).toBe(first.body.amount);

      const invoices = await prisma!.billingInvoice.count({
        where: {
          billingAccount: { userId: primary.userId },
          purpose: 'plan_charge',
        },
      });
      expect(invoices).toBe(1);

      const changes = await prisma!.billingPlanChange.count({
        where: {
          billingAccount: { userId: primary.userId },
          status: 'pending_payment',
        },
      });
      expect(changes).toBe(1);
    });

    it('schedules a downgrade for the next UTC month after a paid assignment', async () => {
      // Paid Starter for the current UTC month (mirrors post-upgrade_payment apply:
      // bounded expiresAt at next month start — null expiresAt is invalid for fee>0).
      await seedPaidCurrentPlanAssignment(primary, 'starter');

      const nextPeriod = nextUtcMonthPeriod();
      const res = await dashboardPost(primary, '/v1/billing/plan', { planCode: 'free' }).expect(
        201,
      );

      expect(res.body).toEqual(
        expect.objectContaining({
          planCode: 'free',
          planName: 'Free',
          outcome: 'scheduled',
          kind: 'downgrade',
          changeId: expect.any(String),
          effectivePeriod: nextPeriod,
          effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
        }),
      );
      expect(res.body.effectiveFrom.startsWith(`${nextPeriod}-01`)).toBe(true);

      const plans = await dashboardGet(primary, '/v1/billing/plans').expect(200);
      expect(plans.body.currentPlanId).toBe('starter');
      expect(plans.body.scheduledPlan).toEqual({
        planCode: 'free',
        planName: 'Free',
        effectivePeriod: nextPeriod,
      });

      // Same schedule again is idempotent (still scheduled, same target).
      const again = await dashboardPost(primary, '/v1/billing/plan', { planCode: 'free' }).expect(
        201,
      );
      expect(again.body.outcome).toBe('scheduled');
      expect(again.body.planCode).toBe('free');
      expect(again.body.changeId).toBe(res.body.changeId);

      assertNoSecrets(res.body);
      assertNoSecrets(plans.body);
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
      const primaryUpgrade = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'growth',
      }).expect(201);
      expect(primaryUpgrade.body.outcome).toBe('payment_required');

      const otherUpgrade = await dashboardPost(other, '/v1/billing/plan', {
        planCode: 'starter',
      }).expect(201);
      expect(otherUpgrade.body.outcome).toBe('payment_required');

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
      expect(list.body.items[0].status).toBe('finalized');
      expect(list.body.items[0].id).toBe(primaryUpgrade.body.invoiceId);
      expect(list.body.items[0].amount).toBe(primaryUpgrade.body.amount);

      // Other user's plan_charge must not appear.
      expect(
        list.body.items.some((i: { id: string }) => i.id === otherUpgrade.body.invoiceId),
      ).toBe(false);

      await dashboardGet(primary, '/v1/billing/invoices?page=0').expect(400);
      await dashboardGet(primary, '/v1/billing/invoices?limit=0').expect(400);
      await dashboardGet(primary, '/v1/billing/invoices?limit=101').expect(400);
      assertNoSecrets(list.body);
    });

    it('returns owned invoices and 404s cross-account / missing ids', async () => {
      const mineUpgrade = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'starter',
      }).expect(201);
      const theirsUpgrade = await dashboardPost(other, '/v1/billing/plan', {
        planCode: 'growth',
      }).expect(201);

      const owned = await dashboardGet(
        primary,
        `/v1/billing/invoices/${mineUpgrade.body.invoiceId}`,
      ).expect(200);
      expect(owned.body).toEqual(
        expect.objectContaining({
          id: mineUpgrade.body.invoiceId,
          status: 'finalized',
          amount: mineUpgrade.body.amount,
          currency: 'USD',
          paidAt: null,
          pdfUrl: null,
          planVersionId: expect.any(String),
        }),
      );
      assertNoSecrets(owned.body);

      const cross = await dashboardGet(
        primary,
        `/v1/billing/invoices/${theirsUpgrade.body.invoiceId}`,
      ).expect(404);
      expectApiError(
        cross.body,
        404,
        'NOT_FOUND',
        `/v1/billing/invoices/${theirsUpgrade.body.invoiceId}`,
      );

      const missing = randomUUID();
      await dashboardGet(primary, `/v1/billing/invoices/${missing}`).expect(404);

      await dashboardGet(primary, '/v1/billing/invoices/not-a-uuid').expect(400);
    });

    it('does not allow checkout of open invoices or another account invoice', async () => {
      // Open usage_period invoices are not payable — fail closed before Stripe.
      await dashboardGet(primary, '/v1/billing/plans').expect(200);
      const primaryAccount = await prisma!.billingAccount.findUniqueOrThrow({
        where: { userId: primary.userId },
      });
      const planVersion = await prisma!.billingPlanVersion.findFirstOrThrow({
        where: { code: 'starter' },
        orderBy: { version: 'desc' },
      });
      const openInvoiceId = randomUUID();
      await prisma!.billingInvoice.create({
        data: {
          id: openInvoiceId,
          billingAccountId: primaryAccount.id,
          planVersionId: planVersion.id,
          periodStart: new Date('2025-04-01T00:00:00.000Z'),
          periodEnd: new Date('2025-05-01T00:00:00.000Z'),
          purpose: 'usage_period',
          status: 'open',
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
          snapshotJson: { version: 1, period: '2025-04' },
          snapshotHash: 'billing-http-e2e-open',
        },
      });

      const openCheckout = await dashboardPost(
        primary,
        `/v1/billing/invoices/${openInvoiceId}/checkout`,
        {},
      ).expect(409);
      expect(openCheckout.body.message).toMatch(/finalized/i);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(mockStripe.customers.create).not.toHaveBeenCalled();

      // Ensure the other account exists (lazy-created on first billing access).
      await dashboardGet(other, '/v1/billing/plans').expect(200);

      // Seed a finalized invoice on the other account and prove ownership 404.
      const otherAccount = await prisma!.billingAccount.findUniqueOrThrow({
        where: { userId: other.userId },
      });
      const finalizedId = randomUUID();
      await prisma!.billingInvoice.create({
        data: {
          id: finalizedId,
          billingAccountId: otherAccount.id,
          planVersionId: planVersion.id,
          periodStart: new Date('2025-06-01T00:00:00.000Z'),
          periodEnd: new Date('2025-07-01T00:00:00.000Z'),
          purpose: 'usage_period',
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

      // Own finalized plan_charge is checkout-eligible, but mocked Stripe refuses
      // session creation (5xx); invoice stays unpaid — never fabricate success.
      const upgrade = await dashboardPost(primary, '/v1/billing/plan', {
        planCode: 'starter',
      }).expect(201);
      expect(upgrade.body.outcome).toBe('payment_required');

      const ownCheckout = await dashboardPost(
        primary,
        `/v1/billing/invoices/${upgrade.body.invoiceId}/checkout`,
        {},
      );
      expect(ownCheckout.status).toBeGreaterThanOrEqual(500);
      expect(ownCheckout.body).not.toEqual(
        expect.objectContaining({
          checkoutUrl: expect.any(String),
          sessionId: expect.any(String),
        }),
      );

      const stillUnpaid = await prisma!.billingInvoice.findUniqueOrThrow({
        where: { id: upgrade.body.invoiceId },
      });
      expect(stillUnpaid.status).toBe('finalized');
      expect(stillUnpaid.paidAt).toBeNull();
      expect(stillUnpaid.settlementAttemptId).toBeNull();
      assertNoSecrets(ownCheckout.body);
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function dashboardGet(user: TestUser, path: string) {
    return request(app!.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Origin', FRONTEND_ORIGIN);
  }

  function dashboardPost(user: TestUser, path: string, body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Origin', FRONTEND_ORIGIN)
      .send(body);
  }

  async function seedUser(label: string): Promise<TestUser> {
    const token = `billing-http-token-${SUITE_ID}-${label}-${randomUUID()}`;
    const socialId = `billing_http_e2e_${SUITE_ID}_${label}_${randomUUID()}`;
    const email = `${socialId}@example.com`;

    const user = await prisma!.user.create({
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
    return formatUtcMonth(new Date());
  }

  function nextUtcMonthPeriod(): string {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return formatUtcMonth(next);
  }

  function monthStartUtc(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }

  function monthEndUtc(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }

  function formatUtcMonth(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  /**
   * Deterministically place the account on a paid plan for the current UTC month.
   * Production paid assignments always carry expiresAt > periodStart (never null
   * for fee > 0); open-ended null expiresAt is Free-only and is rejected by
   * isAssignmentEntitlementValid, which would leave the user on Free and make
   * POST /plan free return unchanged instead of scheduled.
   */
  async function seedPaidCurrentPlanAssignment(user: TestUser, planCode: string): Promise<void> {
    // Ensure BillingAccount + default Free assignment exist via the real path.
    await dashboardGet(user, '/v1/billing/plans').expect(200);

    const account = await prisma!.billingAccount.findUniqueOrThrow({
      where: { userId: user.userId },
    });
    const plan = await prisma!.billingPlanVersion.findFirstOrThrow({
      where: { code: planCode },
      orderBy: { version: 'desc' },
    });
    expect(plan.monthlyFeeMicros).not.toBeNull();
    expect(plan.monthlyFeeMicros!).toBeGreaterThan(0n);

    const now = new Date();
    const periodStart = monthStartUtc(now);
    // Exclusive end of the paid window (upgrade validUntil / usage periodEnd).
    const expiresAt = monthEndUtc(now);
    expect(expiresAt.getTime()).toBeGreaterThan(periodStart.getTime());
    expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());

    const existing = await prisma!.billingPlanAssignment.findUnique({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: account.id,
          periodStart,
        },
      },
    });

    if (existing) {
      await prisma!.billingPlanAssignment.update({
        where: { id: existing.id },
        data: {
          planVersionId: plan.id,
          source: 'upgrade_payment',
          expiresAt,
        },
      });
    } else {
      // No row at the exact current-month key (e.g. only a historical default).
      // Upsert the canonical current-month paid entitlement without relying on
      // Date equality in updateMany filters.
      await prisma!.billingPlanAssignment.create({
        data: {
          billingAccountId: account.id,
          planVersionId: plan.id,
          periodStart,
          source: 'upgrade_payment',
          expiresAt,
        },
      });
    }

    const seeded = await prisma!.billingPlanAssignment.findUniqueOrThrow({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: account.id,
          periodStart,
        },
      },
      include: { planVersion: true },
    });
    expect(seeded.planVersion.code).toBe(planCode);
    expect(seeded.expiresAt).not.toBeNull();
    expect(seeded.expiresAt!.getTime()).toBe(expiresAt.getTime());
    expect(seeded.source).toBe('upgrade_payment');

    // Confirm the dashboard sees the paid plan before the downgrade request.
    const plans = await dashboardGet(user, '/v1/billing/plans').expect(200);
    expect(plans.body.currentPlanId).toBe(planCode);
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
    if (!prisma || !dbIdentityVerified) {
      throw new Error('cleanDatabase refused: prisma missing or DB identity unverified');
    }

    // FK-safe order for current billing schema. Catalog (plan versions/tiers)
    // is left intact. Only runs against the verified disposable E2E database.
    await prisma.billingInvoice.updateMany({ data: { settlementAttemptId: null } });
    await prisma.billingPlanChange.updateMany({ data: { chargeInvoiceId: null } });
    await prisma.billingPlanChange.deleteMany();
    await prisma.billingSubscriptionSyncIntent.deleteMany();
    await prisma.billingAutoSubscriptionIntent.deleteMany();
    await prisma.billingPaymentAttempt.deleteMany();
    await prisma.billingInvoiceLine.deleteMany();
    await prisma.billingUsageEvent.deleteMany();
    await prisma.billingInvoice.deleteMany();
    await prisma.billingPlanAssignment.deleteMany();
    await prisma.billingReconciliationRun.deleteMany();
    await prisma.billingAccount.deleteMany();

    await prisma.walletChainAuthorization.deleteMany();
    await prisma.signingRequest.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.apiKeyEvent.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.withdrawalAddress.deleteMany();
    await prisma.withdrawalPolicy.deleteMany();
    await prisma.securityNotification.deleteMany();
    await prisma.securityEvent.deleteMany();
    await prisma.stepUpChallenge.deleteMany();
    await prisma.userMfaTotpRecoveryCode.deleteMany();
    await prisma.userMfaTotpCredential.deleteMany();
    await prisma.userKnownIp.deleteMany();
    await prisma.stripeWebhookEvent.deleteMany();
    await prisma.user.deleteMany();
  }
});

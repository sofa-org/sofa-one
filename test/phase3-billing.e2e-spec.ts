/**
 * Phase 3 disposable-PostgreSQL E2E evidence (BILL-001 / BILL-014 / BILL-020).
 *
 * Real: AppModule + runner-provisioned PostgreSQL (BILLING_E2E_* only), row locks,
 *       unique cross-rail index, cleanup lease/CAS, worker tick backlog, health
 *       healthy-wins aggregation (BILL-020 B3/B4).
 * Mocked: Openfort IAM, Stripe client (never live provider / chain / Openfort).
 *
 * Does not claim a live Stripe contract. Run via `npm run test:e2e:billing`.
 * Does not claim the full multi-suite runner.
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
import { HealthService } from '../src/modules/health/health.service';
import { BillingWorkerService } from '../src/modules/billing/billing-worker.service';
import { StripePaymentService } from '../src/modules/billing/stripe/stripe-payment.service';
import {
  RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
  StripeCheckoutSessionCleanupService,
} from '../src/modules/billing/stripe/stripe-checkout-session-cleanup.service';
import {
  AUTO_SUB_PM_NOT_REUSABLE_CODE,
  AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
  classifyAutoSubNeedsReviewOutcome,
  isSafeTerminalNoFundsIntent,
  isUnresolvedAutoSubNeedsReviewIntent,
  prismaWhereUnresolvedAutoSubNeedsReview,
} from '../src/modules/billing/stripe/auto-subscription-terminal-no-funds';
import {
  SESSION_CLEANUP_STATUS_COMPLETED,
  SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
  STRIPE_CHARGE_KIND_FIXED_FEE,
  STRIPE_CHARGE_KIND_FULL,
  STRIPE_CLIENT,
} from '../src/modules/billing/stripe/stripe.constants';
import {
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  queryBillingE2eIdentityWithPrisma,
  resolveBillingE2eDatabaseTarget,
  type BillingE2eDatabaseTarget,
} from './billing-e2e-database';

const billingE2eDb: BillingE2eDatabaseTarget = applyBillingE2eDatabaseUrl(
  resolveBillingE2eDatabaseTarget(),
);

process.env.NODE_ENV = 'test';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
process.env.MFA_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.REDIS_URL = '';
// Worker enabled so HealthService evaluates billingWorker status (not disabled).
// Interval is 5 minutes; tests drive cleanup/health via services, not live ticks.
process.env.BILLING_WORKER_ENABLED = 'true';
process.env.STRIPE_SUCCESS_URL = 'https://example.test/billing/success';
process.env.STRIPE_CANCEL_URL = 'https://example.test/billing/cancel';

const FRONTEND_ORIGIN = 'http://localhost:3000';
const SUITE_ID = randomUUID().replace(/-/g, '').slice(0, 12);
const AMOUNT_MICROS = 21_030_000n;
const AMOUNT_CENTS = 2103;
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');
const PERIOD_LABEL = '2026-09';
const STRIPE_CUSTOMER = 'cus_phase3_e2e';

type SeedBundle = {
  userId: string;
  token: string;
  accountId: string;
  planId: string;
  invoiceId: string;
};

const iamSessions = new Map<string, { openfortUserId: string; email: string }>();

const mockOpenfortService = {
  verifyIamSession: jest.fn(async (accessToken: string) => {
    const session = iamSessions.get(accessToken);
    if (!session) throw new Error('invalid openfort token');
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

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => mockOpenfortService),
}));

const sessionsCreate = jest.fn();
const sessionsRetrieve = jest.fn();
const sessionsExpire = jest.fn();
const sessionsList = jest.fn();
const customersCreate = jest.fn();

const mockStripe = {
  customers: {
    create: customersCreate,
  },
  checkout: {
    sessions: {
      create: sessionsCreate,
      retrieve: sessionsRetrieve,
      expire: sessionsExpire,
      list: sessionsList,
    },
  },
  paymentIntents: {
    create: jest.fn().mockRejectedValue(new Error('stripe PI create blocked in phase3 e2e')),
    retrieve: jest.fn().mockRejectedValue(new Error('stripe PI retrieve blocked in phase3 e2e')),
  },
  webhooks: {
    constructEventAsync: jest
      .fn()
      .mockRejectedValue(new Error('stripe webhook blocked in phase3 e2e')),
  },
};

describe('Phase 3 billing integrity (disposable PostgreSQL e2e)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication | undefined;
  let moduleFixture: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let preflightPrisma: PrismaClient | undefined;
  let health: HealthService | undefined;
  let billingWorker: BillingWorkerService | undefined;
  let stripePayments: StripePaymentService | undefined;
  let sessionCleanup: StripeCheckoutSessionCleanupService | undefined;
  let dbIdentityVerified = false;

  beforeAll(async () => {
    try {
      preflightPrisma = new PrismaClient({ adapter: new PrismaPg(billingE2eDb.url) });
      await preflightPrisma.$connect();
      await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
        queryBillingE2eIdentityWithPrisma(preflightPrisma!),
      );

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
      health = app.get(HealthService);
      billingWorker = app.get(BillingWorkerService);
      stripePayments = app.get(StripePaymentService);
      sessionCleanup = app.get(StripeCheckoutSessionCleanupService);

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
      throw new Error('phase3 e2e: database not initialized or identity unverified');
    }
    jest.clearAllMocks();
    iamSessions.clear();
    customersCreate.mockRejectedValue(new Error('stripe customer create must not run'));
    sessionsCreate.mockRejectedValue(new Error('stripe checkout create must not run'));
    sessionsRetrieve.mockRejectedValue(new Error('stripe retrieve not configured'));
    sessionsExpire.mockRejectedValue(new Error('stripe expire not configured'));
    sessionsList.mockRejectedValue(new Error('stripe list not configured'));
    await cleanDatabase();
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
    health = undefined;
    billingWorker = undefined;
    stripePayments = undefined;
    sessionCleanup = undefined;
    if (preflightPrisma) {
      try {
        await preflightPrisma.$disconnect();
      } catch (e) {
        errors.push(e);
      }
      preflightPrisma = undefined;
    }
    if (errors.length) throw errors[0];
  }

  // ── BILL-001: cross-rail full-checkout conflict / no partial attempt ────────

  describe('BILL-001 full-checkout cross-rail conflict', () => {
    it('returns stable 409, leaves no Stripe attempt, and never calls Stripe create', async () => {
      const seed = await seedUserAccountInvoice();
      const usdcAttemptId = randomUUID();
      await prisma!.billingPaymentAttempt.create({
        data: {
          id: usdcAttemptId,
          invoiceId: seed.invoiceId,
          method: 'usdc',
          status: 'confirming',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
        },
      });

      const before = await prisma!.billingPaymentAttempt.findMany({
        where: { invoiceId: seed.invoiceId },
      });
      expect(before).toHaveLength(1);
      expect(before[0]!.method).toBe('usdc');

      const res = await request(app!.getHttpServer())
        .post(`/v1/billing/invoices/${seed.invoiceId}/checkout`)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Authorization', `Bearer ${seed.token}`)
        .expect(409);

      // ConflictException string messages resolve to BAD_REQUEST code (no CONFLICT token).
      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 409,
          code: 'BAD_REQUEST',
          message: expect.stringMatching(/active payment of another rail/i),
          path: `/v1/billing/invoices/${seed.invoiceId}/checkout`,
          requestId: expect.any(String),
        }),
      );
      // No provider error leakage.
      expect(JSON.stringify(res.body)).not.toMatch(/sk_(live|test)_/i);
      expect(JSON.stringify(res.body)).not.toContain('must not run');

      const after = await prisma!.billingPaymentAttempt.findMany({
        where: { invoiceId: seed.invoiceId },
        orderBy: { createdAt: 'asc' },
      });
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(usdcAttemptId);
      expect(after[0]!.method).toBe('usdc');
      expect(after[0]!.status).toBe('confirming');

      const stripeRows = await prisma!.billingPaymentAttempt.findMany({
        where: { invoiceId: seed.invoiceId, method: 'stripe' },
      });
      expect(stripeRows).toHaveLength(0);

      expect(customersCreate).not.toHaveBeenCalled();
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('service path rejects cross-rail without leaving a partial pending Stripe row', async () => {
      const seed = await seedUserAccountInvoice();
      await prisma!.billingPaymentAttempt.create({
        data: {
          invoiceId: seed.invoiceId,
          method: 'usdc',
          status: 'pending',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
        },
      });

      await expect(
        stripePayments!.createCheckoutSession(seed.userId, seed.invoiceId),
      ).rejects.toThrow(/active payment of another rail/i);

      const stripeAttempts = await prisma!.billingPaymentAttempt.count({
        where: { invoiceId: seed.invoiceId, method: 'stripe' },
      });
      expect(stripeAttempts).toBe(0);
      expect(sessionsCreate).not.toHaveBeenCalled();
      expect(customersCreate).not.toHaveBeenCalled();
    });

    it('DB unique active-payment index rejects a second active rail insert (P2002 evidence)', async () => {
      const seed = await seedUserAccountInvoice();
      await prisma!.billingPaymentAttempt.create({
        data: {
          invoiceId: seed.invoiceId,
          method: 'usdc',
          status: 'pending',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
        },
      });

      await expect(
        prisma!.billingPaymentAttempt.create({
          data: {
            invoiceId: seed.invoiceId,
            method: 'stripe',
            status: 'pending',
            amountMicros: AMOUNT_MICROS,
            currency: 'USD',
            stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const rows = await prisma!.billingPaymentAttempt.findMany({
        where: { invoiceId: seed.invoiceId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.method).toBe('usdc');
    });
  });

  // ── BILL-014: cleanup lease/fencing + late session ID discovery ────────────

  describe('BILL-014 cleanup lease / late session discovery', () => {
    it('late ID discovery binds unique metadata match then expires without recreate', async () => {
      const paid = await seedPaidInvoiceWithSibling({
        siblingSessionId: null,
        siblingStatus: 'failed',
      });
      const discoveredId = 'cs_phase3_discovered';

      sessionsList.mockResolvedValue({
        data: [
          validSession({
            id: discoveredId,
            status: 'open',
            metadata: {
              invoiceId: paid.invoiceId,
              attemptId: paid.siblingAttemptId,
              period: PERIOD_LABEL,
            },
          }),
          validSession({
            id: 'cs_phase3_unrelated',
            status: 'open',
            metadata: {
              invoiceId: paid.invoiceId,
              attemptId: randomUUID(),
              period: PERIOD_LABEL,
            },
          }),
        ],
      });
      sessionsRetrieve.mockResolvedValue(
        validSession({
          id: discoveredId,
          status: 'open',
          metadata: {
            invoiceId: paid.invoiceId,
            attemptId: paid.siblingAttemptId,
            period: PERIOD_LABEL,
          },
        }),
      );
      sessionsExpire.mockResolvedValue(
        validSession({
          id: discoveredId,
          status: 'expired',
          metadata: {
            invoiceId: paid.invoiceId,
            attemptId: paid.siblingAttemptId,
            period: PERIOD_LABEL,
          },
        }),
      );

      const result = await sessionCleanup!.processDue(`phase3-worker-${SUITE_ID}`, 20);

      expect(result.expired).toBe(1);
      expect(result.needsReview).toBe(0);
      expect(result.retryable).toBe(0);
      expect(sessionsList).toHaveBeenCalled();
      expect(sessionsExpire).toHaveBeenCalledWith(discoveredId);
      expect(sessionsCreate).not.toHaveBeenCalled();

      const sibling = await loadCleanupAttempt(paid.siblingAttemptId);
      expect(sibling.stripeCheckoutSessionId).toBe(discoveredId);
      expect(sibling.sessionCleanupStatus).toBe(SESSION_CLEANUP_STATUS_COMPLETED);
      expect(sibling.sessionCleanupCompletedAt).not.toBeNull();
      expect(sibling.sessionCleanupOwnerId).toBeNull();

      // Paid facts untouched (status stays finalized; paidAt is the paid marker).
      const invoice = await prisma!.billingInvoice.findUniqueOrThrow({
        where: { id: paid.invoiceId },
      });
      expect(invoice.paidAt).not.toBeNull();
      expect(invoice.settlementAttemptId).toBe(paid.winnerAttemptId);
      expect(invoice.allocatedMicros).toBe(AMOUNT_MICROS);
      expect(invoice.status).toBe('finalized');
    });

    it('late ID discovery with empty list retains needs_review and never recreates', async () => {
      const paid = await seedPaidInvoiceWithSibling({
        siblingSessionId: null,
        siblingStatus: 'failed',
      });
      sessionsList.mockResolvedValue({ data: [] });

      const result = await sessionCleanup!.processDue(`phase3-worker-${SUITE_ID}`, 20);

      expect(result.needsReview).toBe(1);
      expect(result.expired).toBe(0);
      expect(sessionsExpire).not.toHaveBeenCalled();
      expect(sessionsCreate).not.toHaveBeenCalled();

      const sibling = await loadCleanupAttempt(paid.siblingAttemptId);
      expect(sibling.stripeCheckoutSessionId).toBeNull();
      expect(sibling.sessionCleanupStatus).toBe(SESSION_CLEANUP_STATUS_NEEDS_REVIEW);
      expect(sibling.sessionCleanupCompletedAt).toBeNull();
    });

    it('concurrent processDue lease/CAS: only one worker expires and completes the sibling', async () => {
      const sessionId = 'cs_phase3_fenced';
      const paid = await seedPaidInvoiceWithSibling({
        siblingSessionId: sessionId,
        siblingStatus: 'failed',
      });

      const openSession = validSession({
        id: sessionId,
        status: 'open',
        metadata: {
          invoiceId: paid.invoiceId,
          attemptId: paid.siblingAttemptId,
          period: PERIOD_LABEL,
        },
      });
      const expiredSession = { ...openSession, status: 'expired' };
      sessionsRetrieve.mockResolvedValue(openSession);
      sessionsExpire.mockResolvedValue(expiredSession);

      // Two workers discover the same due row; lease CAS admits exactly one owner.
      const [a, b] = await Promise.all([
        sessionCleanup!.processDue(`phase3-worker-a-${SUITE_ID}`, 20),
        sessionCleanup!.processDue(`phase3-worker-b-${SUITE_ID}`, 20),
      ]);

      const completed = a.expired + b.expired + a.alreadyClosed + b.alreadyClosed;
      expect(completed).toBe(1);
      expect(a.needsReview + b.needsReview).toBe(0);
      expect(sessionsCreate).not.toHaveBeenCalled();
      // At most one expire under exclusive lease (winner may expire; loser skips).
      expect(sessionsExpire.mock.calls.length).toBe(1);
      expect(sessionsExpire).toHaveBeenCalledWith(sessionId);

      const sibling = await loadCleanupAttempt(paid.siblingAttemptId);
      expect(sibling.stripeCheckoutSessionId).toBe(sessionId);
      expect(sibling.sessionCleanupStatus).toBe(SESSION_CLEANUP_STATUS_COMPLETED);
      expect(sibling.sessionCleanupCompletedAt).not.toBeNull();
      expect(sibling.sessionCleanupOwnerId).toBeNull();

      const invoice = await prisma!.billingInvoice.findUniqueOrThrow({
        where: { id: paid.invoiceId },
      });
      expect(invoice.paidAt).not.toBeNull();
      expect(invoice.settlementAttemptId).toBe(paid.winnerAttemptId);
      expect(invoice.allocatedMicros).toBe(AMOUNT_MICROS);
    });
  });

  // ── BILL-020: worker tick backlog + terminal predicate + health aggregate ──

  describe('BILL-020 worker tick backlog vs terminal review and health aggregate', () => {
    it('cleanup needs_review backlog fails the worker tick (not a HealthService override)', async () => {
      const paid = await seedPaidInvoiceWithSibling({
        siblingSessionId: 'cs_phase3_review',
        siblingStatus: 'failed',
        cleanup: {
          sessionCleanupStatus: SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
          sessionCleanupOwnerId: null,
          sessionCleanupLeaseExpiresAt: null,
          sessionCleanupRetryCount: 5,
        },
      });
      expect(paid.siblingAttemptId).toBeTruthy();

      await billingWorker!.tick();

      const hb = await latestWorkerHeartbeat();
      expect(hb?.status).toBe('failed');

      const ready = await health!.ready();
      expect(ready.checks.billingWorker.enabled).toBe(true);
      expect(ready.checks.billingWorker.status).toBe('failed');
      expect(ready.checks.billingWorker.needsReviewCount).toBeGreaterThanOrEqual(1);
    });

    it('safe terminal no-funds (exact type+code, never dispatched) keeps tick healthy', async () => {
      const seed = await seedUserAccountInvoice({ paid: true });
      const attemptId = randomUUID();
      await prisma!.billingPaymentAttempt.create({
        data: {
          id: attemptId,
          invoiceId: seed.invoiceId,
          method: 'stripe',
          status: 'succeeded',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
          stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
          succeededAt: new Date(),
          allocatedAt: new Date(),
          // This fixture exercises auto-subscription worker classification, not
          // missing Checkout Session recovery. Keep the already-paid source
          // attempt out of the independent cleanup stage.
          sessionCleanupStatus: SESSION_CLEANUP_STATUS_COMPLETED,
          sessionCleanupCompletedAt: new Date(),
        },
      });
      await markInvoicePaid(seed.invoiceId, attemptId);

      const intent = await prisma!.billingAutoSubscriptionIntent.create({
        data: {
          billingAccountId: seed.accountId,
          sourceInvoiceId: seed.invoiceId,
          sourceAttemptId: attemptId,
          planVersionId: seed.planId,
          stripeCustomerId: STRIPE_CUSTOMER,
          effectivePeriodStart: PERIOD_END,
          effectivePeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
          unitAmountCents: AMOUNT_CENTS,
          currency: 'usd',
          status: 'needs_review',
          operationIdempotencyKey: `phase3-auto-sub-${SUITE_ID}-${attemptId}`,
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        },
      });
      const fields = {
        status: intent.status,
        lastErrorType: intent.lastErrorType,
        lastErrorCode: intent.lastErrorCode,
        dispatchedAt: intent.dispatchedAt,
        stripeSubscriptionId: intent.stripeSubscriptionId,
      };
      expect(isSafeTerminalNoFundsIntent(fields)).toBe(true);
      expect(isUnresolvedAutoSubNeedsReviewIntent(fields)).toBe(false);
      expect(classifyAutoSubNeedsReviewOutcome(fields)).toBe('terminal_no_funds_review');

      // Shared unresolved WHERE must exclude this complete safe terminal row.
      const unresolvedCount = await prisma!.billingAutoSubscriptionIntent.count({
        where: prismaWhereUnresolvedAutoSubNeedsReview() as never,
      });
      expect(unresolvedCount).toBe(0);

      await billingWorker!.tick();

      const hb = await latestWorkerHeartbeat();
      expect(hb?.status).toBe('healthy');

      const ready = await health!.ready();
      expect(ready.checks.billingWorker.status).toBe('healthy');
      // Terminal no-funds remains countable on readiness without demoting healthy.
      expect(ready.checks.billingWorker.needsReviewCount).toBeGreaterThanOrEqual(1);
    });

    async function seedPaidAttemptAndIntent(
      overrides: {
        lastErrorType?: string | null;
        lastErrorCode?: string | null;
        dispatchedAt?: Date | null;
        stripeSubscriptionId?: string | null;
        status?: 'needs_review' | 'pending' | 'in_flight';
        keySuffix?: string;
      } = {},
    ): Promise<{ accountId: string; attemptId: string }> {
      const seed = await seedUserAccountInvoice({ paid: true });
      const attemptId = randomUUID();
      await prisma!.billingPaymentAttempt.create({
        data: {
          id: attemptId,
          invoiceId: seed.invoiceId,
          method: 'stripe',
          status: 'succeeded',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
          stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
          succeededAt: new Date(),
          allocatedAt: new Date(),
          // This helper is for auto-subscription classification cases; the
          // source Checkout cleanup has already completed.
          sessionCleanupStatus: SESSION_CLEANUP_STATUS_COMPLETED,
          sessionCleanupCompletedAt: new Date(),
        },
      });
      await markInvoicePaid(seed.invoiceId, attemptId);
      await prisma!.billingAutoSubscriptionIntent.create({
        data: {
          billingAccountId: seed.accountId,
          sourceInvoiceId: seed.invoiceId,
          sourceAttemptId: attemptId,
          planVersionId: seed.planId,
          stripeCustomerId: STRIPE_CUSTOMER,
          effectivePeriodStart: PERIOD_END,
          effectivePeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
          unitAmountCents: AMOUNT_CENTS,
          currency: 'usd',
          status: overrides.status ?? 'needs_review',
          operationIdempotencyKey: `phase3-auto-sub-${overrides.keySuffix ?? 'x'}-${SUITE_ID}-${attemptId}`,
          lastErrorType: overrides.lastErrorType ?? null,
          lastErrorCode: overrides.lastErrorCode ?? null,
          dispatchedAt: overrides.dispatchedAt ?? null,
          stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
        },
      });
      return { accountId: seed.accountId, attemptId };
    }

    it('B4: both lastErrorType and lastErrorCode null remain unresolved and fail the tick', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: null,
        lastErrorCode: null,
        keySuffix: 'both-null',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: null,
          lastErrorCode: null,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      ).toBe(false);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
      expect((await health!.ready()).checks.billingWorker.status).toBe('failed');
    });

    it('B4: one null label (type set, code null) remains unresolved and fails the tick', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: null,
        keySuffix: 'code-null',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: null,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      ).toBe(false);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
    });

    it('B4: one null label (code set, type null) remains unresolved and fails the tick', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: null,
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
        keySuffix: 'type-null',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: null,
          lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      ).toBe(false);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
    });

    it('B4: exact labels with dispatchedAt set remain unresolved and fail the tick', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
        dispatchedAt: new Date('2026-09-18T12:00:00.000Z'),
        keySuffix: 'dispatched',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
          dispatchedAt: new Date('2026-09-18T12:00:00.000Z'),
          stripeSubscriptionId: null,
        }),
      ).toBe(false);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
    });

    it('B4: exact labels with stripeSubscriptionId bound remain unresolved and fail the tick', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
        stripeSubscriptionId: 'sub_bound_phase3',
        keySuffix: 'sub-bound',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
          dispatchedAt: null,
          stripeSubscriptionId: 'sub_bound_phase3',
        }),
      ).toBe(false);
      expect(
        isUnresolvedAutoSubNeedsReviewIntent({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
          dispatchedAt: null,
          stripeSubscriptionId: 'sub_bound_phase3',
        }),
      ).toBe(true);

      const unresolvedCount = await prisma!.billingAutoSubscriptionIntent.count({
        where: prismaWhereUnresolvedAutoSubNeedsReview() as never,
      });
      expect(unresolvedCount).toBe(1);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
    });

    it('B4: partial labels (exact type, wrong code) remain unresolved and fail the tick', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: 'pm_save_error',
        keySuffix: 'partial-code',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: 'pm_save_error',
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      ).toBe(false);
      expect(
        classifyAutoSubNeedsReviewOutcome({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: 'pm_save_error',
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      ).toBe('needs_review');

      const unresolvedCount = await prisma!.billingAutoSubscriptionIntent.count({
        where: prismaWhereUnresolvedAutoSubNeedsReview() as never,
      });
      expect(unresolvedCount).toBe(1);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
    });

    it('paid recurring invoice renewal is not a cleanup candidate (no list/retrieve/expire, no backlog)', async () => {
      // Runner-visible coverage: normal Stripe invoice renewal (invoice id +
      // subscription id, no Checkout Session) must not enter cleanup discovery
      // or create session-cleanup backlog. Stripe source is not modified.
      expect(RECURRING_STRIPE_INVOICE_RENEWAL_WHERE).toBeDefined();

      const seed = await seedUserAccountInvoice({ paid: true });
      const attemptId = randomUUID();
      const renewalSubId = `sub_phase3_renewal_${attemptId.slice(0, 8)}`;
      await prisma!.billingPaymentAttempt.create({
        data: {
          id: attemptId,
          invoiceId: seed.invoiceId,
          method: 'stripe',
          status: 'succeeded',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
          stripeChargeKind: STRIPE_CHARGE_KIND_FIXED_FEE,
          stripeCheckoutSessionId: null,
          stripeInvoiceId: `in_phase3_renewal_${attemptId.slice(0, 8)}`,
          stripeSubscriptionId: renewalSubId,
          succeededAt: new Date(),
          allocatedAt: new Date(),
          // Eligible-looking cleanup columns, but recurring shape excludes it.
          sessionCleanupStatus: null,
          sessionCleanupCompletedAt: null,
          sessionCleanupNextRetryAt: null,
          sessionCleanupOwnerId: null,
        } as never,
      });
      await markInvoicePaid(seed.invoiceId, attemptId);
      // Account already has a live subscription binding — recovery must not
      // enqueue auto-sub work for this fixed-fee renewal shape.
      await prisma!.billingAccount.update({
        where: { id: seed.accountId },
        data: {
          stripeSubscriptionId: renewalSubId,
        },
      });

      sessionsList.mockClear();
      sessionsRetrieve.mockClear();
      sessionsExpire.mockClear();

      const cleanupResult = await sessionCleanup!.processDue(`phase3-renewal-${SUITE_ID}`, 20);
      expect(cleanupResult.attempted).toBe(0);
      expect(cleanupResult.needsReview).toBe(0);
      expect(cleanupResult.retryable).toBe(0);
      expect(sessionsList).not.toHaveBeenCalled();
      expect(sessionsRetrieve).not.toHaveBeenCalled();
      expect(sessionsExpire).not.toHaveBeenCalled();

      sessionsList.mockClear();
      sessionsRetrieve.mockClear();
      sessionsExpire.mockClear();

      await billingWorker!.tick();
      // No cleanup backlog from the renewal attempt; exclusion keeps tick free of
      // session-cleanup unresolved work (runner-visible cleanup exclusion).
      const cleanupRows = await prisma!.billingPaymentAttempt.count({
        where: {
          id: attemptId,
          sessionCleanupStatus: {
            in: ['pending', 'in_flight', 'needs_review'],
          },
        } as never,
      });
      expect(cleanupRows).toBe(0);
      // Worker tick must not invent cleanup provider calls or demote health solely
      // because a paid recurring renewal row exists.
      expect(sessionsList).not.toHaveBeenCalled();
      expect(sessionsRetrieve).not.toHaveBeenCalled();
      expect(sessionsExpire).not.toHaveBeenCalled();
      expect((await latestWorkerHeartbeat())?.status).toBe('healthy');
      expect((await health!.ready()).checks.billingWorker.status).toBe('healthy');
    });

    it('B4: complete safe terminal via helper keeps tick healthy (exact type+code, fences null)', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
        dispatchedAt: null,
        stripeSubscriptionId: null,
        keySuffix: 'safe-complete',
      });
      expect(
        isSafeTerminalNoFundsIntent({
          status: 'needs_review',
          lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
          lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
          dispatchedAt: null,
          stripeSubscriptionId: null,
        }),
      ).toBe(true);
      expect(
        await prisma!.billingAutoSubscriptionIntent.count({
          where: prismaWhereUnresolvedAutoSubNeedsReview() as never,
        }),
      ).toBe(0);

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('healthy');
      const ready = await health!.ready();
      expect(ready.checks.billingWorker.status).toBe('healthy');
      expect(ready.checks.billingWorker.needsReviewCount).toBeGreaterThanOrEqual(1);
    });

    it('auto-sub pending backlog fails the worker tick', async () => {
      const seed = await seedUserAccountInvoice({ paid: true });
      const attemptId = randomUUID();
      await prisma!.billingPaymentAttempt.create({
        data: {
          id: attemptId,
          invoiceId: seed.invoiceId,
          method: 'stripe',
          status: 'succeeded',
          amountMicros: AMOUNT_MICROS,
          currency: 'USD',
          stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
          succeededAt: new Date(),
          allocatedAt: new Date(),
        },
      });
      await markInvoicePaid(seed.invoiceId, attemptId);
      await prisma!.billingAutoSubscriptionIntent.create({
        data: {
          billingAccountId: seed.accountId,
          sourceInvoiceId: seed.invoiceId,
          sourceAttemptId: attemptId,
          planVersionId: seed.planId,
          stripeCustomerId: STRIPE_CUSTOMER,
          effectivePeriodStart: PERIOD_END,
          effectivePeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
          unitAmountCents: AMOUNT_CENTS,
          currency: 'usd',
          status: 'pending',
          operationIdempotencyKey: `phase3-auto-sub-pending-${SUITE_ID}-${attemptId}`,
        },
      });

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
      expect((await health!.ready()).checks.billingWorker.status).toBe('failed');
    });

    it('auto-sub in_flight backlog fails the worker tick (uncertain/in-flight risk)', async () => {
      await seedPaidAttemptAndIntent({
        status: 'in_flight',
        lastErrorType: 'uncertain',
        lastErrorCode: 'pm_save_error',
        keySuffix: 'in-flight',
      });

      await billingWorker!.tick();
      expect((await latestWorkerHeartbeat())?.status).toBe('failed');
      expect((await health!.ready()).checks.billingWorker.status).toBe('failed');
    });

    it('B3: healthy-wins aggregation is unchanged even when cleanup backlog rows exist', async () => {
      // Seed unresolved cleanup backlog WITHOUT running the worker tick.
      await seedPaidInvoiceWithSibling({
        siblingSessionId: 'cs_phase3_hb_wins',
        siblingStatus: 'failed',
        cleanup: {
          sessionCleanupStatus: SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
          sessionCleanupOwnerId: null,
          sessionCleanupLeaseExpiresAt: null,
          sessionCleanupRetryCount: 3,
        },
      });
      // Fresh healthy row must win over a fresh failed sibling — HealthService
      // must not override based on global backlog counts.
      await upsertHealthyHeartbeat(`phase3-hb-wins-healthy-${SUITE_ID}`);
      await upsertFailedHeartbeat(`phase3-hb-wins-failed-${SUITE_ID}`);

      const ready = await health!.ready();
      expect(ready.checks.billingWorker.status).toBe('healthy');
      expect(ready.checks.billingWorker.needsReviewCount).toBeGreaterThanOrEqual(1);
    });

    it('B3: healthy-wins still holds when only safe terminal auto-sub review is countable', async () => {
      await seedPaidAttemptAndIntent({
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
        keySuffix: 'b3-safe-countable',
      });
      // Do not run the worker tick — seed heartbeats only so HealthService
      // aggregation is isolated from tick classification.
      await upsertFailedHeartbeat(`phase3-b3-failed-${SUITE_ID}`);
      await upsertHealthyHeartbeat(`phase3-b3-healthy-${SUITE_ID}`);

      const ready = await health!.ready();
      expect(ready.checks.billingWorker.status).toBe('healthy');
      expect(ready.checks.billingWorker.needsReviewCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  function validSession(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cs_phase3_default',
      status: 'open',
      mode: 'payment',
      currency: 'usd',
      amount_total: AMOUNT_CENTS,
      customer: STRIPE_CUSTOMER,
      client_reference_id: 'will-be-overridden',
      metadata: {
        invoiceId: 'will-be-overridden',
        attemptId: 'will-be-overridden',
        period: PERIOD_LABEL,
      },
      ...overrides,
      // Keep client_reference aligned with metadata.invoiceId when callers set it.
      ...(overrides.metadata &&
      typeof overrides.metadata === 'object' &&
      overrides.metadata !== null &&
      'invoiceId' in (overrides.metadata as object)
        ? {
            client_reference_id:
              (overrides as { client_reference_id?: string }).client_reference_id ??
              (overrides.metadata as { invoiceId: string }).invoiceId,
          }
        : {}),
    };
  }

  type CleanupAttemptSnapshot = {
    stripeCheckoutSessionId: string | null;
    sessionCleanupStatus: string | null;
    sessionCleanupCompletedAt: Date | null;
    sessionCleanupOwnerId: string | null;
  };

  async function loadCleanupAttempt(id: string): Promise<CleanupAttemptSnapshot> {
    const row = await prisma!.billingPaymentAttempt.findUniqueOrThrow({ where: { id } });
    return row as unknown as CleanupAttemptSnapshot;
  }

  async function markInvoicePaid(invoiceId: string, settlementAttemptId: string): Promise<void> {
    await prisma!.billingInvoice.update({
      where: { id: invoiceId },
      data: {
        // Paid is marked by paidAt/settlement/coverage — status stays finalized.
        paidAt: new Date('2026-09-03T00:00:00.000Z'),
        paidVia: 'stripe',
        settlementAttemptId,
        allocatedMicros: AMOUNT_MICROS,
      },
    });
  }

  async function seedUserAccountInvoice(opts: { paid?: boolean } = {}): Promise<SeedBundle> {
    const userId = randomUUID();
    const token = `tok_${SUITE_ID}_${userId.slice(0, 8)}`;
    const socialId = `phase3-${SUITE_ID}-${userId.slice(0, 8)}`;
    const email = `phase3-${userId.slice(0, 8)}@example.test`;
    iamSessions.set(token, { openfortUserId: socialId, email });

    await prisma!.user.create({
      data: {
        id: userId,
        socialProvider: 'test',
        socialId,
        email,
      },
    });

    const accountId = randomUUID();
    await prisma!.billingAccount.create({
      data: {
        id: accountId,
        userId,
        stripeCustomerId: STRIPE_CUSTOMER,
      },
    });

    const planId = randomUUID();
    await prisma!.billingPlanVersion.create({
      data: {
        id: planId,
        code: `phase3-plan-${planId.slice(0, 8)}`,
        version: 1,
        name: 'Phase3 E2E Plan',
        effectiveFrom: PERIOD_START,
        monthlyFeeMicros: AMOUNT_MICROS,
      },
    });

    const invoiceId = randomUUID();
    await prisma!.billingInvoice.create({
      data: {
        id: invoiceId,
        billingAccountId: accountId,
        planVersionId: planId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        status: 'finalized',
        currency: 'USD',
        grossOutboundMicros: 0n,
        billableOutboundMicros: 0n,
        apiCalls: 0n,
        activeWallets: 0,
        monthlyFeeMicros: AMOUNT_MICROS,
        outboundOverageMicros: 0n,
        apiOverageMicros: 0n,
        walletOverageMicros: 0n,
        totalMicros: AMOUNT_MICROS,
        snapshotJson: { phase3: true },
        snapshotHash: `phase3-${invoiceId.slice(0, 8)}`,
        finalizedAt: new Date('2026-09-02T00:00:00.000Z'),
        ...(opts.paid
          ? {
              paidAt: new Date('2026-09-03T00:00:00.000Z'),
              paidVia: 'stripe' as const,
              allocatedMicros: AMOUNT_MICROS,
            }
          : {}),
      },
    });

    return { userId, token, accountId, planId, invoiceId };
  }

  async function seedPaidInvoiceWithSibling(args: {
    siblingSessionId: string | null;
    siblingStatus: 'pending' | 'failed' | 'succeeded';
    cleanup?: {
      sessionCleanupStatus: string | null;
      sessionCleanupOwnerId: string | null;
      sessionCleanupLeaseExpiresAt: Date | null;
      sessionCleanupRetryCount: number;
    };
  }): Promise<{
    invoiceId: string;
    winnerAttemptId: string;
    siblingAttemptId: string;
    accountId: string;
  }> {
    const base = await seedUserAccountInvoice();
    const winnerAttemptId = randomUUID();
    const siblingAttemptId = randomUUID();

    // Settlement winner is already complete on the provider side; mark cleanup
    // done so processDue only sees the open sibling under test (not the winner).
    await prisma!.billingPaymentAttempt.create({
      data: {
        id: winnerAttemptId,
        invoiceId: base.invoiceId,
        method: 'stripe',
        status: 'succeeded',
        amountMicros: AMOUNT_MICROS,
        currency: 'USD',
        stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
        stripeCheckoutSessionId: `cs_phase3_winner_${winnerAttemptId.slice(0, 8)}`,
        succeededAt: new Date('2026-09-03T00:00:00.000Z'),
        allocatedAt: new Date('2026-09-03T00:00:00.000Z'),
        sessionCleanupStatus: SESSION_CLEANUP_STATUS_COMPLETED,
        sessionCleanupCompletedAt: new Date('2026-09-03T00:05:00.000Z'),
      } as never,
    });

    await markInvoicePaid(base.invoiceId, winnerAttemptId);

    // sessionCleanup* columns are on the live schema; cast keeps this suite
    // resilient if a local generated client lags slightly behind migrations.
    await prisma!.billingPaymentAttempt.create({
      data: {
        id: siblingAttemptId,
        invoiceId: base.invoiceId,
        method: 'stripe',
        status: args.siblingStatus,
        amountMicros: AMOUNT_MICROS,
        currency: 'USD',
        stripeChargeKind: STRIPE_CHARGE_KIND_FULL,
        stripeCheckoutSessionId: args.siblingSessionId,
        ...(args.siblingStatus === 'failed'
          ? {
              failedAt: new Date('2026-09-03T01:00:00.000Z'),
              failureCode: 'superseded_by_settlement',
              failureMessage: 'Sibling open after paid (fixture)',
            }
          : {}),
        sessionCleanupStatus: args.cleanup?.sessionCleanupStatus ?? null,
        sessionCleanupOwnerId: args.cleanup?.sessionCleanupOwnerId ?? null,
        sessionCleanupLeaseExpiresAt: args.cleanup?.sessionCleanupLeaseExpiresAt ?? null,
        sessionCleanupRetryCount: args.cleanup?.sessionCleanupRetryCount ?? 0,
        sessionCleanupNextRetryAt: null,
        sessionCleanupCompletedAt: null,
      } as never,
    });

    return {
      invoiceId: base.invoiceId,
      winnerAttemptId,
      siblingAttemptId,
      accountId: base.accountId,
    };
  }

  async function latestWorkerHeartbeat(): Promise<{ status: string } | null> {
    const rows = await prisma!.billingWorkerHeartbeat.findMany({
      orderBy: { lastHeartbeatAt: 'desc' },
      take: 1,
      select: { status: true },
    });
    return rows[0] ?? null;
  }

  async function upsertFailedHeartbeat(workerId: string): Promise<void> {
    const now = new Date();
    await prisma!.billingWorkerHeartbeat.upsert({
      where: { workerId },
      create: {
        workerId,
        status: 'failed',
        lastHeartbeatAt: now,
        lastFailureAt: now,
        consecutiveFailures: 1,
      },
      update: {
        status: 'failed',
        lastHeartbeatAt: now,
        lastFailureAt: now,
        consecutiveFailures: 1,
      },
    });
  }

  async function upsertHealthyHeartbeat(workerId: string): Promise<void> {
    const now = new Date();
    await prisma!.billingWorkerHeartbeat.upsert({
      where: { workerId },
      create: {
        workerId,
        status: 'healthy',
        lastHeartbeatAt: now,
        lastStartedAt: now,
        lastSuccessAt: now,
        consecutiveFailures: 0,
      },
      update: {
        status: 'healthy',
        lastHeartbeatAt: now,
        lastStartedAt: now,
        lastSuccessAt: now,
        lastFailureAt: null,
        consecutiveFailures: 0,
      },
    });
  }

  async function cleanDatabase(): Promise<void> {
    if (!prisma || !dbIdentityVerified) {
      throw new Error('cleanDatabase refused: prisma missing or DB identity unverified');
    }

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
    await prisma.billingAutoSubRecoveryCursor.deleteMany();
    await prisma.billingWorkerHeartbeat.deleteMany();
    await prisma.billingAccount.deleteMany();
    // Suite-owned plan versions only (codes embed phase3-plan-).
    await prisma.billingPlanVersion.deleteMany({
      where: { code: { startsWith: 'phase3-plan-' } },
    });

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

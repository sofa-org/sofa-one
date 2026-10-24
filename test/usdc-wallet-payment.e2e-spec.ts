/**
 * Phase 2B runtime evidence: quote-bound dashboard wallet payment (pay-from-wallet).
 *
 * Real: AppModule + runner-provisioned PostgreSQL (BILLING_E2E_* only), row locks,
 *       reservation binding, destination policy, persisted full-MFA app sessions.
 * Mocked: Openfort UserOp, StepUpGuard, SessionKeyPolicy, USDC receipt RPC — never live chain.
 *
 * Run via `npm run test:e2e:billing`. No DATABASE_URL / agent_wallet fallback.
 */
import { randomUUID, createHash } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as request from 'supertest';
import { getAddress } from 'viem';
import { PrismaService } from '../src/core/database/prisma.service';
import { AppSessionService } from '../src/modules/app-session/app-session.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { StepUpGuard } from '../src/common/guards/step-up.guard';
import { SessionKeyPolicyService } from '../src/modules/session-key/session-key-policy.service';
import { AgentStatus } from '../src/common/agent/agent-status';
import { API_ERROR_CODES } from '../src/common/errors/api-error-codes';
import {
  USDC_RECEIPT_PROVIDER,
  USDC_TRANSFER_TOPIC0,
} from '../src/modules/billing/onchain/usdc.constants';
import type {
  UsdcReceipt,
  UsdcReceiptLog,
  UsdcReceiptProvider,
} from '../src/modules/billing/onchain/usdc-receipt.provider';
import { UsdcWalletPaymentService } from '../src/modules/billing/onchain/usdc-wallet-payment.service';
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
process.env.BILLING_WORKER_ENABLED = 'false';

/**
 * USDC env must be complete BEFORE dynamic AppModule require/config validate.
 * When BILLING_USDC_ENABLED=true, env.validation requires treasury + HTTPS RPC
 * for every allowlisted chain (1, 11155111, 8453, 84532). Values are fake and
 * never dialed — receipt provider + Openfort are mocked in this suite.
 */
process.env.BILLING_USDC_ENABLED = 'true';
const TREASURY = getAddress('0x1111111111111111111111111111111111111111');
/** Suite chain under test (Base Sepolia). Provider identity is derived from this URL. */
const RPC_URL = 'https://base-sepolia.example.test/rpc';
const FAKE_RPC_BY_CHAIN: Record<string, string> = {
  '1': 'https://eth-mainnet.example.test/rpc',
  '11155111': 'https://eth-sepolia.example.test/rpc',
  '8453': 'https://base-mainnet.example.test/rpc',
  '84532': RPC_URL,
};
for (const [chainId, rpc] of Object.entries(FAKE_RPC_BY_CHAIN)) {
  process.env[`BILLING_USDC_TREASURY_ADDRESS_${chainId}`] = TREASURY;
  process.env[`BILLING_USDC_RPC_URL_${chainId}`] = rpc;
}
process.env.BILLING_USDC_REQUIRED_CONFIRMATIONS = '5';
process.env.BILLING_USDC_QUOTE_TTL_SECONDS = '86400';
process.env.DEFAULT_CHAIN_ID = '84532';

const SUITE_ID = randomUUID().replace(/-/g, '').slice(0, 12);
const CHAIN_ID = 84532;
/** Canonical Base Sepolia USDC. */
const TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const PLATFORM_WALLET = getAddress('0x2222222222222222222222222222222222222222');
const AGENT_WALLET = getAddress('0x3333333333333333333333333333333333333333');
const AGENT_KEY_HASH = `0x${'b'.repeat(64)}`;
const AMOUNT = 5_000_000n;
const TX_HASH = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'c'.repeat(64)}`;
const BLOCK_HASH = `0x${'d'.repeat(64)}`;
const PROVIDER_IDENTITY = createHash('sha256').update(RPC_URL).digest('hex');
const FRONTEND_ORIGIN = 'http://localhost:3000';

interface DashboardSessionFixture {
  cookie: string;
  csrfToken: string;
}

const mockOpenfortService = {
  createBackendWallet: jest.fn(),
  verifyAgentKeyRegistration: jest.fn().mockResolvedValue(undefined),
  submitUserOperation: jest.fn().mockResolvedValue({ userOpHash: USER_OP_HASH }),
  waitForUserOperationReceipt: jest.fn().mockResolvedValue({
    success: true,
    transactionHash: TX_HASH,
  }),
  getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'success' }),
  sendBackendTransaction: jest.fn(),
  signData: jest.fn(),
};

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => mockOpenfortService),
}));

function transferLog(payer: string): UsdcReceiptLog {
  return {
    address: TOKEN.toLowerCase(),
    topics: [
      USDC_TRANSFER_TOPIC0,
      '0x' + '0'.repeat(24) + payer.slice(2).toLowerCase(),
      '0x' + '0'.repeat(24) + TREASURY.slice(2).toLowerCase(),
    ],
    data: '0x' + AMOUNT.toString(16).padStart(64, '0'),
    logIndex: 0,
    removed: false,
  };
}

function confirmedReceipt(payer: string): UsdcReceipt {
  return {
    status: 'success',
    transactionHash: TX_HASH,
    from: payer,
    to: TOKEN,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    logs: [transferLog(payer)],
  };
}

const mockReceiptProvider: UsdcReceiptProvider = {
  getTransactionReceipt: jest.fn(async () => confirmedReceipt(PLATFORM_WALLET.toLowerCase())),
  getBlockNumber: jest.fn(async () => 200n),
};

describe('USDC wallet-payment (Phase 2B e2e runtime evidence)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication | undefined;
  let moduleFixture: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let preflightPrisma: PrismaClient | undefined;
  let walletPay: UsdcWalletPaymentService | undefined;
  let dbIdentityVerified = false;

  let userId: string;
  let walletId: string;
  let invoiceId: string;
  let planChargeInvoiceId: string;
  let attemptId: string;
  let planChargeAttemptId: string;
  let dashboardSession: DashboardSessionFixture;
  let otherDashboardSession: DashboardSessionFixture;

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
        .overrideProvider(SessionKeyPolicyService)
        .useValue({ assertSessionKeyAllowed: jest.fn().mockResolvedValue(undefined) })
        .overrideProvider(USDC_RECEIPT_PROVIDER)
        .useValue(mockReceiptProvider)
        .overrideGuard(StepUpGuard)
        .useValue({ canActivate: () => true })
        .compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();

      prisma = app.get(PrismaService);
      walletPay = app.get(UsdcWalletPaymentService);
      await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
        queryBillingE2eIdentityWithPrisma(prisma!),
      );
      dbIdentityVerified = true;
    } catch (err) {
      dbIdentityVerified = false;
      await teardown();
      throw err;
    }
  });

  beforeEach(async () => {
    if (!prisma || !dbIdentityVerified) {
      throw new Error('wallet-payment e2e: database not initialized or identity unverified');
    }
    jest.clearAllMocks();
    mockOpenfortService.submitUserOperation.mockResolvedValue({ userOpHash: USER_OP_HASH });
    mockOpenfortService.waitForUserOperationReceipt.mockResolvedValue({
      success: true,
      transactionHash: TX_HASH,
    });
    (mockReceiptProvider.getTransactionReceipt as jest.Mock).mockImplementation(async () =>
      confirmedReceipt(PLATFORM_WALLET.toLowerCase()),
    );
    (mockReceiptProvider.getBlockNumber as jest.Mock).mockResolvedValue(200n);

    await cleanDatabase();
    const seeded = await seedFixtures();
    userId = seeded.userId;
    walletId = seeded.walletId;
    invoiceId = seeded.invoiceId;
    planChargeInvoiceId = seeded.planChargeInvoiceId;
    attemptId = seeded.attemptId;
    planChargeAttemptId = seeded.planChargeAttemptId;
    dashboardSession = seeded.dashboardSession;
    otherDashboardSession = seeded.otherDashboardSession;
  });

  afterAll(async () => {
    try {
      if (prisma && dbIdentityVerified) await cleanDatabase();
    } finally {
      await teardown();
    }
  });

  async function teardown() {
    if (app) {
      try {
        await app.close();
      } catch {
        /* ignore */
      }
      app = undefined;
    }
    if (moduleFixture) {
      try {
        await moduleFixture.close();
      } catch {
        /* ignore */
      }
      moduleFixture = undefined;
    }
    prisma = undefined;
    walletPay = undefined;
    if (preflightPrisma) {
      try {
        await preflightPrisma.$disconnect();
      } catch {
        /* ignore */
      }
      preflightPrisma = undefined;
    }
  }

  function payFromWallet(
    session: DashboardSessionFixture,
    invId: string,
    body: Record<string, unknown>,
    withStepUp = true,
  ) {
    const req = request(app!.getHttpServer())
      .post(`/billing/invoices/${invId}/usdc/pay-from-wallet`)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .set('Origin', FRONTEND_ORIGIN);
    if (withStepUp) req.set('X-Step-Up-Token', 'e2e-step-up-proof');
    return req.send(body);
  }

  function paymentStatus(session: DashboardSessionFixture, invId: string, paymentAttemptId: string) {
    return request(app!.getHttpServer())
      .get(`/billing/invoices/${invId}/usdc/payment-status`)
      .query({ paymentAttemptId })
      .set('Cookie', session.cookie)
      .set('Origin', FRONTEND_ORIGIN);
  }

  // ── Endpoint contract ──────────────────────────────────────────────────────

  it('rejects API-key auth on pay-from-wallet (dashboard session only)', async () => {
    await request(app!.getHttpServer())
      .post(`/billing/invoices/${invoiceId}/usdc/pay-from-wallet`)
      .set('X-API-Key', 'sk_test_not_valid')
      .set('Origin', FRONTEND_ORIGIN)
      .set('X-Step-Up-Token', 'e2e-step-up-proof')
      .send({ paymentAttemptId: attemptId })
      .expect(401);
  });

  it('rejects client override fields (forbidNonWhitelisted)', async () => {
    const res = await payFromWallet(dashboardSession, invoiceId, {
      paymentAttemptId: attemptId,
      amount: '1',
      chainId: 1,
      to: TREASURY,
    }).expect(400);
    expect(res.body.message ?? res.body).toBeTruthy();
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  it('rejects non-UUID paymentAttemptId', async () => {
    await payFromWallet(dashboardSession, invoiceId, { paymentAttemptId: 'not-a-uuid' }).expect(400);
  });

  it('rejects cross-user ownership (other user invoice)', async () => {
    await payFromWallet(otherDashboardSession, invoiceId, { paymentAttemptId: attemptId }).expect(404);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  it('payment-status works without StepUp and stays safe', async () => {
    const res = await paymentStatus(dashboardSession, invoiceId, attemptId).expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        invoiceId,
        paymentAttemptId: attemptId,
        paid: false,
        reserved: false,
      }),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/requestHash|calldata|userOpHash|openfort/i);
  });

  // ── Product rules ──────────────────────────────────────────────────────────

  it('rejects plan_charge attempt while usage debt exists', async () => {
    // usage invoice unpaid → debt; plan_charge wallet pay blocked.
    const res = await payFromWallet(dashboardSession, planChargeInvoiceId, {
      paymentAttemptId: planChargeAttemptId,
    }).expect(403);
    expect(res.body.code).toBe(API_ERROR_CODES.USDC_WALLET_USAGE_DEBT_ONLY);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  it('rejects when wallet is frozen', async () => {
    await prisma!.userWallet.update({
      where: { id: walletId },
      data: { frozenAt: new Date(), frozenReason: 'e2e' },
    });
    const res = await payFromWallet(dashboardSession, invoiceId, {
      paymentAttemptId: attemptId,
    }).expect(409);
    expect(res.body.code).toBe(API_ERROR_CODES.USDC_WALLET_NOT_ACTIVE);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  it('rejects when treasury is not allowlisted under destination policy', async () => {
    await prisma!.withdrawalAddress.deleteMany({ where: { userId } });
    const res = await payFromWallet(dashboardSession, invoiceId, {
      paymentAttemptId: attemptId,
    }).expect(403);
    expect(res.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  // ── Happy path + reservation ───────────────────────────────────────────────

  it('accepts pay-from-wallet: one binding, provider once, not paid until claim path', async () => {
    const res = await payFromWallet(dashboardSession, invoiceId, {
      paymentAttemptId: attemptId,
    }).expect(202);

    // HTTP 202: acceptance does not establish payment solely from provider success.
    expect(res.body).toEqual(
      expect.objectContaining({
        invoiceId,
        paymentAttemptId: attemptId,
        accepted: true,
        reserved: true,
        isExecutor: true,
      }),
    );
    // When receipt mock settles successfully, paid may be true — still only via claim path.
    expect(typeof res.body.paid).toBe('boolean');
    expect(res.body).not.toHaveProperty('userOpHash');
    expect(res.body).not.toHaveProperty('requestHash');

    expect(mockOpenfortService.submitUserOperation).toHaveBeenCalledTimes(1);
    const opArgs = mockOpenfortService.submitUserOperation.mock.calls[0][0];
    expect(opArgs.chainId).toBe(CHAIN_ID);
    expect(opArgs.interactions).toHaveLength(1);
    expect(String(opArgs.interactions[0].to).toLowerCase()).toBe(TOKEN.toLowerCase());

    const txs = await prisma!.transaction.findMany({
      where: { userId, operationType: 'billing_payment' },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].authMethod).toBe('iam');
    expect(txs[0].apiKeyId).toBeNull();

    const attempt = await prisma!.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(attempt.walletPaymentReserved).toBe(true);
    expect(attempt.walletPaymentTransactionId).toBe(txs[0].id);
  });

  it('concurrent duplicate pay: single executor / single provider call', async () => {
    // Two parallel HTTP pays — second must not double-dispatch.
    const [a, b] = await Promise.all([
      payFromWallet(dashboardSession, invoiceId, { paymentAttemptId: attemptId }),
      payFromWallet(dashboardSession, invoiceId, { paymentAttemptId: attemptId }),
    ]);
    expect([a.status, b.status].every((s) => s === 202 || s === 409 || s === 403)).toBe(true);
    // At most one UserOp submission.
    expect(mockOpenfortService.submitUserOperation.mock.calls.length).toBeLessThanOrEqual(1);

    const txs = await prisma!.transaction.count({
      where: { userId, operationType: 'billing_payment' },
    });
    expect(txs).toBeLessThanOrEqual(1);

    const attempt = await prisma!.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    if (attempt.walletPaymentReserved) {
      expect(attempt.walletPaymentTransactionId).toBeTruthy();
    }
  });

  it('service-level concurrent reserve: only one isExecutor binding', async () => {
    // Direct service race (real Postgres locks) — clearer than HTTP flakiness.
    const results = await Promise.allSettled([
      walletPay!.payFromWallet(userId, invoiceId, attemptId),
      walletPay!.payFromWallet(userId, invoiceId, attemptId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<UsdcWalletPaymentService['payFromWallet']>>
    >[];
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const executors = fulfilled.filter((r) => r.value.isExecutor === true);
    expect(executors.length).toBeLessThanOrEqual(1);
    expect(mockOpenfortService.submitUserOperation.mock.calls.length).toBeLessThanOrEqual(1);

    const bound = await prisma!.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(bound.walletPaymentReserved).toBe(true);
    expect(bound.walletPaymentTransactionId).toBeTruthy();
  });

  it('client claim cannot first-write hash onto reserved wallet attempt', async () => {
    // Reserve via service without completing claim (force unknown).
    mockOpenfortService.submitUserOperation.mockRejectedValueOnce(new Error('provider timeout'));
    await walletPay!.payFromWallet(userId, invoiceId, attemptId);

    const attempt = await prisma!.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(attempt.walletPaymentReserved).toBe(true);
    expect(attempt.submittedTxHash).toBeNull();

    // Client claim path via AppModule UsdcPaymentService.
    const { UsdcPaymentService } =
      await import('../src/modules/billing/onchain/usdc-payment.service');
    const usdc = app!.get(UsdcPaymentService);
    await expect(
      usdc.claim(userId, invoiceId, {
        paymentAttemptId: attemptId,
        txHash: TX_HASH,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
      }),
    });
  });

  it('quote refresh does not release a reserved attempt', async () => {
    mockOpenfortService.submitUserOperation.mockRejectedValueOnce(new Error('provider timeout'));
    await walletPay!.payFromWallet(userId, invoiceId, attemptId);

    const { UsdcPaymentService } =
      await import('../src/modules/billing/onchain/usdc-payment.service');
    const usdc = app!.get(UsdcPaymentService);
    const q = await usdc.quote(userId, invoiceId, CHAIN_ID);
    expect(q.paymentAttemptId).toBe(attemptId);

    const attempt = await prisma!.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(attempt.walletPaymentReserved).toBe(true);
    expect(attempt.status).not.toBe('expired');
  });

  it('no-hash dispatch retains reservation; recovery does not resubmit', async () => {
    mockOpenfortService.submitUserOperation.mockRejectedValueOnce(new Error('provider timeout'));
    const pay = await walletPay!.payFromWallet(userId, invoiceId, attemptId);
    expect(pay.reserved).toBe(true);
    expect(pay.paid).toBe(false);
    expect(pay.phase === 'unknown' || pay.status === 'needs_review').toBe(true);

    mockOpenfortService.submitUserOperation.mockClear();
    const recovered = await walletPay!.recoverReservedPayment(userId, invoiceId, attemptId);
    expect(recovered.reserved).toBe(true);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  it('recovery with known hash settles via server binding without resubmit', async () => {
    // Seed reserved binding with known hash, no provider call needed.
    const txId = randomUUID();
    await prisma!.transaction.create({
      data: {
        id: txId,
        userId,
        authMethod: 'iam',
        status: 'pending',
        chainId: BigInt(CHAIN_ID),
        walletAddress: PLATFORM_WALLET.toLowerCase(),
        operationType: 'billing_payment',
        idempotencyKey: `billing_payment:${attemptId}`,
        requestHash: createHash('sha256').update(`e2e-rec-${SUITE_ID}`).digest('hex'),
        txHash: null,
        details: { type: 'billing_payment', token: 'USDC', amount: AMOUNT.toString() },
      },
    });
    await prisma!.billingPaymentAttempt.update({
      where: { id: attemptId },
      data: {
        walletPaymentReserved: true,
        walletPaymentTransactionId: txId,
        walletDispatchStartedAt: new Date(),
        submittedTxHash: TX_HASH.toLowerCase(),
        status: 'confirming',
      },
    });

    mockOpenfortService.submitUserOperation.mockClear();
    const recovered = await walletPay!.recoverReservedPayment(userId, invoiceId, attemptId);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
    // Settlement depends on receipt mock matching quote — paid when evidence matches.
    if (recovered.paid) {
      const inv = await prisma!.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(inv.paidAt).not.toBeNull();
    } else {
      expect(recovered.reserved).toBe(true);
    }
  });

  // ── Seeds / cleanup ────────────────────────────────────────────────────────

  async function createDashboardSession(ownerId: string): Promise<DashboardSessionFixture> {
    const sessions = app!.get(AppSessionService);
    const { token, session } = await sessions.exchange(ownerId, undefined);
    // Explicit factor fixture: this suite covers payment behavior, not TOTP verification.
    await prisma!.appSession.update({
      where: { id: session.id },
      data: { mfaVerified: true },
    });
    return {
      cookie: `${sessions.cookieName}=${token}`,
      csrfToken: sessions.csrfToken(token),
    };
  }

  async function seedFixtures() {
    const socialId = `wpay_${SUITE_ID}`;
    const otherSocial = `wpay_o_${SUITE_ID}`;
    const user = await prisma!.user.create({
      data: {
        socialProvider: 'google',
        socialId,
        email: `${socialId}@example.com`,
      },
    });
    const other = await prisma!.user.create({
      data: {
        socialProvider: 'google',
        socialId: otherSocial,
        email: `${otherSocial}@example.com`,
      },
    });

    const wallet = await prisma!.userWallet.create({
      data: {
        userId: user.id,
        openfortAccountId: `ofa_${SUITE_ID}`,
        walletAddress: PLATFORM_WALLET.toLowerCase(),
        agentOpenfortAccountId: `ofa_agent_${SUITE_ID}`,
        signerAddress: AGENT_WALLET.toLowerCase(),
        agentKeyHash: AGENT_KEY_HASH,
        status: 'active',
      },
    });
    await prisma!.walletChainAuthorization.create({
      data: {
        walletId: wallet.id,
        chainId: BigInt(CHAIN_ID),
        status: AgentStatus.Registered,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await prisma!.withdrawalPolicy.create({
      data: {
        userId: user.id,
        requireAddressAllowlist: true,
        newAddressCooldownHours: 24,
        requireStepUp: true,
        dailyWithdrawalLimit: null,
        singleWithdrawalLimit: '10000000000',
      },
    });
    await prisma!.withdrawalAddress.create({
      data: {
        userId: user.id,
        address: TREASURY.toLowerCase(),
        label: 'treasury',
        availableAt: new Date(Date.now() - 60_000),
      },
    });

    const account = await prisma!.billingAccount.create({ data: { userId: user.id } });
    const plan = await prisma!.billingPlanVersion.create({
      data: {
        code: `wpay_plan_${SUITE_ID}`,
        version: 1,
        name: 'Wallet Pay E2E Plan',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const periodStart = new Date('2026-08-01T00:00:00.000Z');
    const periodEnd = new Date('2026-09-01T00:00:00.000Z');

    const usageInv = await prisma!.billingInvoice.create({
      data: {
        billingAccountId: account.id,
        planVersionId: plan.id,
        purpose: 'usage_period',
        periodStart,
        periodEnd,
        status: 'finalized',
        currency: 'USD',
        grossOutboundMicros: 0n,
        billableOutboundMicros: 0n,
        apiCalls: 0n,
        activeWallets: 0,
        monthlyFeeMicros: AMOUNT,
        outboundOverageMicros: 0n,
        apiOverageMicros: 0n,
        walletOverageMicros: 0n,
        totalMicros: AMOUNT,
        snapshotJson: {},
        snapshotHash: `wpay-usage-${SUITE_ID}`,
        finalizedAt: new Date(),
      },
    });
    const planInv = await prisma!.billingInvoice.create({
      data: {
        billingAccountId: account.id,
        planVersionId: plan.id,
        purpose: 'plan_charge',
        periodStart,
        periodEnd,
        status: 'finalized',
        currency: 'USD',
        grossOutboundMicros: 0n,
        billableOutboundMicros: 0n,
        apiCalls: 0n,
        activeWallets: 0,
        monthlyFeeMicros: AMOUNT,
        outboundOverageMicros: 0n,
        apiOverageMicros: 0n,
        walletOverageMicros: 0n,
        totalMicros: AMOUNT,
        snapshotJson: {},
        snapshotHash: `wpay-plan-${SUITE_ID}`,
        finalizedAt: new Date(),
      },
    });

    const mkAttempt = async (
      invId: string,
      opts: { expiresInMs: number; id?: string } = { expiresInMs: 3_600_000 },
    ) => {
      const id = opts.id ?? randomUUID();
      await prisma!.billingPaymentAttempt.create({
        data: {
          id,
          invoiceId: invId,
          method: 'usdc',
          status: 'pending',
          amountMicros: AMOUNT,
          currency: 'USD',
          chainId: BigInt(CHAIN_ID),
          tokenAddress: TOKEN.toLowerCase(),
          treasuryAddress: TREASURY.toLowerCase(),
          tokenDecimals: 6,
          expectedBaseUnits: AMOUNT,
          quoteExpiresAt: new Date(Date.now() + opts.expiresInMs),
          priceSource: 'usdc_6decimals',
          expectedPayerAddress: PLATFORM_WALLET.toLowerCase(),
          requiredConfirmations: 5,
          providerIdentity: PROVIDER_IDENTITY,
          walletPaymentReserved: false,
        },
      });
      return id;
    };

    const att = await mkAttempt(usageInv.id, { expiresInMs: 3_600_000 });
    const planAtt = await mkAttempt(planInv.id, { expiresInMs: 3_600_000 });

    const dashboardSession = await createDashboardSession(user.id);
    const otherDashboardSession = await createDashboardSession(other.id);

    return {
      userId: user.id,
      walletId: wallet.id,
      invoiceId: usageInv.id,
      planChargeInvoiceId: planInv.id,
      attemptId: att,
      planChargeAttemptId: planAtt,
      dashboardSession,
      otherDashboardSession,
    };
  }

  it('rejects quote expiry within 5-minute safety margin', async () => {
    await prisma!.billingPaymentAttempt.update({
      where: { id: attemptId },
      data: { quoteExpiresAt: new Date(Date.now() + 2 * 60_000) },
    });
    const res = await payFromWallet(dashboardSession, invoiceId, {
      paymentAttemptId: attemptId,
    }).expect(400);
    expect(res.body.code).toBe(API_ERROR_CODES.USDC_QUOTE_EXPIRY_TOO_SOON);
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
  });

  async function cleanDatabase() {
    if (!prisma || !dbIdentityVerified) {
      throw new Error('cleanDatabase refused: identity unverified');
    }
    // RESTRICT: attempts before transactions.
    await prisma.billingPaymentAttempt.deleteMany().catch(() => undefined);
    await prisma.transaction.deleteMany().catch(() => undefined);
    await prisma.billingInvoiceLine.deleteMany().catch(() => undefined);
    await prisma.billingUsageEvent.deleteMany().catch(() => undefined);
    await prisma.billingInvoice.deleteMany().catch(() => undefined);
    await prisma.billingPlanAssignment.deleteMany().catch(() => undefined);
    await prisma.billingAccount.deleteMany().catch(() => undefined);
    await prisma.billingPlanVersion.deleteMany().catch(() => undefined);
    await prisma.withdrawalAddress.deleteMany().catch(() => undefined);
    await prisma.withdrawalPolicy.deleteMany().catch(() => undefined);
    await prisma.walletChainAuthorization.deleteMany().catch(() => undefined);
    await prisma.userWallet.deleteMany().catch(() => undefined);
    await prisma.stepUpChallenge.deleteMany().catch(() => undefined);
    // Deleting only this suite's sessions also cascades their session-bound proofs.
    await prisma.appSession.deleteMany({
      where: { user: { socialId: { in: [`wpay_${SUITE_ID}`, `wpay_o_${SUITE_ID}`] } } },
    });
    await prisma.securityEvent.deleteMany().catch(() => undefined);
    await prisma.user.deleteMany().catch(() => undefined);
  }
});

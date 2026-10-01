/**
 * E2E runtime evidence: API-key direct-egress destination/cooldown + reauth (BILL-016 Phase 2A).
 *
 * Real: AppModule + runner-provisioned PostgreSQL (BILLING_E2E_* gate only),
 *       destination leaf, interactive acceptance TX, SecurityEvent wiring.
 * Mocked: OpenfortService, SessionKeyPolicyService, TransactionSimulationService
 *         (assertSimulatable may run a one-shot post-outer / pre-acceptance hook),
 *         throttler storage — never hits real chain/Openfort/RPC.
 *
 * Run via `npm run test:e2e:billing` (same generated disposable DB as billing suites).
 * Does not use static DATABASE_URL / agent_wallet fallback.
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
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { SessionKeyPolicyService } from '../src/modules/session-key/session-key-policy.service';
import { TransactionSimulationService } from '../src/modules/transactions/transaction-simulation.service';
import { StepUpGuard } from '../src/common/guards/step-up.guard';
import { API_ERROR_CODES } from '../src/common/errors/api-error-codes';
import { AgentStatus } from '../src/common/agent/agent-status';
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
// Required before AppModule compile so EoaExecutionPolicyService allows eoa mode.
process.env.EOA_EXECUTION_ENABLED = 'true';

const SUITE_ID = randomUUID().replace(/-/g, '').slice(0, 12);
const CHAIN_ID = 84532;
const PLATFORM_WALLET = getAddress('0x1111111111111111111111111111111111111111');
const AGENT_WALLET = getAddress('0x4444444444444444444444444444444444444444');
const TOKEN = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const ALLOWLISTED = getAddress('0x2222222222222222222222222222222222222222');
const EXTERNAL = getAddress('0x3333333333333333333333333333333333333333');
const FOREIGN_FROM = getAddress('0x5555555555555555555555555555555555555555');
const TX_HASH = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'c'.repeat(64)}`;
const AGENT_KEY_HASH = `0x${'b'.repeat(64)}`;

const ERC20_TRANSFER = '0xa9059cbb';
const ERC20_TRANSFER_FROM = '0x23b872dd';

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
function padUint(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}
function transferData(to: string, amount = 1n): string {
  return `${ERC20_TRANSFER}${padAddress(to)}${padUint(amount)}`;
}
function transferFromData(from: string, to: string, amount = 1n): string {
  return `${ERC20_TRANSFER_FROM}${padAddress(from)}${padAddress(to)}${padUint(amount)}`;
}
/** Valid hex, unknown selector — not a direct-egress intent. */
function unknownCalldata(): string {
  return `0xdeadbeef${padAddress(EXTERNAL)}${padUint(1n)}`;
}

/**
 * Production TransactionsService calls:
 *   session_key → submitUserOperation → waitForUserOperationReceipt → getTransactionReceipt
 *   eoa         → sendBackendTransaction
 * Do not mock the legacy sendUserOperation name alone.
 */
/** IAM bearer → session for dashboard authorize-direct-egress. */
const iamSessions = new Map<string, { openfortUserId: string; email: string; userId: string }>();

/**
 * One-shot hook invoked inside the simulation mock after outer destination
 * preflight has already passed and before `createPendingOrReturnExisting`.
 * Used only by the same-request outer-pass → inner-deferred-denial regression.
 * Cleared after a single run (and in beforeEach/afterEach).
 */
let afterOuterPreflightHook: (() => Promise<void>) | null = null;

const assertSimulatableMock = jest.fn().mockImplementation(async () => {
  const hook = afterOuterPreflightHook;
  afterOuterPreflightHook = null;
  if (hook) {
    await hook();
  }
});

const mockOpenfortService = {
  createBackendWallet: jest.fn(),
  verifyAgentKeyRegistration: jest.fn().mockResolvedValue(undefined),
  submitUserOperation: jest.fn().mockResolvedValue({
    userOpHash: USER_OP_HASH,
    transactionHash: null,
  }),
  waitForUserOperationReceipt: jest.fn().mockResolvedValue({
    success: true,
    transactionHash: TX_HASH,
  }),
  getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'success' }),
  sendBackendTransaction: jest.fn().mockResolvedValue({ transactionHash: TX_HASH }),
  signData: jest.fn(),
  verifyIamSession: jest.fn(async (accessToken: string) => {
    const session = iamSessions.get(accessToken);
    if (!session) throw new Error('invalid openfort token');
    return {
      openfortUserId: session.openfortUserId,
      email: session.email,
      session: { id: `sess_${session.openfortUserId}` },
    };
  }),
};

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => mockOpenfortService),
}));

describe('API-key direct-egress policy (e2e runtime evidence)', () => {
  // Nest + Prisma against a fresh runner DB exceeds default 5s hook budget.
  jest.setTimeout(60_000);

  let app: INestApplication | undefined;
  let moduleFixture: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let preflightPrisma: PrismaClient | undefined;
  /** Separate committed client for mid-request allowlist mutation (not the Nest TX client). */
  let racePrisma: PrismaClient | undefined;
  let dbIdentityVerified = false;

  let userId: string;
  let authorizedKeyId: string;
  let rawKey: string;
  let keyUnauthorized: string;
  let keyUnauthorizedId: string;
  let iamToken: string;

  beforeAll(async () => {
    try {
      preflightPrisma = new PrismaClient({ adapter: new PrismaPg(billingE2eDb.url) });
      await preflightPrisma.$connect();
      await assertBillingE2eDatabaseIdentity(billingE2eDb, () =>
        queryBillingE2eIdentityWithPrisma(preflightPrisma!),
      );

      racePrisma = new PrismaClient({ adapter: new PrismaPg(billingE2eDb.url) });
      await racePrisma.$connect();

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
        .overrideProvider(TransactionSimulationService)
        .useValue({
          // Real send() order: outer destination → billing gate → assertSimulatable →
          // createPendingOrReturnExisting (advisory + ApiKey FOR UPDATE + inner deferAudit).
          assertSimulatable: assertSimulatableMock,
          simulateAssetFlowEvidence: jest.fn().mockResolvedValue(null),
        })
        // Step-up is required on authorize-direct-egress; this suite evidences
        // endpoint wiring + CAS, not TOTP crypto. Real Openfort IAM is mocked.
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
      throw new Error('direct-egress e2e: database not initialized or identity unverified');
    }
    afterOuterPreflightHook = null;
    jest.clearAllMocks();
    // clearAllMocks keeps implementations; re-bind one-shot race hook runner explicitly.
    assertSimulatableMock.mockImplementation(async () => {
      const hook = afterOuterPreflightHook;
      afterOuterPreflightHook = null;
      if (hook) {
        await hook();
      }
    });
    resetProviderMocks();

    await cleanDatabase();
    iamSessions.clear();
    const seeded = await seedFixtures();
    userId = seeded.userId;
    authorizedKeyId = seeded.keyId;
    rawKey = seeded.rawKey;
    keyUnauthorized = seeded.keyUnauthorized;
    keyUnauthorizedId = seeded.keyUnauthorizedId;
    iamToken = seeded.iamToken;
  });

  afterEach(() => {
    afterOuterPreflightHook = null;
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
    afterOuterPreflightHook = null;
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
    if (racePrisma) {
      try {
        await racePrisma.$disconnect();
      } catch {
        /* ignore */
      }
      racePrisma = undefined;
    }
    if (preflightPrisma) {
      try {
        await preflightPrisma.$disconnect();
      } catch {
        /* ignore */
      }
      preflightPrisma = undefined;
    }
  }

  function sendTx(
    apiKey: string,
    body: {
      chainId: number;
      idempotencyKey: string;
      interactions: Array<{ to: string; data: string; value?: string }>;
      executionMode?: 'session_key' | 'eoa';
    },
  ) {
    return request(app!.getHttpServer())
      .post('/v1/transactions/send')
      .set('X-API-Key', apiKey)
      .send(body);
  }

  function resetProviderMocks() {
    mockOpenfortService.submitUserOperation.mockReset().mockResolvedValue({
      userOpHash: USER_OP_HASH,
      transactionHash: null,
    });
    mockOpenfortService.waitForUserOperationReceipt.mockReset().mockResolvedValue({
      success: true,
      transactionHash: TX_HASH,
    });
    mockOpenfortService.getTransactionReceipt.mockReset().mockResolvedValue({ status: 'success' });
    mockOpenfortService.sendBackendTransaction.mockReset().mockResolvedValue({
      transactionHash: TX_HASH,
    });
    mockOpenfortService.verifyAgentKeyRegistration.mockReset().mockResolvedValue(undefined);
  }

  function expectNoProviderSubmit() {
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();
    expect(mockOpenfortService.waitForUserOperationReceipt).not.toHaveBeenCalled();
    expect(mockOpenfortService.getTransactionReceipt).not.toHaveBeenCalled();
    expect(mockOpenfortService.sendBackendTransaction).not.toHaveBeenCalled();
  }

  function expectSessionKeyProviderCalled() {
    expect(mockOpenfortService.submitUserOperation).toHaveBeenCalledTimes(1);
    expect(mockOpenfortService.waitForUserOperationReceipt).toHaveBeenCalledTimes(1);
    expect(mockOpenfortService.getTransactionReceipt).toHaveBeenCalled();
    expect(mockOpenfortService.sendBackendTransaction).not.toHaveBeenCalled();
  }

  function expectNotDirectEgressDeny(body: { code?: string }) {
    expect(body.code).not.toBe(API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED);
    expect(body.code).not.toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expect(body.code).not.toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN);
  }

  // ── Negative: reauth ──────────────────────────────────────────────────────

  it('rejects direct transfer when key lacks directEgressPolicyAcceptedAt (stable 403)', async () => {
    const res = await sendTx(keyUnauthorized, {
      chainId: CHAIN_ID,
      idempotencyKey: `reauth-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(403);

    expect(res.body.code).toBe(API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED);
    expectNoProviderSubmit();
    await expect(
      prisma!.transaction.count({ where: { userId, operationType: 'send' } }),
    ).resolves.toBe(0);
  });

  // ── Negative: allowlist / cooldown ────────────────────────────────────────

  it('rejects transfer to non-allowlisted recipient (403, no provider/tx)', async () => {
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `not-listed-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(EXTERNAL), value: '0' }],
    }).expect(403);

    expect(res.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expectNoProviderSubmit();
    await expect(
      prisma!.transaction.count({ where: { userId, operationType: 'send' } }),
    ).resolves.toBe(0);
  });

  /**
   * Two-request baseline (not the same-request race): first send succeeds while
   * allowlisted; after a separate committed delete, a second send is denied at
   * outer preflight. Same-request outer-pass → inner-deferred path is the next test.
   */
  it('allowlist removed between two sends: second request outer-deny 403 + single audit', async () => {
    const okProbe = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `pre-delete-ok-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(201);
    expect(okProbe.body.transactionHash).toBe(TX_HASH);
    resetProviderMocks();

    await prisma!.withdrawalAddress.deleteMany({
      where: { userId, address: ALLOWLISTED.toLowerCase() },
    });
    await prisma!.securityEvent.deleteMany({
      where: { userId, eventType: 'transaction.destination_policy_denied' },
    });

    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `post-delete-deny-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(403);

    expect(res.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expectNoProviderSubmit();
    await expect(
      prisma!.transaction.count({
        where: {
          userId,
          operationType: 'send',
          idempotencyKey: `post-delete-deny-${SUITE_ID}`,
        },
      }),
    ).resolves.toBe(0);

    const audits = await prisma!.securityEvent.findMany({
      where: { userId, eventType: 'transaction.destination_policy_denied' },
    });
    expect(audits.length).toBe(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        actorType: 'api_key',
        userId,
        apiKeyId: authorizedKeyId,
        result: 'denied',
      }),
    );
  });

  /**
   * Required Gate 2 same-request evidence:
   * outer destination preflight passes → assertSimulatable one-shot hook deletes
   * the allowlisted address on a separate committed Prisma connection →
   * createPendingOrReturnExisting holds destination advisory + ApiKey FOR UPDATE,
   * inner assertDestinationsAllowed(deferAudit) denies → TX rolls back →
   * recordDeferredDenial once → stable 403 (no deadlock/timeout).
   * Real leaf/TX/SecurityEvent path; simulation is only the race injection point.
   */
  it('same-request outer pass → allowlist deleted mid-send → inner deferred deny 403 + one audit', async () => {
    if (!racePrisma) {
      throw new Error('racePrisma not initialized');
    }

    const idempotencyKey = `outer-pass-inner-deny-${SUITE_ID}`;
    const sendCountBefore = await prisma!.transaction.count({
      where: { userId, operationType: 'send' },
    });
    await prisma!.securityEvent.deleteMany({
      where: { userId, eventType: 'transaction.destination_policy_denied' },
    });

    // Confirm allowlist row exists before the single request.
    await expect(
      prisma!.withdrawalAddress.count({
        where: { userId, address: ALLOWLISTED.toLowerCase() },
      }),
    ).resolves.toBe(1);

    let hookRan = false;
    afterOuterPreflightHook = async () => {
      hookRan = true;
      // Separate committed connection — not the Nest interactive TX client.
      const deleted = await racePrisma!.withdrawalAddress.deleteMany({
        where: { userId, address: ALLOWLISTED.toLowerCase() },
      });
      if (deleted.count < 1) {
        throw new Error('race hook: expected to delete allowlisted WithdrawalAddress');
      }
    };

    const started = Date.now();
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(403);
    const elapsedMs = Date.now() - started;

    expect(hookRan).toBe(true);
    expect(assertSimulatableMock).toHaveBeenCalled();
    // Must complete quickly: deferred audit path, not lock deadlock/timeout.
    expect(elapsedMs).toBeLessThan(15_000);
    expect(res.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expectNoProviderSubmit();

    await expect(
      prisma!.transaction.count({
        where: { userId, operationType: 'send', idempotencyKey },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma!.transaction.count({ where: { userId, operationType: 'send' } }),
    ).resolves.toBe(sendCountBefore);

    // Exactly one post-rollback deferred denial — no outer event (outer passed).
    const audits = await prisma!.securityEvent.findMany({
      where: {
        userId,
        eventType: 'transaction.destination_policy_denied',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        actorType: 'api_key',
        userId,
        apiKeyId: authorizedKeyId,
        riskLevel: 'high',
        result: 'denied',
        reason: 'Withdrawal address is not allowlisted',
      }),
    );
    const meta =
      audits[0].metadata &&
      typeof audits[0].metadata === 'object' &&
      !Array.isArray(audits[0].metadata)
        ? (audits[0].metadata as Record<string, unknown>)
        : {};
    const expectedApiKeyPrefix = rawKey.slice(0, 27);
    expect(meta).toEqual(
      expect.objectContaining({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        chainId: CHAIN_ID,
        executionMode: 'session_key',
        // Production leaf may include short lookup prefix (sk_ + 24 hex) — not a secret.
        apiKeyPrefix: expectedApiKeyPrefix,
      }),
    );
    // Safe metadata only — no full destination address; short apiKeyPrefix OK, full raw key never.
    expect(meta).not.toHaveProperty('address');
    expect(meta).not.toHaveProperty('to');
    const metaJson = JSON.stringify(meta);
    expect(metaJson).toContain(expectedApiKeyPrefix);
    expect(metaJson).not.toContain(rawKey);
    // Prefix is strictly shorter than the full API key material used on the wire.
    expect(expectedApiKeyPrefix.length).toBeLessThan(rawKey.length);
    expect(typeof meta.apiKeyPrefix).toBe('string');
    expect(meta.apiKeyPrefix).not.toBe(rawKey);
  });

  it('rejects transfer to allowlisted address still in cooldown', async () => {
    await prisma!.withdrawalAddress.updateMany({
      where: { userId, address: ALLOWLISTED.toLowerCase() },
      data: { availableAt: new Date(Date.now() + 3_600_000) },
    });

    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `cooldown-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(403);

    expect(res.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN);
    expectNoProviderSubmit();
    await expect(
      prisma!.transaction.count({ where: { userId, operationType: 'send' } }),
    ).resolves.toBe(0);
  });

  // ── Positive: allowlisted past cooldown ───────────────────────────────────

  it('accepts transfer to allowlisted address past cooldown (session_key, provider mocked)', async () => {
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `ok-transfer-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(201);

    expect(res.body).toEqual(
      expect.objectContaining({
        transactionId: expect.any(String),
        transactionHash: TX_HASH,
        status: 'confirmed',
      }),
    );
    expectSessionKeyProviderCalled();
    await expect(
      prisma!.transaction.count({ where: { userId, operationType: 'send' } }),
    ).resolves.toBe(1);
  });

  // ── Malformed known selector ──────────────────────────────────────────────

  it('returns 400 for known transfer selector with truncated calldata', async () => {
    const truncated = transferData(ALLOWLISTED).slice(0, 20);
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `malformed-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: truncated, value: '0' }],
    }).expect(400);

    expect(res.body.message).toMatch(/invalid length|not valid hex|malformed|calldata/i);
    expectNoProviderSubmit();
    await expect(
      prisma!.transaction.count({ where: { userId, operationType: 'send' } }),
    ).resolves.toBe(0);
  });

  // ── Self-transfer / scope ─────────────────────────────────────────────────

  it('does not destination-deny self-transfer (recipient === platform wallet owner)', async () => {
    // Self-transfer is not a destination intent → 201 with mocked provider.
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `self-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(PLATFORM_WALLET), value: '0' }],
    }).expect(201);

    expectNotDirectEgressDeny(res.body);
    expect(res.body).toEqual(
      expect.objectContaining({
        transactionId: expect.any(String),
        transactionHash: TX_HASH,
        status: 'confirmed',
      }),
    );
    expectSessionKeyProviderCalled();
  });

  it('applies destination policy to owner-source transferFrom', async () => {
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `tf-owner-ext-${SUITE_ID}`,
      interactions: [
        {
          to: TOKEN,
          data: transferFromData(PLATFORM_WALLET, EXTERNAL),
          value: '0',
        },
      ],
    }).expect(403);

    expect(res.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expectNoProviderSubmit();
  });

  it('does not treat foreign-source transferFrom as direct egress (out of scope)', async () => {
    // foreign from → no destination intent → 201 via mocked provider.
    const res = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `tf-foreign-${SUITE_ID}`,
      interactions: [
        {
          to: TOKEN,
          data: transferFromData(FOREIGN_FROM, EXTERNAL),
          value: '0',
        },
      ],
    }).expect(201);

    expectNotDirectEgressDeny(res.body);
    expectSessionKeyProviderCalled();
  });

  it('does not block unknown non-egress selector with reauth/destination gates', async () => {
    // Unauthorized key + unknown selector must not hit REAUTH (no direct egress) → 201.
    const res = await sendTx(keyUnauthorized, {
      chainId: CHAIN_ID,
      idempotencyKey: `unknown-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: unknownCalldata(), value: '0' }],
    }).expect(201);

    expectNotDirectEgressDeny(res.body);
    expectSessionKeyProviderCalled();
  });

  // ── EOA path (execution owner = agent wallet) ─────────────────────────────

  it('EOA: agent wallet is owner (self OK); platform wallet is external deny', async () => {
    // EoaExecutionPolicyService rate-limits per apiKeyId (1 allowed event / window).
    // Use two independent EOA keys on the same user/agent wallet so the second
    // request is not blocked by the first key's allowed-event stamp.
    const eoaSelfKey = await seedEoaKey(userId, 'self');
    const eoaPlatKey = await seedEoaKey(userId, 'plat');

    // To agent (execution owner) → self-transfer, not destination policy.
    const selfRes = await sendTx(eoaSelfKey.rawKey, {
      chainId: CHAIN_ID,
      executionMode: 'eoa',
      idempotencyKey: `eoa-self-agent-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(AGENT_WALLET), value: '0' }],
    }).expect(201);
    expectNotDirectEgressDeny(selfRes.body);
    expect(mockOpenfortService.sendBackendTransaction).toHaveBeenCalled();
    expect(mockOpenfortService.submitUserOperation).not.toHaveBeenCalled();

    resetProviderMocks();
    await prisma!.transaction.deleteMany({ where: { userId } });

    // To platform wallet under eoa owner=agent → external destination deny
    // (not EOA rate-limit BAD_REQUEST).
    const platRes = await sendTx(eoaPlatKey.rawKey, {
      chainId: CHAIN_ID,
      executionMode: 'eoa',
      idempotencyKey: `eoa-to-platform-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(PLATFORM_WALLET), value: '0' }],
    }).expect(403);
    expect(platRes.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expect(platRes.body.message).not.toMatch(/rate limit/i);
    expectNoProviderSubmit();
  });

  // ── Mixed-case interaction.to (DTO-accepted, EIP-55 non-checksum) ─────────

  it('treats mixed-case non-checksum token address like lowercase for destination policy', async () => {
    const checksummed = getAddress(TOKEN);
    const mixed =
      '0x' +
      checksummed
        .slice(2)
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()))
        .join('');

    // Deny path must still fire (EXTERNAL not allowlisted).
    const deny = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `mixed-deny-${SUITE_ID}`,
      interactions: [{ to: mixed, data: transferData(EXTERNAL), value: '0' }],
    }).expect(403);
    expect(deny.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expectNoProviderSubmit();

    // Batch: mixed-case known transfer + unknown selector — still deny on external.
    const batch = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `mixed-batch-${SUITE_ID}`,
      interactions: [
        { to: mixed, data: transferData(EXTERNAL), value: '0' },
        { to: TOKEN.toLowerCase(), data: unknownCalldata(), value: '0' },
      ],
    }).expect(403);
    expect(batch.body.code).toBe(API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED);
    expectNoProviderSubmit();

    // Allowlisted recipient via mixed-case token target → 201.
    const ok = await sendTx(rawKey, {
      chainId: CHAIN_ID,
      idempotencyKey: `mixed-ok-${SUITE_ID}`,
      interactions: [{ to: mixed, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(201);
    expect(ok.body.transactionHash).toBe(TX_HASH);
    expectSessionKeyProviderCalled();
  });

  // ── authorize-direct-egress HTTP (IAM + FrontendOnly + StepUp override) ───

  it('authorize-direct-egress sets acceptance; send then succeeds without fixture stamp', async () => {
    // Key starts unauthorized — transfer denied by reauth.
    await sendTx(keyUnauthorized, {
      chainId: CHAIN_ID,
      idempotencyKey: `pre-auth-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(403);

    const authRes = await request(app!.getHttpServer())
      .post(`/v1/api-keys/${keyUnauthorizedId}/authorize-direct-egress`)
      .set('Authorization', `Bearer ${iamToken}`)
      .set('Origin', 'http://localhost:3000')
      .set('X-Step-Up-Token', 'e2e-step-up-proof')
      .expect(201);

    expect(authRes.body).toEqual(
      expect.objectContaining({
        id: keyUnauthorizedId,
        outcome: expect.stringMatching(/authorized|unchanged/),
        directEgressPolicyAcceptedAt: expect.any(String),
      }),
    );

    const row = await prisma!.apiKey.findUniqueOrThrow({ where: { id: keyUnauthorizedId } });
    expect(row.directEgressPolicyAcceptedAt).not.toBeNull();

    // Same key can now send allowlisted transfer.
    await sendTx(keyUnauthorized, {
      chainId: CHAIN_ID,
      idempotencyKey: `post-auth-${SUITE_ID}`,
      interactions: [{ to: TOKEN, data: transferData(ALLOWLISTED), value: '0' }],
    }).expect(201);
    expectSessionKeyProviderCalled();
  });

  it('authorize-direct-egress rejects without IAM bearer', async () => {
    await request(app!.getHttpServer())
      .post(`/v1/api-keys/${keyUnauthorizedId}/authorize-direct-egress`)
      .set('Origin', 'http://localhost:3000')
      .set('X-Step-Up-Token', 'e2e-step-up-proof')
      .expect(401);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function seedFixtures() {
    const socialId = `direct_egress_${SUITE_ID}`;
    const user = await prisma!.user.create({
      data: {
        socialProvider: 'google',
        socialId,
        email: `${socialId}@example.com`,
      },
    });

    const wallet = await prisma!.userWallet.create({
      data: {
        userId: user.id,
        openfortAccountId: `ofa_${SUITE_ID}`,
        walletAddress: PLATFORM_WALLET.toLowerCase(),
        agentOpenfortAccountId: `ofa_agent_${SUITE_ID}`,
        agentWalletAddress: AGENT_WALLET.toLowerCase(),
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
      },
    });
    await prisma!.withdrawalAddress.create({
      data: {
        userId: user.id,
        address: ALLOWLISTED.toLowerCase(),
        label: 'allowlisted',
        availableAt: new Date(Date.now() - 60_000), // past cooldown
      },
    });

    // Authorized send key (reauth set via fixture for most cases; authorize HTTP
    // path is covered separately without relying only on this stamp).
    const authorized = await createApiKeyRow(user.id, {
      name: `authorized-${SUITE_ID}`,
      canSendTransaction: true,
      canSign: true,
      canReadTransactionStatus: true,
      canUseEoaExecution: false,
      directEgressPolicyAcceptedAt: new Date(),
    });

    // Send-capable key without reauth (authorize-direct-egress HTTP tests this).
    const unauthorized = await createApiKeyRow(user.id, {
      name: `unauthorized-${SUITE_ID}`,
      canSendTransaction: true,
      canSign: true,
      canReadTransactionStatus: true,
      canUseEoaExecution: false,
      directEgressPolicyAcceptedAt: null,
    });

    const token = `iam-direct-egress-${SUITE_ID}`;
    iamSessions.set(token, {
      openfortUserId: socialId,
      email: `${socialId}@example.com`,
      userId: user.id,
    });

    return {
      userId: user.id,
      walletId: wallet.id,
      keyId: authorized.id,
      rawKey: authorized.rawKey,
      keyUnauthorized: unauthorized.rawKey,
      keyUnauthorizedId: unauthorized.id,
      iamToken: token,
    };
  }

  async function seedEoaKey(uid: string, label = 'eoa') {
    return createApiKeyRow(uid, {
      name: `eoa-${label}-${SUITE_ID}-${randomUUID().slice(0, 8)}`,
      canSendTransaction: true,
      canSign: false,
      canReadTransactionStatus: true,
      canUseEoaExecution: true,
      directEgressPolicyAcceptedAt: new Date(),
      // EOA high-risk needs short TTL (≤30d); keep well inside the window.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  }

  /**
   * Insert API key with known plaintext via Argon2 hash (same as production).
   * Avoids ApiKeyService defaults that omit directEgressPolicyAcceptedAt.
   */
  async function createApiKeyRow(
    uid: string,
    opts: {
      name: string;
      canSendTransaction: boolean;
      canSign: boolean;
      canReadTransactionStatus: boolean;
      canUseEoaExecution: boolean;
      directEgressPolicyAcceptedAt: Date | null;
      expiresAt?: Date;
    },
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const argon2 = require('argon2') as typeof import('argon2');
    const secret = `sk_${createHash('sha256').update(`${opts.name}-${SUITE_ID}`).digest('hex')}`;
    const rawKey = secret.length >= 67 ? secret.slice(0, 67) : secret.padEnd(67, '0');
    // sk_ + 64 hex
    const normalized = rawKey.startsWith('sk_')
      ? rawKey
      : `sk_${createHash('sha256').update(opts.name).digest('hex')}`;
    const keyPrefix = normalized.slice(0, 27);
    const hash = await argon2.hash(normalized, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const row = await prisma!.apiKey.create({
      data: {
        userId: uid,
        apiKeyHash: hash,
        keyPrefix,
        name: opts.name,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        allowedIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
        allowedContracts: [],
        allowedFunctionSelectors: [],
        canSendTransaction: opts.canSendTransaction,
        canSign: opts.canSign,
        canReadTransactionStatus: opts.canReadTransactionStatus,
        canUseEoaExecution: opts.canUseEoaExecution,
        directEgressPolicyAcceptedAt: opts.directEgressPolicyAcceptedAt,
      },
    });

    return { id: row.id, rawKey: normalized };
  }

  async function cleanDatabase() {
    if (!prisma || !dbIdentityVerified) {
      throw new Error('cleanDatabase refused: prisma missing or DB identity unverified');
    }
    await prisma.billingInvoice
      .updateMany({ data: { settlementAttemptId: null } })
      .catch(() => undefined);
    await prisma.billingPlanChange
      .updateMany({ data: { chargeInvoiceId: null } })
      .catch(() => undefined);
    await prisma.billingPlanChange.deleteMany().catch(() => undefined);
    await prisma.billingSubscriptionSyncIntent.deleteMany().catch(() => undefined);
    await prisma.billingAutoSubscriptionIntent.deleteMany().catch(() => undefined);
    await prisma.billingPaymentAttempt.deleteMany().catch(() => undefined);
    await prisma.billingInvoiceLine.deleteMany().catch(() => undefined);
    await prisma.billingUsageEvent.deleteMany().catch(() => undefined);
    await prisma.billingInvoice.deleteMany().catch(() => undefined);
    await prisma.billingPlanAssignment.deleteMany().catch(() => undefined);
    await prisma.billingReconciliationRun.deleteMany().catch(() => undefined);
    await prisma.billingAccount.deleteMany().catch(() => undefined);

    await prisma.signingRequest.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.apiKeyEvent.deleteMany();
    await prisma.securityNotification.deleteMany().catch(() => undefined);
    await prisma.securityEvent.deleteMany().catch(() => undefined);
    await prisma.apiKey.deleteMany();
    await prisma.walletChainAuthorization.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.withdrawalAddress.deleteMany();
    await prisma.withdrawalPolicy.deleteMany();
    await prisma.stepUpChallenge.deleteMany().catch(() => undefined);
    await prisma.userMfaTotpRecoveryCode.deleteMany().catch(() => undefined);
    await prisma.userMfaTotpCredential.deleteMany().catch(() => undefined);
    await prisma.userKnownIp.deleteMany().catch(() => undefined);
    await prisma.user.deleteMany();
  }
});

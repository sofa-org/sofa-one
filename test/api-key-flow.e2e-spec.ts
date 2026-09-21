/**
 * E2E integration test: API-key public security flow.
 *
 * External dependencies mocked: OpenfortService (no real blockchain calls).
 * Real dependencies used: PostgreSQL (docker-compose).
 */
import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import * as request from 'supertest';
import { PrismaService } from '../src/core/database/prisma.service';
import { ApiKeyService } from '../src/modules/api-key/api-key.service';
import { API_KEY_PREFIX_LENGTH } from '../src/common/api-key/api-key-prefix';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { SessionKeyPolicyService } from '../src/modules/session-key/session-key-policy.service';
import { TransactionSimulationService } from '../src/modules/transactions/transaction-simulation.service';

// ── Test env vars (must be set before AppModule compiles) ──────────────
process.env.NODE_ENV = 'test';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agent_wallet';
// Keep the test process independent of any developer Redis instance. The
// throttler storage is replaced with an unlimited test double below.
process.env.REDIS_URL = '';

const TEST_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TEST_TARGET_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TEST_CHAIN_ID = 84532;
const TEST_TX_HASH = `0x${'1'.repeat(64)}`;
const TEST_SIGNATURE = `0x${'2'.repeat(130)}`;

const mockOpenfortService = {
  createBackendWallet: jest.fn().mockResolvedValue({
    id: 'ofa_test_account_123',
    address: TEST_WALLET_ADDRESS,
  }),
  verifyAgentKeyRegistration: jest.fn().mockResolvedValue(undefined),
  sendUserOperation: jest.fn().mockResolvedValue({
    userOpHash: `0x${'4'.repeat(64)}`,
    transactionHash: TEST_TX_HASH,
  }),
  sendBackendTransaction: jest.fn().mockResolvedValue({ transactionHash: TEST_TX_HASH }),
  signData: jest.fn().mockResolvedValue(TEST_SIGNATURE),
};

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => mockOpenfortService),
}));

import { AppModule } from '../src/app.module';

describe('API-key public security flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let apiKeyService: ApiKeyService;
  let testUserId: string;
  let testApiKey: string;
  let testKeyId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Keep the production throttler guard active, but use an unlimited test
      // storage so the suite is independent of Redis state and route limits.
      .overrideProvider(getStorageToken())
      .useValue({
        increment: jest.fn().mockResolvedValue({
          totalHits: 0,
          timeToExpire: 0,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      })
      // On-chain session-key verification (Calibur delegation/registration) and
      // transaction simulation hit a real RPC. The E2E environment has no
      // deployed test wallet, so stub them out — the same way OpenfortService
      // is mocked — to keep the test focused on the API-key security contract.
      .overrideProvider(SessionKeyPolicyService)
      .useValue({
        assertSessionKeyAllowed: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(TransactionSimulationService)
      .useValue({
        assertSimulatable: jest.fn().mockResolvedValue(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    apiKeyService = app.get(ApiKeyService);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanDatabase();

    const seeded = await seedUserWithKey('test_social_id_e2e', 'E2E Test Key');
    testUserId = seeded.userId;
    testApiKey = seeded.rawKey;
    testKeyId = seeded.keyId;
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  describe('health and request correlation', () => {
    it('GET /health/live is public and returns a request id', async () => {
      const res = await request(app.getHttpServer()).get('/health/live').expect(200);

      expect(res.headers['x-request-id']).toEqual(expect.any(String));
      expect(res.body).toEqual({ status: 'ok', timestamp: expect.any(String) });
    });

    it('GET /health/ready is public and checks database readiness', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);

      expect(res.headers['x-request-id']).toEqual(expect.any(String));
      // Includes non-sensitive billing-worker state alongside the DB probe.
      expect(res.body).toEqual(
        expect.objectContaining({
          status: 'ok',
          timestamp: expect.any(String),
          checks: expect.objectContaining({
            database: 'ok',
            billingWorker: expect.objectContaining({
              enabled: expect.any(Boolean),
              status: expect.any(String),
            }),
          }),
        }),
      );
    });

    it('reuses inbound X-Request-Id and includes it in error responses', async () => {
      const requestId = 'e2e-request-id-123';

      const res = await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-Request-Id', requestId)
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'hello' })
        .expect(401);

      expect(res.headers['x-request-id']).toBe(requestId);
      expect(res.body).toEqual(expect.objectContaining({ requestId }));
    });
  });

  describe('public API-key endpoints', () => {
    it('POST /v1/wallets/sign signs a message and writes non-plaintext audit', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-API-Key', testApiKey)
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'hello secret message' })
        .expect(200);

      expect(res.body).toEqual({
        signature: expect.stringMatching(/^0x[0-9a-fA-F]+$/),
        walletAddress: TEST_WALLET_ADDRESS,
        type: 'message',
        executionMode: 'session_key',
      });
      expect(mockOpenfortService.signData).toHaveBeenCalledWith(
        'ofa_test_agent_account_123',
        expect.stringMatching(/^0x[0-9a-f]{64}$/),
      );

      const audit = await prisma.signingRequest.findFirstOrThrow({ where: { userId: testUserId } });
      expect(audit.apiKeyId).toBe(testKeyId);
      expect(audit.authMethod).toBe('api_key');
      expect(audit.apiKeyPrefix).toBe(testApiKey.substring(0, API_KEY_PREFIX_LENGTH));
      expect(audit.apiKeyName).toBe('E2E Test Key');
      expect(audit).not.toHaveProperty('message');
      expect(audit.requestHash).not.toContain('hello secret message');
      expect(audit.digest).not.toContain('hello secret message');
    });

    it('POST /v1/transactions/send submits transaction and stores hashes without calldata', async () => {
      // Non-egress unknown selector (not a canonical transfer). A truncated
      // 0xa9059cbb payload is now a malformed direct-transfer 400 (BILL-016);
      // this suite is not the direct-egress runtime evidence path.
      const calldata = '0xdeadbeef000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd';

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/send')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          idempotencyKey: 'order-abc-123',
          interactions: [{ to: TEST_TARGET_ADDRESS, data: calldata, value: '0' }],
        })
        .expect(201);

      expect(res.body).toEqual({
        transactionId: expect.any(String),
        transactionHash: TEST_TX_HASH,
        status: 'confirmed',
      });
      expect(mockOpenfortService.sendUserOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          agentAccountId: 'ofa_test_agent_account_123',
          accountAddress: TEST_WALLET_ADDRESS,
          chainId: TEST_CHAIN_ID,
          keyHash: `0x${'3'.repeat(64)}`,
          interactions: [
            expect.objectContaining({ to: TEST_TARGET_ADDRESS, data: calldata, value: '0' }),
          ],
          sponsorship: 'none',
        }),
      );

      const tx = await prisma.transaction.findFirstOrThrow({ where: { userId: testUserId } });
      expect(tx.apiKeyId).toBe(testKeyId);
      expect(tx.authMethod).toBe('api_key');
      expect(tx.apiKeyPrefix).toBe(testApiKey.substring(0, API_KEY_PREFIX_LENGTH));
      expect(tx.apiKeyName).toBe('E2E Test Key');
      expect(tx.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(tx.details)).toContain('requestHash');
      expect(JSON.stringify(tx.details)).not.toContain(calldata);
    });

    it('POST /v1/transactions/send returns the existing transaction for duplicate idempotent requests', async () => {
      const payload = {
        chainId: TEST_CHAIN_ID,
        idempotencyKey: 'duplicate-order-123',
        interactions: [{ to: TEST_TARGET_ADDRESS, data: '0xdeadbeef', value: '0' }],
      };

      const first = await request(app.getHttpServer())
        .post('/v1/transactions/send')
        .set('X-API-Key', testApiKey)
        .send(payload)
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/v1/transactions/send')
        .set('X-API-Key', testApiKey)
        .send(payload)
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(mockOpenfortService.sendUserOperation).toHaveBeenCalledTimes(1);
      await expect(
        prisma.transaction.count({
          where: {
            userId: testUserId,
            operationType: 'send',
            idempotencyKey: 'duplicate-order-123',
          },
        }),
      ).resolves.toBe(1);
    });

    it('GET /v1/transactions/:id returns safe transaction status for the API-key user', async () => {
      const calldata = '0xdeadbeefcafebabefeedface';

      const created = await request(app.getHttpServer())
        .post('/v1/transactions/send')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          idempotencyKey: 'status-abc-123',
          interactions: [{ to: TEST_TARGET_ADDRESS, data: calldata, value: '0' }],
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/v1/transactions/${created.body.transactionId}`)
        .set('X-API-Key', testApiKey)
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          transactionId: created.body.transactionId,
          transactionHash: TEST_TX_HASH,
          status: 'confirmed',
          chainId: TEST_CHAIN_ID,
          walletAddress: TEST_WALLET_ADDRESS,
          failureReason: null,
        }),
      );
      expect(res.body).not.toHaveProperty('details');
      expect(res.body).not.toHaveProperty('requestHash');
      expect(res.body).not.toHaveProperty('interactionsHash');
      expect(res.body).not.toHaveProperty('interactions');
      expect(JSON.stringify(res.body)).not.toContain(calldata);
    });
  });

  describe('security rejections', () => {
    it('requires API keys for public signing and transaction submission', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'hello' })
        .expect(401)
        .expect((res) => expectApiError(res.body, 401, 'UNAUTHORIZED', '/v1/wallets/sign'));
    });

    it('does not allow an API key to manage API keys or call frontend-only wallet routes', async () => {
      await request(app.getHttpServer())
        .get('/v1/api-keys')
        .set('X-API-Key', testApiKey)
        .expect(401);
      await request(app.getHttpServer())
        .post('/v1/api-keys')
        .set('X-API-Key', testApiKey)
        .send({ name: 'Illegitimate child key' })
        .expect(401);
      await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', testApiKey)
        .send({ chainId: TEST_CHAIN_ID })
        .expect(401);
    });

    it('rejects fabricated, wrong-secret, revoked, and expired API keys', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-API-Key', 'sk_00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'hello' })
        .expect(401)
        .expect((res) => expectApiError(res.body, 401, 'INVALID_API_KEY', '/v1/wallets/sign'));

      const prefix = testApiKey.substring(0, API_KEY_PREFIX_LENGTH);
      const fakeKey = prefix + 'x'.repeat(testApiKey.length - API_KEY_PREFIX_LENGTH);
      await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-API-Key', fakeKey)
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'hello' })
        .expect(401)
        .expect((res) => expectApiError(res.body, 401, 'INVALID_API_KEY', '/v1/wallets/sign'));

      await apiKeyService.revokeApiKey(testKeyId, testUserId);
      await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-API-Key', testApiKey)
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'hello' })
        .expect(401);

      const expired = await seedUserWithKey('expired_social_id_e2e', 'Expired Key', {
        openfortAccountId: 'ofa_expired_account_123',
        walletAddress: '0x2222222222222222222222222222222222222222',
      });
      await prisma.apiKey.update({
        where: { id: expired.keyId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-API-Key', expired.rawKey)
        .send({ chainId: TEST_CHAIN_ID, type: 'message', message: 'expired' })
        .expect(401);
    });

    it('rejects raw hash signing before creating a signing audit row', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/sign')
        .set('X-API-Key', testApiKey)
        .send({ chainId: TEST_CHAIN_ID, type: 'hash', hash: `0x${'3'.repeat(64)}` })
        .expect(400)
        .expect((res) => {
          expectApiError(res.body, 400, 'VALIDATION_ERROR', '/v1/wallets/sign');
          expect(res.body.message).toBe('Validation failed');
          expect(res.body.details).toEqual(expect.arrayContaining([expect.any(String)]));
        });

      await expect(prisma.signingRequest.count({ where: { userId: testUserId } })).resolves.toBe(0);
      expect(mockOpenfortService.signData).not.toHaveBeenCalled();
    });

    it('rejects idempotency-key reuse with a different request', async () => {
      await request(app.getHttpServer())
        .post('/v1/transactions/send')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          idempotencyKey: 'conflict-123',
          interactions: [{ to: TEST_TARGET_ADDRESS, data: '0xdeadbeef' }],
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/v1/transactions/send')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          idempotencyKey: 'conflict-123',
          interactions: [{ to: TEST_TARGET_ADDRESS, data: '0x12345678' }],
        })
        .expect(400)
        .expect((res) =>
          expectApiError(res.body, 400, 'IDEMPOTENCY_CONFLICT', '/v1/transactions/send'),
        );
      expect(mockOpenfortService.sendUserOperation).toHaveBeenCalledTimes(1);
    });

    it('does not allow an API key to read another user transaction status', async () => {
      const tx = await prisma.transaction.create({
        data: {
          userId: testUserId,
          apiKeyId: testKeyId,
          authMethod: 'api_key',
          apiKeyPrefix: testApiKey.substring(0, API_KEY_PREFIX_LENGTH),
          apiKeyName: 'E2E Test Key',
          status: 'confirmed',
          txHash: TEST_TX_HASH,
          chainId: BigInt(TEST_CHAIN_ID),
          walletAddress: TEST_WALLET_ADDRESS,
          operationType: 'send',
          idempotencyKey: 'private-status-123',
          requestHash: 'a'.repeat(64),
          details: { type: 'send' },
          completedAt: new Date(),
        },
      });

      const other = await seedUserWithKey('other_social_id_e2e', 'Other E2E Key', {
        openfortAccountId: 'ofa_other_account_123',
        walletAddress: '0x3333333333333333333333333333333333333333',
      });

      await request(app.getHttpServer())
        .get(`/v1/transactions/${tx.id}`)
        .set('X-API-Key', other.rawKey)
        .expect(404)
        .expect((res) =>
          expectApiError(res.body, 404, 'TRANSACTION_NOT_FOUND', `/v1/transactions/${tx.id}`),
        );
    });
  });

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

  async function seedUserWithKey(
    socialId: string,
    keyName: string,
    wallet: {
      openfortAccountId: string;
      walletAddress: string;
      agentOpenfortAccountId?: string;
      agentWalletAddress?: string;
      agentKeyHash?: string;
    } = {
      openfortAccountId: 'ofa_test_account_123',
      walletAddress: TEST_WALLET_ADDRESS,
    },
  ) {
    const user = await prisma.user.create({
      data: {
        socialProvider: 'google',
        socialId,
        email: `${socialId}@example.com`,
      },
    });

    const userWallet = await prisma.userWallet.create({
      data: {
        userId: user.id,
        openfortAccountId: wallet.openfortAccountId,
        walletAddress: wallet.walletAddress,
        agentOpenfortAccountId:
          wallet.agentOpenfortAccountId ?? defaultAgentOpenfortAccountId(socialId),
        agentWalletAddress: wallet.agentWalletAddress ?? defaultAgentWalletAddress(socialId),
        agentKeyHash: wallet.agentKeyHash ?? defaultAgentKeyHash(socialId),
      },
    });
    await prisma.walletChainAuthorization.create({
      data: {
        walletId: userWallet.id,
        chainId: BigInt(TEST_CHAIN_ID),
        status: 'registered',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const key = await apiKeyService.createApiKey(user.id, {
      name: keyName,
      permissions: {
        canSign: true,
        canSendTransaction: true,
        canReadTransactionStatus: true,
      },
      // Supertest uses a loopback address that may be represented as IPv4,
      // IPv6, or an IPv4-mapped IPv6 address depending on the Node runtime.
      allowedIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
    });
    const storedKey = await prisma.apiKey.findFirstOrThrow({
      where: { userId: user.id, name: keyName },
    });

    return { userId: user.id, keyId: storedKey.id, rawKey: key.rawKey };
  }

  function defaultAgentOpenfortAccountId(socialId: string): string {
    return socialId === 'test_social_id_e2e'
      ? 'ofa_test_agent_account_123'
      : `ofa_${socialId}_agent_account_123`;
  }

  function defaultAgentWalletAddress(socialId: string): string {
    return socialId === 'test_social_id_e2e'
      ? `0x${'4'.repeat(40)}`
      : `0x${hexFromText(socialId, 40)}`;
  }

  function defaultAgentKeyHash(socialId: string): string {
    return socialId === 'test_social_id_e2e'
      ? `0x${'3'.repeat(64)}`
      : `0x${hexFromText(`${socialId}_agent_key`, 64)}`;
  }

  function hexFromText(value: string, length: number): string {
    return Buffer.from(value).toString('hex').padEnd(length, '0').slice(0, length);
  }

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

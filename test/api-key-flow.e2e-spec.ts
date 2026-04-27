/**
 * E2E integration test: API Key → Wallet & Transaction flow.
 *
 * Tests the complete user journey:
 *   1. Authenticated user obtains an API Key
 *   2. Uses X-API-Key header to call wallet/transaction endpoints
 *   3. Verifies rejection on missing/invalid/revoked keys
 *
 * External dependencies mocked: OpenfortService (no real blockchain calls).
 * Real dependencies used: PostgreSQL (docker-compose).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/core/database/prisma.service';
import { ApiKeyService } from '../src/modules/api-key/api-key.service';
import { OpenfortService } from '../src/core/openfort/openfort.service';
import { API_KEY_PREFIX_LENGTH } from '../src/common/api-key/api-key-prefix';

// ── Test env vars (must be set before AppModule compiles) ──────────────
process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_fake_clerk_key_for_testing';
process.env.OPENFORT_API_KEY = 'sk_test_fake_openfort_key_for_testing';
process.env.OPENFORT_WALLET_SECRET = 'fake_wallet_secret_for_testing';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agent_wallet';

// ── Mock OpenfortService ───────────────────────────────────────────────
const mockOpenfortService = {
  createBackendWallet: jest.fn().mockResolvedValue({
    id: 'ofa_test_account_123',
    address: '0x1234567890abcdef1234567890abcdef12345678',
  }),
  createTransactionIntent: jest.fn().mockResolvedValue({
    id: 'tin_test_intent_456',
    status: 'pending',
  }),
};

// ── Test constants ─────────────────────────────────────────────────────
const TEST_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TEST_TARGET_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TEST_USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TEST_CHAIN_ID = 84532;

describe('API Key → Wallet & Transaction Flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let apiKeyService: ApiKeyService;
  let testUserId: string;
  let testApiKey: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OpenfortService)
      .useValue(mockOpenfortService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    apiKeyService = app.get(ApiKeyService);
  });

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();

    // Clean tables in dependency order
    await prisma.transaction.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.user.deleteMany();

    // Seed: user + wallet
    const user = await prisma.user.create({
      data: {
        socialProvider: 'google',
        socialId: 'test_social_id_e2e',
        email: 'e2e-test@example.com',
      },
    });

    await prisma.userWallet.create({
      data: {
        userId: user.id,
        openfortAccountId: 'ofa_test_account_123',
        walletAddress: TEST_WALLET_ADDRESS,
        chainId: BigInt(TEST_CHAIN_ID),
      },
    });

    testUserId = user.id;

    // Generate a real API key through the service (exercises hash + salt logic)
    const keyResult = await apiKeyService.createApiKey(user.id, 'E2E Test Key');
    testApiKey = keyResult.rawKey;
  });

  afterAll(async () => {
    // Final cleanup
    await prisma.transaction.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  // ════════════════════════════════════════════════════════════════════
  //  POSITIVE CASES — valid API key
  // ════════════════════════════════════════════════════════════════════

  describe('Wallet endpoints with valid API Key', () => {
    it('POST /v1/wallets/deposit-info → returns wallet address and chain info', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', testApiKey)
        .expect(201);

      expect(res.body).toEqual({
        walletAddress: TEST_WALLET_ADDRESS,
        chainId: TEST_CHAIN_ID,
        status: 'active',
        supportedTokens: ['USDC', 'ETH'],
      });
    });

    it('POST /v1/wallets/withdraw → creates withdrawal intent via Openfort', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/withdraw')
        .set('X-API-Key', testApiKey)
        .send({
          to: TEST_TARGET_ADDRESS,
          amount: '1000000',
          token: 'USDC',
        })
        .expect(201);

      // Response shape
      expect(res.body).toMatchObject({
        transactionId: expect.any(String),
        intentId: 'tin_test_intent_456',
        status: 'pending',
      });

      // Openfort was called with correct params
      expect(mockOpenfortService.createTransactionIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: TEST_CHAIN_ID,
          accountId: 'ofa_test_account_123',
          interactions: [
            expect.objectContaining({
              contract: TEST_USDC_CONTRACT, // Base Sepolia USDC
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '1000000'],
            }),
          ],
        }),
      );

      // Transaction persisted in DB
      const dbTx = await prisma.transaction.findFirst({
        where: { userId: testUserId },
      });
      expect(dbTx).toBeTruthy();
      expect(dbTx!.intentId).toBe('tin_test_intent_456');
      expect(dbTx!.status).toBe('pending');
    });
  });

  describe('Transaction endpoints with valid API Key', () => {
    it('POST /v1/transactions/intent → submits transaction intent', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '500000'],
            },
          ],
        })
        .expect(201);

      expect(res.body).toMatchObject({
        transactionId: expect.any(String),
        intentId: 'tin_test_intent_456',
        status: 'pending',
      });

      expect(mockOpenfortService.createTransactionIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: TEST_CHAIN_ID,
          accountId: 'ofa_test_account_123',
        }),
      );
    });

    it('POST /v1/transactions/intent → supports optional policyId', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          policyId: 'pol_usdc_gas_policy',
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'approve',
              functionArgs: [TEST_TARGET_ADDRESS, '999999'],
            },
          ],
        })
        .expect(201);

      expect(res.body.intentId).toBe('tin_test_intent_456');

      expect(mockOpenfortService.createTransactionIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          policyId: 'pol_usdc_gas_policy',
        }),
      );
    });

    it('GET /v1/transactions/history → returns paginated list', async () => {
      // Seed: create two transactions via the API
      await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '100'],
            },
          ],
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/v1/wallets/withdraw')
        .set('X-API-Key', testApiKey)
        .send({ to: TEST_TARGET_ADDRESS, amount: '200', token: 'USDC' })
        .expect(201);

      // Query history
      const res = await request(app.getHttpServer())
        .get('/v1/transactions/history')
        .set('X-API-Key', testApiKey)
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);

      // Most recent first
      for (const tx of res.body.transactions) {
        expect(tx).toMatchObject({
          id: expect.any(String),
          intentId: expect.any(String),
          status: 'pending',
          chainId: TEST_CHAIN_ID,
          createdAt: expect.any(String),
        });
      }
    });

    it('GET /v1/transactions/history → respects limit and offset', async () => {
      // Create 3 transactions
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/v1/transactions/intent')
          .set('X-API-Key', testApiKey)
          .send({
            chainId: TEST_CHAIN_ID,
            interactions: [
              {
                contract: TEST_USDC_CONTRACT,
                functionName: 'transfer',
                functionArgs: [TEST_TARGET_ADDRESS, String(i * 100)],
              },
            ],
          })
          .expect(201);
      }

      const res = await request(app.getHttpServer())
        .get('/v1/transactions/history?limit=2&offset=1')
        .set('X-API-Key', testApiKey)
        .expect(200);

      expect(res.body.total).toBe(3);
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(1);
    });

    it('POST /v1/transactions/batch → submits batch with multiple interactions', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/transactions/batch')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '100000'],
            },
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: ['0x1111111111111111111111111111111111111111', '200000'],
            },
          ],
        })
        .expect(201);

      expect(res.body).toMatchObject({
        transactionId: expect.any(String),
        intentId: 'tin_test_intent_456',
        status: 'pending',
      });

      // Openfort received both interactions
      expect(mockOpenfortService.createTransactionIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          interactions: expect.arrayContaining([
            expect.objectContaining({ functionArgs: [TEST_TARGET_ADDRESS, '100000'] }),
            expect.objectContaining({
              functionArgs: ['0x1111111111111111111111111111111111111111', '200000'],
            }),
          ]),
        }),
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  NEGATIVE CASES — authentication failures
  // ════════════════════════════════════════════════════════════════════

  describe('Missing API Key → 401', () => {
    it('POST /v1/wallets/deposit-info without auth → 401', async () => {
      const res = await request(app.getHttpServer()).post('/v1/wallets/deposit-info').expect(401);

      expect(res.body.message).toMatch(/Missing authentication/i);
    });

    it('POST /v1/wallets/withdraw without auth → 401', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/withdraw')
        .send({ to: TEST_TARGET_ADDRESS, amount: '100', token: 'USDC' })
        .expect(401);
    });

    it('POST /v1/transactions/intent without auth → 401', async () => {
      await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '100'],
            },
          ],
        })
        .expect(401);
    });

    it('GET /v1/transactions/history without auth → 401', async () => {
      await request(app.getHttpServer()).get('/v1/transactions/history').expect(401);
    });
  });

  describe('Invalid API Key → 401', () => {
    it('rejects a completely fabricated key', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', 'sk_00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        .expect(401);

      expect(res.body.message).toMatch(/Invalid API key/i);
    });

    it('rejects a key with correct prefix but wrong secret', async () => {
      // Use the real prefix but change the rest
      const prefix = testApiKey.substring(0, API_KEY_PREFIX_LENGTH);
      const fakeKey = prefix + 'x'.repeat(testApiKey.length - API_KEY_PREFIX_LENGTH);

      await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', fakeKey)
        .expect(401);
    });

    it('rejects an empty X-API-Key header', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', '')
        .expect(401);
    });
  });

  describe('Revoked API Key → 401', () => {
    it('rejects a single revoked key', async () => {
      // Get the key ID
      const keys = await apiKeyService.listApiKeys(testUserId);
      expect(keys.length).toBe(1);

      // Revoke it
      await apiKeyService.revokeApiKey(keys[0].id, testUserId);

      // Attempt to use it
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', testApiKey)
        .expect(401);

      expect(res.body.message).toMatch(/Invalid API key/i);
    });

    it('rejects after revokeAllKeys', async () => {
      await apiKeyService.revokeAllKeys(testUserId);

      await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '100'],
            },
          ],
        })
        .expect(401);
    });

    it('new key works after old key is revoked', async () => {
      // Revoke old key
      await apiKeyService.revokeAllKeys(testUserId);

      // Generate a new key
      const newKeyResult = await apiKeyService.createApiKey(testUserId, 'Refreshed Key');

      // Old key fails
      await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', testApiKey)
        .expect(401);

      // New key works
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', newKeyResult.rawKey)
        .expect(201);

      expect(res.body.walletAddress).toBe(TEST_WALLET_ADDRESS);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  VALIDATION — request body validation
  // ════════════════════════════════════════════════════════════════════

  describe('Request body validation', () => {
    it('POST /v1/wallets/withdraw → rejects invalid address', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/withdraw')
        .set('X-API-Key', testApiKey)
        .send({ to: 'not-an-address', amount: '100', token: 'USDC' })
        .expect(400);
    });

    it('POST /v1/wallets/withdraw → rejects unsupported token', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/withdraw')
        .set('X-API-Key', testApiKey)
        .send({ to: TEST_TARGET_ADDRESS, amount: '100', token: 'DOGE' })
        .expect(400);
    });

    it('POST /v1/transactions/intent → rejects missing interactions', async () => {
      await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({ chainId: TEST_CHAIN_ID })
        .expect(400);
    });

    it('POST /v1/transactions/intent → rejects invalid contract address', async () => {
      await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: 'invalid',
              functionName: 'transfer',
            },
          ],
        })
        .expect(400);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  //  ISOLATION — API key scopes correct user data
  // ════════════════════════════════════════════════════════════════════

  describe('User isolation', () => {
    it('API key only accesses its own wallet data', async () => {
      // Create a second user with a different wallet
      const user2 = await prisma.user.create({
        data: {
          socialProvider: 'discord',
          socialId: 'test_social_id_user2',
          email: 'user2@example.com',
        },
      });

      await prisma.userWallet.create({
        data: {
          userId: user2.id,
          openfortAccountId: 'ofa_user2_account',
          walletAddress: '0xaaaaaaaabbbbbbbbccccccccddddddddeeeeeeee',
          chainId: BigInt(TEST_CHAIN_ID),
        },
      });

      const user2Key = await apiKeyService.createApiKey(user2.id, 'User2 Key');

      // User 1 sees their own wallet
      const res1 = await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', testApiKey)
        .expect(201);
      expect(res1.body.walletAddress).toBe(TEST_WALLET_ADDRESS);

      // User 2 sees their own wallet
      const res2 = await request(app.getHttpServer())
        .post('/v1/wallets/deposit-info')
        .set('X-API-Key', user2Key.rawKey)
        .expect(201);
      expect(res2.body.walletAddress).toBe('0xaaaaaaaabbbbbbbbccccccccddddddddeeeeeeee');
    });

    it('transaction history is isolated per user', async () => {
      // User 1 creates a transaction
      await request(app.getHttpServer())
        .post('/v1/transactions/intent')
        .set('X-API-Key', testApiKey)
        .send({
          chainId: TEST_CHAIN_ID,
          interactions: [
            {
              contract: TEST_USDC_CONTRACT,
              functionName: 'transfer',
              functionArgs: [TEST_TARGET_ADDRESS, '100'],
            },
          ],
        })
        .expect(201);

      // Create user 2 with a key
      const user2 = await prisma.user.create({
        data: {
          socialProvider: 'twitter',
          socialId: 'test_social_id_user2_hist',
          email: 'user2hist@example.com',
        },
      });
      await prisma.userWallet.create({
        data: {
          userId: user2.id,
          openfortAccountId: 'ofa_user2_hist_account',
          walletAddress: '0xbbbbbbbbccccccccddddddddeeeeeeeeffffffff',
          chainId: BigInt(TEST_CHAIN_ID),
        },
      });
      const user2Key = await apiKeyService.createApiKey(user2.id, 'U2');

      // User 2 sees empty history
      const res = await request(app.getHttpServer())
        .get('/v1/transactions/history')
        .set('X-API-Key', user2Key.rawKey)
        .expect(200);

      expect(res.body.total).toBe(0);
      expect(res.body.transactions).toHaveLength(0);
    });
  });
});

import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { StepUpService } from './step-up.service';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));

describe('StepUpService', () => {
  const mockUserId = 'user-1';
  const mockOtherUserId = 'other-user';
  const mockChallengeId = '550e8400-e29b-41d4-a716-446655440000';
  const mockCodeHash = 'argon2-mock-hash';
  const now = new Date('2026-05-27T12:00:00.000Z');

  let prisma: any;
  let service: StepUpService;
  let originalFetch: typeof global.fetch;
  let originalNodeEnv: string | undefined;
  let originalWebhookUrl: string | undefined;
  let originalWebhookSecret: string | undefined;

  function createMockChallenge(overrides: Record<string, unknown> = {}) {
    return {
      id: mockChallengeId,
      userId: mockUserId,
      type: 'email_otp',
      challengeCodeHash: mockCodeHash,
      proofToken: null,
      verified: false,
      attempts: 0,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      verifiedAt: null,
      createdAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(now);
    originalFetch = global.fetch;
    originalNodeEnv = process.env.NODE_ENV;
    originalWebhookUrl = process.env.STEP_UP_OTP_WEBHOOK_URL;
    originalWebhookSecret = process.env.STEP_UP_OTP_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'test';
    delete process.env.STEP_UP_OTP_WEBHOOK_URL;
    delete process.env.STEP_UP_OTP_WEBHOOK_SECRET;

    prisma = {
      user: {
        findUnique: jest.fn(),
      },
      stepUpChallenge: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    // Default mock responses
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    prisma.stepUpChallenge.count.mockResolvedValue(0);
    prisma.stepUpChallenge.create.mockImplementation(
      async ({ data }: any) => ({
        id: mockChallengeId,
        ...data,
        createdAt: now,
      }),
    );
    prisma.stepUpChallenge.findUnique.mockResolvedValue(null);
    prisma.stepUpChallenge.findFirst.mockResolvedValue(null);
    prisma.stepUpChallenge.update.mockImplementation(
      async ({ data }: any) => createMockChallenge({ ...data }),
    );
    prisma.stepUpChallenge.deleteMany.mockResolvedValue({ count: 0 });

    jest.mocked(argon2.hash).mockResolvedValue(mockCodeHash as never);
    jest.mocked(argon2.verify).mockResolvedValue(true as never);

    service = new StepUpService(prisma as any);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    restoreEnvValue('NODE_ENV', originalNodeEnv);
    restoreEnvValue('STEP_UP_OTP_WEBHOOK_URL', originalWebhookUrl);
    restoreEnvValue('STEP_UP_OTP_WEBHOOK_SECRET', originalWebhookSecret);
  });

  // ── createChallenge ──────────────────────────────────────────────

  describe('createChallenge', () => {
    it('creates a challenge with hashed OTP, returns challengeId and code', async () => {
      const result = await service.createChallenge(mockUserId);

      expect(result).toMatchObject({
        challengeId: mockChallengeId,
        code: expect.stringMatching(/^\d{6}$/),
      });

      expect(argon2.hash).toHaveBeenCalledWith(result.code, {
        type: 2,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      });

      expect(prisma.stepUpChallenge.create).toHaveBeenCalledWith({
        data: {
          userId: mockUserId,
          type: 'email_otp',
          challengeCodeHash: mockCodeHash,
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        },
      });
    });

    it('rate limits when 5 or more challenges exist in the last hour', async () => {
      prisma.stepUpChallenge.count.mockResolvedValue(5);

      await expect(service.createChallenge(mockUserId)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.stepUpChallenge.create).not.toHaveBeenCalled();
    });

    it('rate limit query covers the last 60 minutes', async () => {
      await service.createChallenge(mockUserId);

      expect(prisma.stepUpChallenge.count).toHaveBeenCalledWith({
        where: {
          userId: mockUserId,
          createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
        },
      });
    });

    it('passes the count threshold for rate limiting', async () => {
      prisma.stepUpChallenge.count.mockResolvedValue(4);

      const result = await service.createChallenge(mockUserId);

      expect(result.challengeId).toBe(mockChallengeId);
      expect(prisma.stepUpChallenge.create).toHaveBeenCalled();
    });

    it('uses the provided type when specified', async () => {
      const result = await service.createChallenge(mockUserId, 'email_otp');

      expect(prisma.stepUpChallenge.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'email_otp' }),
        }),
      );
      expect(result.challengeId).toBe(mockChallengeId);
    });

    it('delivers production OTP challenges to the configured webhook', async () => {
      process.env.NODE_ENV = 'production';
      process.env.STEP_UP_OTP_WEBHOOK_URL = 'https://otp.example.com/send';
      process.env.STEP_UP_OTP_WEBHOOK_SECRET = 'delivery-secret';
      global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

      const result = await service.createChallenge(mockUserId, 'email_otp', 'user@example.com');

      expect(global.fetch).toHaveBeenCalledWith('https://otp.example.com/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'sofa-one-step-up/1.0',
          Authorization: 'Bearer delivery-secret',
        },
        body: JSON.stringify({
          type: 'step_up_otp',
          userId: mockUserId,
          email: 'user@example.com',
          challengeId: mockChallengeId,
          code: result.code,
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
        }),
      });
    });

    it('deletes the challenge and fails when production OTP delivery fails', async () => {
      process.env.NODE_ENV = 'production';
      process.env.STEP_UP_OTP_WEBHOOK_URL = 'https://otp.example.com/send';
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 } as Response);

      await expect(
        service.createChallenge(mockUserId, 'email_otp', 'user@example.com'),
      ).rejects.toThrow(BadGatewayException);

      expect(prisma.stepUpChallenge.deleteMany).toHaveBeenCalledWith({
        where: { id: mockChallengeId },
      });
    });
  });

  // ── verifyChallenge ──────────────────────────────────────────────

  describe('verifyChallenge', () => {
    const otp = '123456';

    it('successfully verifies correct OTP and returns proof token', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({ attempts: 0 }),
      );
      prisma.stepUpChallenge.update
        .mockResolvedValueOnce(createMockChallenge({ attempts: 1 })) // increment
        .mockResolvedValueOnce(createMockChallenge({ verified: true })); // verify

      const result = await service.verifyChallenge(
        mockUserId,
        mockChallengeId,
        otp,
      );

      expect(result).toMatchObject({
        proofToken: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      });

      expect(argon2.verify).toHaveBeenCalledWith(mockCodeHash, otp);

      expect(prisma.stepUpChallenge.update).toHaveBeenNthCalledWith(1, {
        where: { id: mockChallengeId },
        data: { attempts: { increment: 1 } },
      });

      expect(prisma.stepUpChallenge.update).toHaveBeenNthCalledWith(2, {
        where: { id: mockChallengeId },
        data: {
          verified: true,
          proofToken: result.proofToken,
          verifiedAt: now,
          expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        },
      });
    });

    it('throws NotFoundException for unknown challenge', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyChallenge(mockUserId, 'unknown-id', otp),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stepUpChallenge.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when challenge belongs to different user', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({ userId: mockOtherUserId }),
      );

      await expect(
        service.verifyChallenge(mockUserId, mockChallengeId, otp),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.stepUpChallenge.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when challenge already verified', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({ verified: true }),
      );

      await expect(
        service.verifyChallenge(mockUserId, mockChallengeId, otp),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.stepUpChallenge.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when challenge expired', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({
          expiresAt: new Date(now.getTime() - 1000),
        }),
      );

      await expect(
        service.verifyChallenge(mockUserId, mockChallengeId, otp),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.stepUpChallenge.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException after MAX_ATTEMPTS (5) exceeded', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({ attempts: 5 }),
      );
      // After increment: attempts → 6, which is > 5
      prisma.stepUpChallenge.update.mockResolvedValueOnce(
        createMockChallenge({ attempts: 6 }),
      );

      await expect(
        service.verifyChallenge(mockUserId, mockChallengeId, otp),
      ).rejects.toThrow(BadRequestException);

      expect(argon2.verify).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for wrong OTP code', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({ attempts: 0 }),
      );
      prisma.stepUpChallenge.update.mockResolvedValueOnce(
        createMockChallenge({ attempts: 1 }),
      );
      jest.mocked(argon2.verify).mockResolvedValue(false as never);

      await expect(
        service.verifyChallenge(mockUserId, mockChallengeId, 'wrong-code'),
      ).rejects.toThrow(BadRequestException);

      expect(argon2.verify).toHaveBeenCalledWith(mockCodeHash, 'wrong-code');
      // Should NOT have set verified=true
      expect(prisma.stepUpChallenge.update).toHaveBeenCalledTimes(1); // only the attempt increment
    });

    it('increments attempts even when verification fails', async () => {
      prisma.stepUpChallenge.findUnique.mockResolvedValue(
        createMockChallenge({ attempts: 2 }),
      );
      prisma.stepUpChallenge.update.mockResolvedValueOnce(
        createMockChallenge({ attempts: 3 }),
      );
      jest.mocked(argon2.verify).mockResolvedValue(false as never);

      await expect(
        service.verifyChallenge(mockUserId, mockChallengeId, 'wrong'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.stepUpChallenge.update).toHaveBeenCalledWith({
        where: { id: mockChallengeId },
        data: { attempts: { increment: 1 } },
      });
    });
  });

  // ── validateProof ──────────────────────────────────────────────

  describe('validateProof', () => {
    const proofToken = 'a'.repeat(64);

    it('returns true for valid proof token belonging to user', async () => {
      prisma.stepUpChallenge.findFirst.mockResolvedValue(
        createMockChallenge({
          proofToken,
          verified: true,
          expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        }),
      );

      const result = await service.validateProof(proofToken, mockUserId);

      expect(result).toBe(true);
      expect(prisma.stepUpChallenge.findFirst).toHaveBeenCalledWith({
        where: {
          proofToken,
          verified: true,
          expiresAt: { gt: now },
        },
      });
    });

    it('returns false when no challenge matches the proof token', async () => {
      prisma.stepUpChallenge.findFirst.mockResolvedValue(null);

      const result = await service.validateProof('nonexistent', mockUserId);

      expect(result).toBe(false);
    });

    it('returns false when proof belongs to a different user', async () => {
      prisma.stepUpChallenge.findFirst.mockResolvedValue(
        createMockChallenge({
          userId: mockOtherUserId,
          proofToken,
          verified: true,
          expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        }),
      );

      const result = await service.validateProof(proofToken, mockUserId);

      expect(result).toBe(false);
    });

    it('returns false when challenge is not verified (verified=false does not match where clause)', async () => {
      // The findFirst query includes verified: true, so Prisma returns null
      // for unverified challenges. The mock simulates this by returning null.
      prisma.stepUpChallenge.findFirst.mockResolvedValue(null);

      const result = await service.validateProof(proofToken, mockUserId);

      expect(result).toBe(false);
      expect(prisma.stepUpChallenge.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ verified: true }),
      });
    });

    it('queries with correct where clause', async () => {
      await service.validateProof(proofToken, mockUserId);

      expect(prisma.stepUpChallenge.findFirst).toHaveBeenCalledWith({
        where: {
          proofToken,
          verified: true,
          expiresAt: { gt: now },
        },
      });
    });
  });

  // ── cleanupExpiredChallenges ────────────────────────────────────

  describe('cleanupExpiredChallenges', () => {
    it('deletes expired challenges and returns count', async () => {
      prisma.stepUpChallenge.deleteMany.mockResolvedValue({ count: 5 });

      const result = await service.cleanupExpiredChallenges();

      expect(result).toBe(5);
      expect(prisma.stepUpChallenge.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: now } },
      });
    });

    it('returns 0 when no challenges are expired', async () => {
      prisma.stepUpChallenge.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.cleanupExpiredChallenges();

      expect(result).toBe(0);
    });
  });
});

function restoreEnvValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

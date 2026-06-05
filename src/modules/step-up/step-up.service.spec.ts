import * as argon2 from 'argon2';
import { StepUpService } from './step-up.service';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));

describe('StepUpService', () => {
  const mockUserId = 'user-1';
  const mockChallengeId = '550e8400-e29b-41d4-a716-446655440000';
  const mockCodeHash = 'argon2-mock-hash';
  const now = new Date('2026-05-27T12:00:00.000Z');

  let prisma: any;
  let service: StepUpService;
  let originalNodeEnv: string | undefined;

  function createMockChallenge(overrides: Record<string, unknown> = {}) {
    return {
      id: mockChallengeId,
      userId: mockUserId,
      type: 'totp_mfa',
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
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

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
    restoreEnvValue('NODE_ENV', originalNodeEnv);
  });

  // ── validateProof ──────────────────────────────────────────────

  describe('validateProof', () => {
    const proofToken = 'a'.repeat(64);

    it('returns true for valid totp_mfa proof token belonging to user', async () => {
      prisma.stepUpChallenge.findFirst.mockResolvedValue(
        createMockChallenge({
          proofToken,
          verified: true,
          expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        }),
      );

      const result = await (service as any).validateProof(proofToken, mockUserId, 'totp_mfa');

      expect(result).toBe(true);
      expect(prisma.stepUpChallenge.findFirst).toHaveBeenCalledWith({
        where: {
          proofToken,
          type: 'totp_mfa',
          verified: true,
          expiresAt: { gt: now },
        },
      });
    });

    it('defaults proof validation to totp_mfa', async () => {
      prisma.stepUpChallenge.findFirst.mockResolvedValue(
        createMockChallenge({ proofToken, verified: true }),
      );

      await (service as any).validateProof(proofToken, mockUserId);

      expect(prisma.stepUpChallenge.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ type: 'totp_mfa' }),
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
          userId: 'user-2',
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
      await (service as any).validateProof(proofToken, mockUserId, 'totp_mfa');

      expect(prisma.stepUpChallenge.findFirst).toHaveBeenCalledWith({
        where: {
          proofToken,
          type: 'totp_mfa',
          verified: true,
          expiresAt: { gt: now },
        },
      });
    });
  });

  describe('createProof', () => {
    it('creates a verified totp_mfa proof by default', async () => {
      jest.mocked(argon2.hash).mockResolvedValueOnce('hashed-proof' as never);

      const result = await service.createProof(mockUserId);

      expect(result.proofToken).toMatch(/^[a-f0-9]{64}$/);
      expect(prisma.stepUpChallenge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUserId,
          type: 'totp_mfa',
          verified: true,
          proofToken: result.proofToken,
        }),
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

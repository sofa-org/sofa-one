jest.mock('../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));
jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

import { StepUpController } from './step-up.controller';
import { StepUpService } from './step-up.service';

describe('StepUpController', () => {
  let controller: StepUpController;
  let mockStepUpService: jest.Mocked<StepUpService>;
  let originalNodeEnv: string | undefined;

  const mockUserId = 'user-1';
  const mockChallengeId = '550e8400-e29b-41d4-a716-446655440000';
  const mockCode = '123456';
  const mockProofToken = 'a'.repeat(64);
  const mockExpiresAt = new Date('2026-05-27T12:15:00.000Z');

  function createMockReq(overrides: Record<string, unknown> = {}) {
    return {
      user: { id: mockUserId },
      openfortEmail: 'user@example.com',
      ...overrides,
    };
  }

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    mockStepUpService = {
      createChallenge: jest.fn(),
      verifyChallenge: jest.fn(),
      validateProof: jest.fn(),
      cleanupExpiredChallenges: jest.fn(),
    } as any;

    controller = new StepUpController(mockStepUpService);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── createChallenge ────────────────────────────────────────────

  describe('createChallenge', () => {
    it('returns challengeId and OTP code from service (non-production)', async () => {
      // NODE_ENV is undefined (development-like)
      mockStepUpService.createChallenge.mockResolvedValue({
        challengeId: mockChallengeId,
        code: mockCode,
      });

      const result = await controller.createChallenge(
        createMockReq(),
        { type: 'email_otp' },
      );

      expect(result).toEqual({
        challengeId: mockChallengeId,
        code: mockCode,
      });
      expect(mockStepUpService.createChallenge).toHaveBeenCalledWith(
        mockUserId,
        'email_otp',
        'user@example.com',
      );
    });

    it('includes code in response when NODE_ENV is development', async () => {
      process.env.NODE_ENV = 'development';
      mockStepUpService.createChallenge.mockResolvedValue({
        challengeId: mockChallengeId,
        code: mockCode,
      });

      const result = await controller.createChallenge(
        createMockReq(),
        { type: 'email_otp' },
      );

      expect(result).toEqual({
        challengeId: mockChallengeId,
        code: mockCode,
      });
    });

    it('omits code from response when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      mockStepUpService.createChallenge.mockResolvedValue({
        challengeId: mockChallengeId,
        code: mockCode,
      });

      const result = await controller.createChallenge(
        createMockReq(),
        { type: 'email_otp' },
      );

      expect(result).toEqual({ challengeId: mockChallengeId });
      expect(result).not.toHaveProperty('code');
    });

    it('extracts userId from request user object', async () => {
      mockStepUpService.createChallenge.mockResolvedValue({
        challengeId: mockChallengeId,
        code: mockCode,
      });

      await controller.createChallenge(createMockReq(), { type: 'email_otp' });

      expect(mockStepUpService.createChallenge).toHaveBeenCalledWith(
        mockUserId,
        expect.any(String),
        'user@example.com',
      );
    });

    it('passes the DTO type to the service', async () => {
      mockStepUpService.createChallenge.mockResolvedValue({
        challengeId: mockChallengeId,
        code: mockCode,
      });

      await controller.createChallenge(createMockReq(), {
        type: 'email_otp',
      });

      expect(mockStepUpService.createChallenge).toHaveBeenCalledWith(
        mockUserId,
        'email_otp',
        'user@example.com',
      );
    });

    it('falls back to persisted user email when session email is missing', async () => {
      mockStepUpService.createChallenge.mockResolvedValue({
        challengeId: mockChallengeId,
        code: mockCode,
      });

      await controller.createChallenge(
        createMockReq({
          openfortEmail: undefined,
          user: { id: mockUserId, email: 'stored@example.com' },
        }),
        { type: 'email_otp' },
      );

      expect(mockStepUpService.createChallenge).toHaveBeenCalledWith(
        mockUserId,
        'email_otp',
        'stored@example.com',
      );
    });
  });

  // ── verifyChallenge ────────────────────────────────────────────

  describe('verifyChallenge', () => {
    it('returns proofToken and expiresAt from service', async () => {
      mockStepUpService.verifyChallenge.mockResolvedValue({
        proofToken: mockProofToken,
        expiresAt: mockExpiresAt,
      });

      const result = await controller.verifyChallenge(createMockReq(), {
        challengeId: mockChallengeId,
        code: mockCode,
      });

      expect(result).toEqual({
        proofToken: mockProofToken,
        expiresAt: mockExpiresAt.toISOString(),
      });
      expect(mockStepUpService.verifyChallenge).toHaveBeenCalledWith(
        mockUserId,
        mockChallengeId,
        mockCode,
      );
    });

    it('extracts req.user.id, challengeId, and code for the service call', async () => {
      mockStepUpService.verifyChallenge.mockResolvedValue({
        proofToken: mockProofToken,
        expiresAt: mockExpiresAt,
      });

      await controller.verifyChallenge(createMockReq(), {
        challengeId: mockChallengeId,
        code: mockCode,
      });

      expect(mockStepUpService.verifyChallenge).toHaveBeenCalledWith(
        mockUserId,
        mockChallengeId,
        mockCode,
      );
    });
  });
});

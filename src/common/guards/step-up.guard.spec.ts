import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StepUpGuard } from './step-up.guard';
import { StepUpService } from '../../modules/step-up/step-up.service';

describe('StepUpGuard', () => {
  let guard: StepUpGuard;
  let mockStepUpService: jest.Mocked<StepUpService>;
  let reflector: Reflector;

  const mockUserId = 'user-1';
  const mockProofToken = 'a'.repeat(64);

  function createMockExecutionContext(
    overrides: Record<string, unknown> = {},
  ): any {
    const request: any = {
      headers: { 'x-step-up-token': mockProofToken },
      user: { id: mockUserId },
      ...overrides,
    };

    return {
      switchToHttp: jest.fn(() => ({
        getRequest: jest.fn(() => request),
      })),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    };
  }

  beforeEach(() => {
    mockStepUpService = {
      validateProof: jest.fn(),
      cleanupExpiredChallenges: jest.fn(),
    } as any;

    reflector = new Reflector();
    guard = new StepUpGuard(reflector, mockStepUpService);
  });

  describe('when @RequireStepUp() is set', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    });

    it('allows request with a valid proof token', async () => {
      mockStepUpService.validateProof.mockResolvedValue(true);

      const context = createMockExecutionContext();

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(mockStepUpService.validateProof).toHaveBeenCalledWith(
        mockProofToken,
        mockUserId,
        'totp_mfa',
      );
    });

    it('throws ForbiddenException when X-Step-Up-Token header is missing', async () => {
      const context = createMockExecutionContext({
        headers: {},
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(mockStepUpService.validateProof).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException with descriptive message when header is missing', async () => {
      const context = createMockExecutionContext({
        headers: {},
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        'Step-up verification required',
      );
    });

    it('throws ForbiddenException when user is not authenticated on the request', async () => {
      const context = createMockExecutionContext({
        user: undefined,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(mockStepUpService.validateProof).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when request.user has no id', async () => {
      const context = createMockExecutionContext({
        user: {},
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(mockStepUpService.validateProof).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when proof token is invalid or expired', async () => {
      mockStepUpService.validateProof.mockResolvedValue(false);

      const context = createMockExecutionContext();

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(mockStepUpService.validateProof).toHaveBeenCalledWith(
        mockProofToken,
        mockUserId,
        'totp_mfa',
      );
    });

    it('throws ForbiddenException with descriptive message when proof is invalid', async () => {
      mockStepUpService.validateProof.mockResolvedValue(false);

      const context = createMockExecutionContext();

      await expect(guard.canActivate(context)).rejects.toThrow(
        'Invalid or expired step-up verification',
      );
    });

    it('passes the correct proof token and userId to the service', async () => {
      mockStepUpService.validateProof.mockResolvedValue(true);

      const customToken = 'custom-proof-token-123';
      const context = createMockExecutionContext({
        headers: { 'x-step-up-token': customToken },
      });

      await guard.canActivate(context);

      expect(mockStepUpService.validateProof).toHaveBeenCalledWith(
        customToken,
        mockUserId,
        'totp_mfa',
      );
    });
  });

  describe('when @RequireStepUp() is NOT set', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    });

    it('allows request without step-up verification', async () => {
      const context = createMockExecutionContext({ headers: {} });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(mockStepUpService.validateProof).not.toHaveBeenCalled();
    });
  });
});

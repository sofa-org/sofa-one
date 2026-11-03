import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { RequireStepUp } from '../decorators/step-up.decorator';
import { StepUpGuard } from './step-up.guard';
import { StepUpService } from '../../modules/step-up/step-up.service';

class SensitiveRoute {
  @RequireStepUp()
  handle() {}
}

describe('StepUpGuard', () => {
  function fixture(overrides: Record<string, unknown> = {}) {
    const request = { headers: { 'x-step-up-token': 'proof' }, user: { id: 'user-1' }, appSession: { id: 'session-1' }, stepUpVerified: false, ...overrides };
    const context = new ExecutionContextHost([request], SensitiveRoute, SensitiveRoute.prototype.handle);
    const validateProof = jest.fn().mockResolvedValue(true);
    // Guard tests only need the proof validation boundary, not persistence.
    const service = { validateProof } as unknown as StepUpService;
    return { request, context, validateProof, guard: new StepUpGuard(new Reflector(), service) };
  }

  it('passes the exact local user and session identity before marking request verified', async () => {
    const f = fixture();
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    expect(f.validateProof).toHaveBeenCalledWith('proof', 'user-1', 'session-1', 'totp_mfa');
    expect(f.request.stepUpVerified).toBe(true);
  });

  it.each([{ headers: {} }, { headers: { 'x-step-up-token': ['proof'] } }, { user: undefined }, { appSession: undefined }])('rejects absent/ambiguous credentials: %j', async (overrides) => {
    const f = fixture(overrides);
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(ForbiddenException);
    expect(f.validateProof).not.toHaveBeenCalled();
    expect(f.request.stepUpVerified).toBe(false);
  });

  it('does not trust a proof rejected for another session or revoked identity', async () => {
    const f = fixture();
    f.validateProof.mockResolvedValue(false);
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(ForbiddenException);
    expect(f.request.stepUpVerified).toBe(false);
  });
});

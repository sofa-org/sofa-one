import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StepUpService } from '../../modules/step-up/step-up.service';
import { STEP_UP_KEY } from '../decorators/step-up.decorator';

/**
 * Guard that validates a step-up proof token from the X-Step-Up-Token header.
 * Only activates on routes marked with @RequireStepUp() decorator.
 *
 * The proof token must be valid, not expired, and belong to the authenticated user.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly stepUpService: StepUpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip if route doesn't require step-up
    const requireStepUp = this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requireStepUp) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const proofToken = request.headers['x-step-up-token'] as string | undefined;
    const userId = request.user?.id;

    if (!proofToken) {
      throw new ForbiddenException('Step-up verification required. Provide X-Step-Up-Token header.');
    }

    if (!userId) {
      throw new ForbiddenException('Authentication required before step-up verification.');
    }

    const isValid = await this.stepUpService.validateProof(proofToken, userId, 'totp_mfa');
    if (!isValid) {
      throw new ForbiddenException('Invalid or expired step-up verification. Please verify again.');
    }

    // Defense-in-depth: mark request as step-up verified so downstream services
    // can enforce per-user step-up policies.
    request.stepUpVerified = true;

    return true;
  }
}

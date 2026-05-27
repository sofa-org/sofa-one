import { SetMetadata } from '@nestjs/common';

export const STEP_UP_KEY = 'requireStepUp';

/**
 * Decorator that marks a route as requiring step-up verification.
 * When applied, the StepUpGuard will validate the X-Step-Up-Token header.
 *
 * Usage:
 *   @RequireStepUp()
 *   @Post()
 *   async createApiKey() { ... }
 *
 * The frontend must first complete a step-up challenge/verify flow
 * and include the resulting proof token in the X-Step-Up-Token header.
 */
export const RequireStepUp = () => SetMetadata(STEP_UP_KEY, true);
import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StepUpService } from './step-up.service';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CreateChallengeDto, VerifyChallengeDto } from './dto/step-up.dto';

@Controller('v1/auth/step-up')
@FrontendOnly()
@UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
export class StepUpController {
  constructor(private readonly stepUpService: StepUpService) {}

  /**
   * POST /v1/auth/step-up/challenge
   * Creates a step-up challenge and sends an OTP to the user's email.
   * Returns the challenge ID (the OTP is delivered out-of-band).
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 10 } })
  @Post('challenge')
  async createChallenge(@Req() req: any, @Body() dto: CreateChallengeDto) {
    const result = await this.stepUpService.createChallenge(
      req.user.id,
      dto.type,
      req.openfortEmail ?? req.user.email,
    );

    // In production, the OTP is sent via email and should NOT be in the response.
    // For MVP, we return the code for testing purposes.
    // TODO: Remove code from response once email delivery is implemented.
    return {
      challengeId: result.challengeId,
      // code is intentionally omitted from production responses
      ...(process.env.NODE_ENV !== 'production' ? { code: result.code } : {}),
    };
  }

  /**
   * POST /v1/auth/step-up/verify
   * Verifies a step-up challenge OTP and issues a proof token.
   */
  @Throttle({ short: { ttl: 60000, limit: 5 } })
  @Post('verify')
  async verifyChallenge(@Req() req: any, @Body() dto: VerifyChallengeDto) {
    const result = await this.stepUpService.verifyChallenge(
      req.user.id,
      dto.challengeId,
      dto.code,
    );

    return {
      proofToken: result.proofToken,
      expiresAt: result.expiresAt.toISOString(),
    };
  }
}

import { Body, Controller, Post, Get, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { OpenfortAuthGuard } from '../../common/guards/openfort-auth.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { RequireStepUp } from '../../common/decorators/step-up.decorator';
import { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';
import { AgentRegistrationResultDto } from './dto/agent-registration-result.dto';
import { AgentRegistrationTransactionDto } from './dto/agent-registration-transaction.dto';

@Controller('auth')
@UseGuards(OpenfortAuthGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/session
   * Requires: Authorization: Bearer <openfort_iam_access_token>
   * Returns: { userId, wallet, wallets }
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('session')
  async syncSession(@Req() req: any) {
    return this.authService.syncOpenfortSession(
      req.openfortUserId,
      req.openfortEmail,
      req.ip ?? undefined,
      req.headers?.['user-agent'] ?? undefined,
    );
  }

  /** Compatibility alias for older frontend builds. */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('social')
  async socialLogin(@Req() req: any) {
    return this.authService.syncOpenfortSession(
      req.openfortUserId,
      req.openfortEmail,
      req.ip ?? undefined,
      req.headers?.['user-agent'] ?? undefined,
    );
  }

  /**
   * POST /auth/refresh-api-key
   * Revokes all existing API keys and issues a new one.
   * Returns: { apiKey }
   *
   * CSRF safety: requires a valid Openfort IAM token supplied as `Authorization: Bearer <token>`.
   * Browsers cannot attach custom Authorization headers cross-origin without a preflight,
   * so a forged cross-site request will never carry a valid token and will be rejected by
   * OpenfortAuthGuard before reaching this handler.
   */
  @Throttle({ short: { ttl: 60000, limit: 3 }, medium: { ttl: 3600000, limit: 10 } })
  @FrontendOnly()
  @RequireStepUp()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard, StepUpGuard)
  @Post('refresh-api-key')
  async refreshApiKey(@Req() req: any) {
    return this.authService.refreshApiKey(req.user.socialId);
  }

  /**
   * POST /auth/embedded-wallet/authorize
   * Verifies an Openfort embedded EOA belongs to the Openfort IAM session,
   * binds it as the user's asset account, and creates/returns backend agent registration details.
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/authorize')
  async authorizeEmbeddedWallet(@Req() req: any, @Body() body: AuthorizeEmbeddedWalletDto) {
    return this.authService.authorizeEmbeddedWallet(req.openfortUserId, req.openfortAccessToken, body);
  }

  /**
   * POST /auth/embedded-wallet/registration-transaction
   * Saves the submitted registerKey transaction hash so pending registration can be resumed.
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/registration-transaction')
  async markAgentRegistrationTransaction(
    @Req() req: any,
    @Body() body: AgentRegistrationTransactionDto,
  ) {
    return this.authService.markAgentRegistrationTransaction(req.openfortUserId, body.chainId, body.txHash, body.walletId);
  }

  /**
   * POST /auth/embedded-wallet/registration-result
   * Records the final receipt result for the Calibur agent-key registration transaction.
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/registration-result')
  async markAgentRegistrationResult(
    @Req() req: any,
    @Body() body: AgentRegistrationResultDto,
  ) {
    return this.authService.markAgentRegistrationResult(req.openfortUserId, body.chainId, body.status, body.txHash, body.walletId);
  }

  /**
   * GET /auth/me
   * Returns the current user's wallet info from DB.
   * Protected by OpenfortAuthGuard (global defaults apply — no custom throttle).
   */
  @Get('me')
  async getMe(@Req() req: any) {
    return this.authService.getMe(req.openfortUserId);
  }
}

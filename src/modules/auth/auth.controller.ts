import { Body, Controller, Post, Get, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { OpenfortAuthGuard } from '../../common/guards/openfort-auth.guard';
import { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';

@Controller('auth')
@UseGuards(OpenfortAuthGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/session
   * Requires: Authorization: Bearer <openfort_iam_access_token>
   * Returns: { userId, walletAddress, apiKey? }
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('session')
  async syncSession(@Req() req: any) {
    return this.authService.syncOpenfortSession(req.openfortUserId, req.openfortEmail);
  }

  /** Compatibility alias for older frontend builds. */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('social')
  async socialLogin(@Req() req: any) {
    return this.authService.syncOpenfortSession(req.openfortUserId, req.openfortEmail);
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
  @Post('refresh-api-key')
  async refreshApiKey(@Req() req: any) {
    return this.authService.refreshApiKey(req.openfortUserId);
  }

  /**
   * POST /auth/embedded-wallet/authorize
   * Verifies an Openfort embedded wallet belongs to the Openfort IAM session,
   * binds it as the user's asset wallet, and creates/returns backend agent registration details.
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/authorize')
  async authorizeEmbeddedWallet(@Req() req: any, @Body() body: AuthorizeEmbeddedWalletDto) {
    return this.authService.authorizeEmbeddedWallet(req.openfortUserId, body);
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

import { Body, Controller, Post, Get, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';
import { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';

@Controller('auth')
@UseGuards(ClerkAuthGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/social
   * Requires: Authorization: Bearer <clerk_jwt>
   * Returns: { userId, walletAddress, apiKey? }
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('social')
  async socialLogin(@Req() req: any) {
    return this.authService.handleSocialLogin(req.clerkUserId);
  }

  /**
   * POST /auth/refresh-api-key
   * Revokes all existing API keys and issues a new one.
   * Returns: { apiKey }
   *
   * CSRF safety: requires a valid Clerk JWT supplied as `Authorization: Bearer <token>`.
   * Browsers cannot attach custom Authorization headers cross-origin without a preflight,
   * so a forged cross-site request will never carry a valid token and will be rejected by
   * ClerkAuthGuard before reaching this handler.
   */
  @Throttle({ short: { ttl: 60000, limit: 3 }, medium: { ttl: 3600000, limit: 10 } })
  @Post('refresh-api-key')
  async refreshApiKey(@Req() req: any) {
    return this.authService.refreshApiKey(req.clerkUserId);
  }

  /**
   * POST /auth/embedded-wallet/authorize
   * Verifies an Openfort embedded wallet belongs to the Openfort IAM session,
   * binds it as the user's asset wallet, and creates/returns backend agent registration details.
   */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/authorize')
  async authorizeEmbeddedWallet(@Req() req: any, @Body() body: AuthorizeEmbeddedWalletDto) {
    return this.authService.authorizeEmbeddedWallet(req.clerkUserId, body);
  }

  /**
   * GET /auth/me
   * Returns the current user's wallet info from DB.
   * Protected by ClerkAuthGuard (global defaults apply — no custom throttle).
   */
  @Get('me')
  async getMe(@Req() req: any) {
    return this.authService.getMe(req.clerkUserId);
  }
}

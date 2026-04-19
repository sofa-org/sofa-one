import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';

@Controller('auth')
@UseGuards(ClerkAuthGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/social
   * Requires: Authorization: Bearer <clerk_jwt>
   * Returns: { userId, walletAddress, apiKey? }
   */
  @Post('social')
  async socialLogin(@Req() req: any) {
    return this.authService.handleSocialLogin(req.clerkUserId);
  }

  /**
   * POST /auth/refresh-api-key
   * Revokes all existing API keys and issues a new one.
   * Returns: { apiKey }
   */
  @Post('refresh-api-key')
  async refreshApiKey(@Req() req: any) {
    return this.authService.refreshApiKey(req.clerkUserId);
  }
}

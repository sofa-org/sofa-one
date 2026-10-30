import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { OpenfortAuthGuard } from '../../common/guards/openfort-auth.guard';
import { AppSessionGuard } from '../../common/guards/app-session.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { AllowPendingMfa } from '../../common/decorators/allow-pending-mfa.decorator';
import { RequireStepUp } from '../../common/decorators/step-up.decorator';
import { AppSessionService } from '../app-session/app-session.service';
import { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';
import { AgentRegistrationResultDto } from './dto/agent-registration-result.dto';
import { AgentRegistrationTransactionDto } from './dto/agent-registration-transaction.dto';

@Controller('auth')
@FrontendOnly()
export class AuthController {
  constructor(private readonly authService: AuthService, private readonly sessions: AppSessionService) {}

  /** The only dashboard login exchange: IAM proves identity, the opaque cookie grants app access. */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('session')
  @Header('Cache-Control', 'no-store')
  @UseGuards(FrontendOnlyGuard, OpenfortAuthGuard)
  async syncSession(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const synced = await this.authService.syncOpenfortSession(
      req.openfortUserId!, req.openfortEmail, req.ip, req.headers['user-agent'],
    );
    const { token, session } = await this.sessions.exchange(synced.userId, this.sessions.readToken(req));
    this.sessions.setCookie(res, token, session.expiresAt);
    return this.sessions.snapshot(session, token);
  }

  @Get('session')
  @AllowPendingMfa()
  @Header('Cache-Control', 'no-store')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard)
  getSession(@Req() req: Request) {
    return this.sessions.snapshot(req.appSession!, this.sessions.readToken(req)!);
  }

  @Delete('session')
  @HttpCode(204)
  @AllowPendingMfa()
  @Header('Cache-Control', 'no-store')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(req.user!.id, req.appSession!.id);
    this.sessions.clearCookie(res);
  }

  @Delete('sessions')
  @HttpCode(204)
  @RequireStepUp()
  @Header('Cache-Control', 'no-store')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard, StepUpGuard)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revokeAll(req.user!.id, req.appSession!.id);
    this.sessions.clearCookie(res);
  }

  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/authorize')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard, OpenfortAuthGuard)
  async authorizeEmbeddedWallet(@Req() req: Request, @Body() body: AuthorizeEmbeddedWalletDto) {
    // A fresh provider token may belong to a different wallet browser session.
    // Never mutate either wallet unless it proves the immutable local identity.
    if (req.openfortUserId !== req.user!.socialId) {
      throw new ForbiddenException('Wallet identity does not match application session');
    }
    return this.authService.authorizeEmbeddedWallet(req.user!.socialId, req.openfortAccessToken!, body);
  }

  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/registration-transaction')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard)
  async markAgentRegistrationTransaction(@Req() req: Request, @Body() body: AgentRegistrationTransactionDto) {
    return this.authService.markAgentRegistrationTransaction(req.user!.socialId, body.chainId, body.txHash, body.walletId);
  }

  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post('embedded-wallet/registration-result')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard)
  async markAgentRegistrationResult(@Req() req: Request, @Body() body: AgentRegistrationResultDto) {
    return this.authService.markAgentRegistrationResult(req.user!.socialId, body.chainId, body.status, body.txHash, body.walletId);
  }

  /** Wallet projection/reconciliation is deliberately separate from session introspection. */
  @Get('me')
  @UseGuards(AppSessionGuard, FrontendOnlyGuard)
  async getMe(@Req() req: Request) {
    return this.authService.getMe(req.user!.socialId);
  }
}

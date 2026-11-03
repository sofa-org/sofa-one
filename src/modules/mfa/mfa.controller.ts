import { Body, Controller, Get, Header, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { AllowPendingMfa } from '../../common/decorators/allow-pending-mfa.decorator';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { AppSessionGuard } from '../../common/guards/app-session.guard';
import { AppSessionService } from '../app-session/app-session.service';
import { TotpCodeDto } from './dto/totp.dto';
import { MfaService } from './mfa.service';

@Controller('auth/mfa')
@FrontendOnly()
@UseGuards(AppSessionGuard, FrontendOnlyGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService, private readonly sessions: AppSessionService) {}

  @Get('status')
  @AllowPendingMfa()
  @Header('Cache-Control', 'no-store')
  status(@Req() req: Request) {
    return this.mfa.getStatus(req.user!.id);
  }

  @Post('totp/setup')
  @AllowPendingMfa()
  @Header('Cache-Control', 'no-store')
  setup(@Req() req: Request) {
    return this.mfa.setupTotp(req.user!.id, req.appSession!.id, req.user!.email);
  }

  @Post('totp/enable')
  @AllowPendingMfa()
  @Header('Cache-Control', 'no-store')
  enable(@Req() req: Request, @Body() dto: TotpCodeDto) {
    return this.mfa.enableTotp(req.user!.id, req.appSession!.id, dto.code);
  }

  @Post('totp/verify')
  @AllowPendingMfa()
  @Header('Cache-Control', 'no-store')
  verify(@Req() req: Request, @Body() dto: TotpCodeDto) {
    return this.mfa.verifyTotp(req.user!.id, req.appSession!.id, dto.code);
  }

  @Post('totp/disable')
  @Header('Cache-Control', 'no-store')
  async disable(@Req() req: Request, @Body() dto: TotpCodeDto, @Res({ passthrough: true }) res: Response) {
    await this.mfa.disableTotp(req.user!.id, req.appSession!.id, dto.code);
    this.sessions.clearCookie(res);
  }
}

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { TotpCodeDto } from './dto/totp.dto';
import { MfaService } from './mfa.service';

@Controller('v1/auth/mfa')
@FrontendOnly()
@UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get('status')
  status(@Req() req: any) {
    return this.mfa.getStatus(req.user.id);
  }

  @Post('totp/setup')
  setup(@Req() req: any) {
    return this.mfa.setupTotp(req.user.id, req.openfortEmail ?? req.user.email);
  }

  @Post('totp/enable')
  enable(@Req() req: any, @Body() dto: TotpCodeDto) {
    return this.mfa.enableTotp(req.user.id, dto.code);
  }

  @Post('totp/verify')
  verify(@Req() req: any, @Body() dto: TotpCodeDto) {
    return this.mfa.verifyTotp(req.user.id, dto.code);
  }

  @Post('totp/disable')
  disable(@Req() req: any, @Body() dto: TotpCodeDto) {
    return this.mfa.disableTotp(req.user.id, dto.code);
  }
}

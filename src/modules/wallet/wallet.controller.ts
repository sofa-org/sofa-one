import { Controller, Get, Post, Delete, Body, Query, Req, Param, UseGuards, HttpCode, HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WalletService } from './wallet.service';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { ApiKeyPermissionGuard } from '../../common/guards/api-key-permission.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { RequireApiKeyPermission } from '../../common/decorators/api-key-permission.decorator';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { RequireStepUp } from '../../common/decorators/step-up.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SignDto } from './dto/sign.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { CreateWithdrawalAddressDto } from './dto/withdrawal-address.dto';
import { ListSigningRequestsQueryDto } from './dto/list-signing-requests-query.dto';

@Controller('v1/wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /** GET /v1/wallets/balances — frontend only: return ETH and USDC balances. */
  @Get('balances')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async getBalances(@CurrentUser('id') userId: string, @Query('chainId') chainId: string) {
    return this.walletService.getBalances(userId, Number(chainId));
  }

  /** POST /v1/wallets/deposit-info — frontend only: get wallet address for deposits. */
  @Post('deposit-info')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async getDepositInfo(@CurrentUser('id') userId: string, @Body('chainId') chainId: number) {
    return this.walletService.getDepositInfo(userId, Number(chainId));
  }

  /** GET /v1/wallets/signing-requests — frontend only: list signing request history. */
  @Get('signing-requests')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 20, ttl: 60000 }, medium: { limit: 100, ttl: 3600000 } })
  async listSigningRequests(
    @CurrentUser('id') userId: string,
    @Query() query: ListSigningRequestsQueryDto,
  ) {
    return this.walletService.listSigningRequests(userId, query);
  }

  /** GET /v1/wallets/signing-requests/:id — frontend only: single signing request detail. */
  @Get('signing-requests/:id')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 20, ttl: 60000 }, medium: { limit: 100, ttl: 3600000 } })
  async getSigningRequestDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.walletService.getSigningRequestDetail(userId, id);
  }

  /** GET /v1/wallets/withdrawal-addresses — frontend only: list withdrawal allowlist. */
  @Get('withdrawal-addresses')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async listWithdrawalAddresses(@CurrentUser('id') userId: string) {
    return this.walletService.listWithdrawalAddresses(userId);
  }

  /** POST /v1/wallets/withdrawal-addresses — frontend only: add address with cooldown. Requires step-up. */
  @Post('withdrawal-addresses')
  @FrontendOnly()
  @RequireStepUp()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard, StepUpGuard)
  @Throttle({ short: { limit: 3, ttl: 60000 }, medium: { limit: 10, ttl: 3600000 } })
  async addWithdrawalAddress(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWithdrawalAddressDto,
  ) {
    return this.walletService.addWithdrawalAddress(userId, dto);
  }

  /** DELETE /v1/wallets/withdrawal-addresses/:id — frontend only: remove address. Requires step-up. */
  @Delete('withdrawal-addresses/:id')
  @FrontendOnly()
  @RequireStepUp()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard, StepUpGuard)
  async removeWithdrawalAddress(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.walletService.removeWithdrawalAddress(userId, id);
  }

  /** POST /v1/wallets/sign — API-key only: sign data without sending a transaction. */
  @Post('sign')
  @HttpCode(HttpStatus.OK)
  @RequireApiKeyPermission('canSign')
  @UseGuards(ApiKeyAuthGuard, ApiKeyPermissionGuard)
  async sign(@CurrentUser('id') userId: string, @Body() dto: SignDto, @Req() req: any) {
    return this.walletService.sign(userId, dto, req.apiKeyRecord);
  }

  /** POST /v1/wallets/withdraw — frontend only: submit a withdrawal transaction. Requires step-up. */
  @Post('withdraw')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard, StepUpGuard)
  @RequireStepUp()
  @Throttle({ short: { limit: 3, ttl: 60000 }, medium: { limit: 10, ttl: 3600000 } })
  async withdraw(@CurrentUser('id') userId: string, @Body() dto: WithdrawDto) {
    return this.walletService.withdraw(userId, dto);
  }
}

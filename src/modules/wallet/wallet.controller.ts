import { Controller, Get, Post, Body, Query, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WalletService } from './wallet.service';
import { EitherAuthGuard } from '../../common/guards/either-auth.guard';
import { ApiKeyOnlyGuard } from '../../common/guards/api-key-only.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { ClerkUserGuard } from '../../common/guards/clerk-user.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SignDto } from './dto/sign.dto';
import { WithdrawDto } from './dto/withdraw.dto';

@Controller('v1/wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /** GET /v1/wallets/balances — frontend only: return ETH and USDC balances. */
  @Get('balances')
  @FrontendOnly()
  @UseGuards(ClerkUserGuard, FrontendOnlyGuard)
  async getBalances(@CurrentUser('id') userId: string, @Query('chainId') chainId: string) {
    return this.walletService.getBalances(userId, Number(chainId));
  }

  /** POST /v1/wallets/deposit-info — frontend only: get wallet address for deposits. */
  @Post('deposit-info')
  @FrontendOnly()
  @UseGuards(ClerkUserGuard, FrontendOnlyGuard)
  async getDepositInfo(@CurrentUser('id') userId: string, @Body('chainId') chainId: number) {
    return this.walletService.getDepositInfo(userId, Number(chainId));
  }

  /** POST /v1/wallets/sign — API-key only: sign data without sending a transaction. */
  @Post('sign')
  @HttpCode(HttpStatus.OK)
  @UseGuards(EitherAuthGuard, ApiKeyOnlyGuard)
  async sign(@CurrentUser('id') userId: string, @Body() dto: SignDto, @Req() req: any) {
    return this.walletService.sign(userId, dto, req.apiKeyRecord);
  }

  /** POST /v1/wallets/withdraw — frontend only: submit a withdrawal transaction. */
  @Post('withdraw')
  @FrontendOnly()
  @UseGuards(ClerkUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 3, ttl: 60000 }, medium: { limit: 10, ttl: 3600000 } })
  async withdraw(@CurrentUser('id') userId: string, @Body() dto: WithdrawDto) {
    return this.walletService.withdraw(userId, dto);
  }
}

import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WalletService } from './wallet.service';
import { EitherAuthGuard } from '../../common/guards/either-auth.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SignDto } from './dto/sign.dto';
import { WithdrawDto } from './dto/withdraw.dto';

@Controller('v1/wallets')
@UseGuards(EitherAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /** GET /v1/wallets/balances — frontend only: return ETH and USDC balances. */
  @Get('balances')
  @FrontendOnly()
  @UseGuards(FrontendOnlyGuard)
  async getBalances(@CurrentUser('id') userId: string) {
    return this.walletService.getBalances(userId);
  }

  /** POST /v1/wallets/deposit-info — frontend only: get wallet address for deposits. */
  @Post('deposit-info')
  @FrontendOnly()
  @UseGuards(FrontendOnlyGuard)
  async getDepositInfo(@CurrentUser('id') userId: string) {
    return this.walletService.getDepositInfo(userId);
  }

  /** POST /v1/wallets/sign — public API: sign data without sending a transaction. */
  @Post('sign')
  async sign(@CurrentUser('id') userId: string, @Body() dto: SignDto) {
    return this.walletService.sign(userId, dto);
  }

  /** POST /v1/wallets/withdraw — frontend only: create a withdrawal intent. */
  @Post('withdraw')
  @FrontendOnly()
  @UseGuards(FrontendOnlyGuard)
  @Throttle({ short: { limit: 3, ttl: 60000 }, medium: { limit: 10, ttl: 3600000 } })
  async withdraw(@CurrentUser('id') userId: string, @Body() dto: WithdrawDto) {
    return this.walletService.withdraw(userId, dto);
  }
}

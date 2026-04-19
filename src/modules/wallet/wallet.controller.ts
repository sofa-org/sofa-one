import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WithdrawDto } from './dto/withdraw.dto';

@Controller('v1/wallets')
@UseGuards(ApiKeyGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /** POST /v1/wallets/deposit-info — get wallet address for deposits. */
  @Post('deposit-info')
  async getDepositInfo(@CurrentUser('id') userId: string) {
    return this.walletService.getDepositInfo(userId);
  }

  /** POST /v1/wallets/withdraw — create a withdrawal intent. */
  @Post('withdraw')
  async withdraw(@CurrentUser('id') userId: string, @Body() dto: WithdrawDto) {
    return this.walletService.withdraw(userId, dto);
  }
}

import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TransactionsService } from './transactions.service';
import { EitherAuthGuard } from '../../common/guards/either-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SendTransactionDto } from './dto/send-transaction.dto';

@Controller('v1/transactions')
@UseGuards(EitherAuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  /** POST /v1/transactions/send — public API: send a raw transaction from the user's backend wallet. */
  @Post('send')
  @Throttle({ short: { limit: 5, ttl: 60000 }, medium: { limit: 20, ttl: 3600000 } })
  async send(@CurrentUser('id') userId: string, @Body() dto: SendTransactionDto, @Req() req: any) {
    return this.transactionsService.send(userId, dto, req.apiKeyRecord);
  }
}

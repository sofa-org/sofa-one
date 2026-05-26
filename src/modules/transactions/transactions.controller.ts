import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TransactionsService } from './transactions.service';
import { EitherAuthGuard } from '../../common/guards/either-auth.guard';
import { ApiKeyOnlyGuard } from '../../common/guards/api-key-only.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SendTransactionDto } from './dto/send-transaction.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';

@Controller('v1/transactions')
@UseGuards(EitherAuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  /** POST /v1/transactions/send — public API: API-key-only transaction submission. */
  @Post('send')
  @UseGuards(ApiKeyOnlyGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 }, medium: { limit: 20, ttl: 3600000 } })
  async send(@CurrentUser('id') userId: string, @Body() dto: SendTransactionDto, @Req() req: any) {
    return this.transactionsService.send(userId, dto, req.apiKeyRecord);
  }

  /** GET /v1/transactions — dashboard only: list transaction history with optional filtering and pagination. */
  @Get()
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  @Throttle({ short: { limit: 20, ttl: 60000 }, medium: { limit: 100, ttl: 3600000 } })
  async list(@CurrentUser('id') userId: string, @Query() query: ListTransactionsQueryDto) {
    return this.transactionsService.list(userId, query);
  }

  /** GET /v1/transactions/:id — public API: API-key-only transaction status lookup. */
  @Get(':id')
  @UseGuards(ApiKeyOnlyGuard)
  @Throttle({ short: { limit: 20, ttl: 60000 }, medium: { limit: 100, ttl: 3600000 } })
  async getStatus(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) transactionId: string,
    @Req() req: any,
  ) {
    return this.transactionsService.getStatus(userId, transactionId, req.apiKeyRecord);
  }
}

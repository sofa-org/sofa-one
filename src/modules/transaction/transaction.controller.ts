import { Controller, Post, Get, Body, Query, UseGuards } from '@nestjs/common';
import { TransactionService } from './transaction.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateIntentDto } from './dto/create-intent.dto';

@Controller('v1/transactions')
@UseGuards(ApiKeyGuard)
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  /** POST /v1/transactions/intent — submit a new transaction intent. */
  @Post('intent')
  async createIntent(@CurrentUser('id') userId: string, @Body() dto: CreateIntentDto) {
    return this.transactionService.createIntent(userId, dto);
  }

  /** GET /v1/transactions/history — paginated transaction history. */
  @Get('history')
  async getHistory(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.transactionService.getHistory(
      userId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  /** POST /v1/transactions/batch — batch multiple interactions (EIP-7702). */
  @Post('batch')
  async batch(@CurrentUser('id') userId: string, @Body() dto: CreateIntentDto) {
    return this.transactionService.createIntent(userId, dto);
  }
}

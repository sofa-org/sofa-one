import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsReconcilerService } from './transactions-reconciler.service';
import { TransactionsService } from './transactions.service';

@Module({
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionsReconcilerService],
})
export class TransactionsModule {}

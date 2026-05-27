import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { SecurityEventModule } from '../security-events/security-event.module';
import { EoaExecutionModule } from '../eoa-execution/eoa-execution.module';
import { TransactionPolicyService } from './transaction-policy.service';

@Module({
  imports: [SecurityEventModule, EoaExecutionModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionPolicyService],
})
export class TransactionsModule {}

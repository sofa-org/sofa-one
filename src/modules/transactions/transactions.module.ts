import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { SecurityEventModule } from '../security-events/security-event.module';
import { EoaExecutionModule } from '../eoa-execution/eoa-execution.module';
import { SessionKeyModule } from '../session-key/session-key.module';
import { TransactionPolicyService } from './transaction-policy.service';
import { TransactionSimulationService } from './transaction-simulation.service';

@Module({
  imports: [SecurityEventModule, EoaExecutionModule, SessionKeyModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionPolicyService, TransactionSimulationService],
})
export class TransactionsModule {}

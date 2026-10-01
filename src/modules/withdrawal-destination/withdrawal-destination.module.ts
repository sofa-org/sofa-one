import { Module } from '@nestjs/common';
import { SecurityEventModule } from '../security-events/security-event.module';
import { WithdrawalDestinationPolicyService } from './withdrawal-destination-policy.service';

/**
 * Leaf module: destination/cooldown policy only. No WalletModule / Billing
 * execution imports — safe for TransactionsModule to consume without cycles.
 */
@Module({
  imports: [SecurityEventModule],
  providers: [WithdrawalDestinationPolicyService],
  exports: [WithdrawalDestinationPolicyService],
})
export class WithdrawalDestinationModule {}

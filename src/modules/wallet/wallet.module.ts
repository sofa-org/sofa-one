import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { SigningPolicyService } from './signing-policy.service';
import { StepUpModule } from '../step-up/step-up.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { EoaExecutionModule } from '../eoa-execution/eoa-execution.module';
import { SessionKeyModule } from '../session-key/session-key.module';
import { BillingModule } from '../billing/billing.module';
import { WithdrawalDestinationModule } from '../withdrawal-destination/withdrawal-destination.module';
import { DefiModule } from '../defi/defi.module';
import { PolymarketDepositWalletVerifierService } from './polymarket-deposit-wallet-verifier.service';
import { PolymarketSigningBudgetService } from './polymarket-signing-budget.service';

@Module({
  imports: [
    StepUpModule,
    SecurityEventModule,
    EoaExecutionModule,
    SessionKeyModule,
    BillingModule,
    // Shared destination/cooldown leaf + user advisory lock (BILL-016).
    WithdrawalDestinationModule,
    DefiModule,
  ],
  controllers: [WalletController],
  providers: [WalletService, WithdrawalPolicyService, SigningPolicyService, PolymarketDepositWalletVerifierService, PolymarketSigningBudgetService],
})
export class WalletModule {}

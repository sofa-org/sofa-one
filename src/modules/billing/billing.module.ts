import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../core/database/prisma.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { BillingWorkerService } from './billing-worker.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { stripeClientProvider } from './stripe/stripe-client.provider';
import { UsdcPaymentController } from './onchain/usdc-payment.controller';
import { UsdcPaymentService } from './onchain/usdc-payment.service';
import { ViemUsdcReceiptProvider } from './onchain/usdc-receipt.provider';
import { USDC_RECEIPT_PROVIDER } from './onchain/usdc.constants';

@Module({
  imports: [PrismaModule, SecurityEventModule, ScheduleModule.forRoot()],
  controllers: [BillingController, StripeWebhookController, UsdcPaymentController],
  providers: [
    BillingService,
    BillingReconciliationService,
    BillingEntitlementService,
    InvoiceSettlementService,
    BillingWorkerService,
    StripePaymentService,
    StripeWebhookService,
    stripeClientProvider,
    UsdcPaymentService,
    { provide: USDC_RECEIPT_PROVIDER, useClass: ViemUsdcReceiptProvider },
  ],
  exports: [
    BillingService,
    BillingReconciliationService,
    BillingEntitlementService,
    InvoiceSettlementService,
    StripePaymentService,
  ],
})
export class BillingModule {}
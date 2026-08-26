import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/database/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { stripeClientProvider } from './stripe/stripe-client.provider';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [
    BillingService,
    BillingReconciliationService,
    BillingEntitlementService,
    StripePaymentService,
    StripeWebhookService,
    stripeClientProvider,
  ],
  exports: [
    BillingService,
    BillingReconciliationService,
    BillingEntitlementService,
    StripePaymentService,
  ],
})
export class BillingModule {}

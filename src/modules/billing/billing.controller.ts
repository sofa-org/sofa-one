import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { GetSummaryQueryDto } from './dto/get-summary-query.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { ReconcileBodyDto } from './dto/reconcile-body.dto';
import { AssignPlanBodyDto } from './dto/assign-plan-body.dto';
import { CreateSubscriptionCheckoutDto } from './dto/create-subscription-checkout.dto';

/**
 * Frontend-only billing routes. These are intentionally NOT part of the public
 * API-key spec (openapi.yaml) and require an Openfort IAM bearer token plus the
 * FrontendOnlyGuard origin/referer check.
 */
@Controller('v1/billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly reconciliationService: BillingReconciliationService,
    private readonly stripePaymentService: StripePaymentService,
    private readonly invoicePdfService: InvoicePdfService,
  ) {}

  /** GET /v1/billing/plans — current plan + plan catalog. */
  @Get('plans')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async getPlans(@CurrentUser('id') userId: string) {
    return this.billingService.getPlans(userId);
  }

  /**
   * POST /v1/billing/plan — self-service plan change. The authenticated
   * dashboard user selects a plan code; it takes effect at the next UTC month
   * and creates/updates that future period's open invoice. Not part of the
   * public API-key spec; no client userId/effectiveFrom/admin bypass.
   */
  @Post('plan')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async assignPlan(@CurrentUser('id') userId: string, @Body() body: AssignPlanBodyDto) {
    return this.billingService.assignPlan(userId, body.planCode);
  }

  /** GET /v1/billing/summary?period=YYYY-MM — monthly usage estimate. */
  @Get('summary')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async getSummary(@CurrentUser('id') userId: string, @Query() query: GetSummaryQueryDto) {
    return this.billingService.getSummary(userId, query.period);
  }

  /** GET /v1/billing/invoices?page=&limit= — paginated invoice list. */
  @Get('invoices')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async listInvoices(@CurrentUser('id') userId: string, @Query() query: ListInvoicesQueryDto) {
    return this.billingService.listInvoices(userId, { page: query.page, limit: query.limit });
  }

  /** GET /v1/billing/invoices/:id — single invoice owned by the user. */
  @Get('invoices/:id')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async getInvoice(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.billingService.getInvoice(userId, id);
  }

  /**
   * GET /v1/billing/invoices/:id/pdf — downloads the immutable PDF for a
   * finalized (or paid) invoice owned by the current user. Pricing comes only
   * from the persisted snapshot/lines, never the current plan; the service
   * verifies the snapshot hash, non-negative amounts, and line sum = total and
   * fails closed. The response is served as an attachment with
   * `private, no-store` and `nosniff` headers. Not part of the public API-key
   * spec; the IAM token is never placed in the URL.
   */
  @Get('invoices/:id/pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async downloadInvoicePdf(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.invoicePdfService.generate(userId, id);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * POST /v1/billing/invoices/:id/checkout — creates (or reuses) a Stripe
   * Checkout session for a finalized, unpaid invoice owned by the user. The
   * amount, currency, and association are read server-side from the database;
   * success/cancel URLs come from server configuration only. Returns a safe
   * `{ invoiceId, sessionId, checkoutUrl }`; payment facts are only confirmed
   * by the signed webhook, never by this redirect. Not part of the public
   * API-key spec.
   */
  @Post('invoices/:id/checkout')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async checkoutInvoice(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.stripePaymentService.createCheckoutSession(userId, id);
  }

  /** Dashboard-only recurring fixed-fee subscription Checkout. */
  @Post('invoices/:id/subscription-checkout')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async checkoutSubscription(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateSubscriptionCheckoutDto,
  ) {
    return this.stripePaymentService.createSubscriptionCheckout(userId, id, body.planVersionId);
  }

  /**
   * POST /v1/billing/reconcile — protected internal trigger seam that scans the
   * current user's receipt-confirmed outbound transactions and appends
   * evidence-backed posted/quarantined ledger events. Scoped to the current
   * user only; returns scan statistics and never exposes receipt logs,
   * calldata, or secrets. Not part of the public API-key spec.
   */
  @Post('reconcile')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async reconcile(@CurrentUser('id') userId: string, @Body() body: ReconcileBodyDto) {
    return this.reconciliationService.reconcile(userId, { limit: body.limit });
  }
}

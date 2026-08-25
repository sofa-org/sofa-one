import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { GetSummaryQueryDto } from './dto/get-summary-query.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { ReconcileBodyDto } from './dto/reconcile-body.dto';

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
  ) {}

  /** GET /v1/billing/plans — current plan + plan catalog. */
  @Get('plans')
  @FrontendOnly()
  @UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
  async getPlans(@CurrentUser('id') userId: string) {
    return this.billingService.getPlans(userId);
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

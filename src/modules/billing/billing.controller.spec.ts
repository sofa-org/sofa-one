import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./billing.service', () => ({
  BillingService: class BillingService {},
}));
jest.mock('./billing-reconciliation.service', () => ({
  BillingReconciliationService: class BillingReconciliationService {},
}));
jest.mock('./stripe/stripe-payment.service', () => ({
  StripePaymentService: class StripePaymentService {},
}));
jest.mock('./invoice-pdf.service', () => ({
  InvoicePdfService: class InvoicePdfService {},
}));
jest.mock('../../common/guards/openfort-user.guard', () => ({
  OpenfortUserGuard: class OpenfortUserGuard {},
}));
jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));

import { BillingController } from './billing.controller';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { StreamableFile } from '@nestjs/common';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';

describe('BillingController', () => {
  const billingService = {
    getPlans: jest.fn(),
    getSummary: jest.fn(),
    listInvoices: jest.fn(),
    getInvoice: jest.fn(),
    assignPlan: jest.fn(),
    cancelScheduledPlan: jest.fn(),
    cancelPendingUpgrade: jest.fn(),
  };
  const reconciliationService = {
    reconcile: jest.fn(),
  };
  const stripePaymentService = {
    createCheckoutSession: jest.fn(),
  };
  const invoicePdfService = {
    generate: jest.fn(),
  };

  let controller: BillingController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new BillingController(
      billingService as any,
      reconciliationService as any,
      stripePaymentService as any,
      invoicePdfService as any,
    );
  });

  it('delegates getPlans to the service with the current user id', async () => {
    billingService.getPlans.mockResolvedValue({ currentPlanId: 'free', plans: [] });

    const result = await controller.getPlans('user-1');

    expect(billingService.getPlans).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ currentPlanId: 'free', plans: [] });
  });

  it('delegates getSummary to the service with the period', async () => {
    billingService.getSummary.mockResolvedValue({ period: '2026-05' });

    const result = await controller.getSummary('user-1', { period: '2026-05' } as any);

    expect(billingService.getSummary).toHaveBeenCalledWith('user-1', '2026-05');
    expect(result).toEqual({ period: '2026-05' });
  });

  it('delegates listInvoices to the service with page and limit', async () => {
    billingService.listInvoices.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });

    const result = await controller.listInvoices('user-1', { page: 2, limit: 50 } as any);

    expect(billingService.listInvoices).toHaveBeenCalledWith('user-1', { page: 2, limit: 50 });
    expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
  });

  it('delegates getInvoice to the service with the user id and invoice id', async () => {
    billingService.getInvoice.mockResolvedValue({ id: 'inv-1' });

    const result = await controller.getInvoice('user-1', 'inv-1');

    expect(billingService.getInvoice).toHaveBeenCalledWith('user-1', 'inv-1');
    expect(result).toEqual({ id: 'inv-1' });
  });

  it('delegates reconcile to the reconciliation service scoped to the current user', async () => {
    reconciliationService.reconcile.mockResolvedValue({ runId: 'run-1', scanned: 3 });

    const result = await controller.reconcile('user-1', { limit: 25 } as any);

    expect(reconciliationService.reconcile).toHaveBeenCalledWith('user-1', { limit: 25 });
    expect(result).toEqual({ runId: 'run-1', scanned: 3 });
  });

  it('delegates reconcile with no body (default limit)', async () => {
    reconciliationService.reconcile.mockResolvedValue({ runId: 'run-2' });

    await controller.reconcile('user-1', {} as any);

    expect(reconciliationService.reconcile).toHaveBeenCalledWith('user-1', { limit: undefined });
  });

  it('delegates assignPlan to the service with the current user id and plan code', async () => {
    billingService.assignPlan.mockResolvedValue({
      planCode: 'starter',
      planName: 'Starter',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'payment_required',
      changeId: 'chg-1',
      invoiceId: 'inv-charge-1',
      amount: '25.000000',
      currency: 'USD',
      kind: 'upgrade',
    });

    const result = await controller.assignPlan('user-1', { planCode: 'starter' } as any);

    expect(billingService.assignPlan).toHaveBeenCalledWith('user-1', 'starter');
    expect(result).toMatchObject({
      planCode: 'starter',
      outcome: 'payment_required',
      changeId: 'chg-1',
      invoiceId: 'inv-charge-1',
    });
  });

  it('delegates cancelScheduledPlan to the service with the current user id only', async () => {
    billingService.cancelScheduledPlan.mockResolvedValue({
      planCode: 'starter',
      planName: 'Starter',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'canceled',
    });

    const result = await controller.cancelScheduledPlan('user-1');

    expect(billingService.cancelScheduledPlan).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({
      planCode: 'starter',
      planName: 'Starter',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'canceled',
    });
  });

  it('delegates cancelPendingUpgrade to the service with the current user id only', async () => {
    billingService.cancelPendingUpgrade.mockResolvedValue({
      planCode: 'free',
      planName: 'Free',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'canceled',
    });

    const result = await controller.cancelPendingUpgrade('user-1');

    expect(billingService.cancelPendingUpgrade).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({
      planCode: 'free',
      planName: 'Free',
      effectivePeriod: '2026-08',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      outcome: 'canceled',
    });
  });

  it('delegates checkoutInvoice to the Stripe payment service scoped to the current user', async () => {
    stripePaymentService.createCheckoutSession.mockResolvedValue({
      invoiceId: 'inv-1',
      sessionId: 'cs_123',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
    });

    const result = await controller.checkoutInvoice('user-1', 'inv-1');

    expect(stripePaymentService.createCheckoutSession).toHaveBeenCalledWith('user-1', 'inv-1');
    expect(result).toEqual({
      invoiceId: 'inv-1',
      sessionId: 'cs_123',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_123',
    });
  });

  it('delegates invoice PDF generation to the service scoped to the current user', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake', 'ascii');
    invoicePdfService.generate.mockResolvedValue({
      pdf,
      filename: 'invoice-inv-1.pdf',
      contentType: 'application/pdf',
    });

    const result = await controller.downloadInvoicePdf('user-1', 'inv-1');

    expect(invoicePdfService.generate).toHaveBeenCalledWith('user-1', 'inv-1');
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('streams the invoice PDF as an attachment', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake', 'ascii');
    invoicePdfService.generate.mockResolvedValue({
      pdf,
      filename: 'invoice-inv-1.pdf',
      contentType: 'application/pdf',
    });

    const result = await controller.downloadInvoicePdf('user-1', 'inv-1');

    expect(result).toBeInstanceOf(StreamableFile);
    expect(result.getHeaders()).toEqual(
      expect.objectContaining({
        type: 'application/pdf',
        disposition: 'attachment; filename="invoice-inv-1.pdf"',
      }),
    );
  });

  it('sets the no-store and nosniff headers on the PDF route', () => {
    const headers = Reflect.getMetadata('__headers__', controller.downloadInvoicePdf) ?? [];
    const flattened = headers.map((h: { name: string; value: string }) => [h.name, h.value]);
    expect(flattened).toEqual(
      expect.arrayContaining([
        ['Cache-Control', 'private, no-store'],
        ['X-Content-Type-Options', 'nosniff'],
      ]),
    );
  });

  it('protects every route with OpenfortUserGuard and FrontendOnlyGuard', () => {
    const routes = [
      controller.getPlans,
      controller.getSummary,
      controller.listInvoices,
      controller.getInvoice,
      controller.downloadInvoicePdf,
      controller.reconcile,
      controller.assignPlan,
      controller.cancelScheduledPlan,
      controller.cancelPendingUpgrade,
      controller.checkoutInvoice,
    ];

    for (const route of routes) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, route) ?? [];
      expect(guards).toContain(OpenfortUserGuard);
      expect(guards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, route)).toBe(true);
    }
  });
});

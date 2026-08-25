import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./billing.service', () => ({
  BillingService: class BillingService {},
}));
jest.mock('./billing-reconciliation.service', () => ({
  BillingReconciliationService: class BillingReconciliationService {},
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
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';

describe('BillingController', () => {
  const billingService = {
    getPlans: jest.fn(),
    getSummary: jest.fn(),
    listInvoices: jest.fn(),
    getInvoice: jest.fn(),
  };
  const reconciliationService = {
    reconcile: jest.fn(),
  };

  let controller: BillingController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new BillingController(billingService as any, reconciliationService as any);
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

  it('protects every route with OpenfortUserGuard and FrontendOnlyGuard', () => {
    const routes = [
      controller.getPlans,
      controller.getSummary,
      controller.listInvoices,
      controller.getInvoice,
      controller.reconcile,
    ];

    for (const route of routes) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, route) ?? [];
      expect(guards).toContain(OpenfortUserGuard);
      expect(guards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, route)).toBe(true);
    }
  });
});

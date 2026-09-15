import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingDebtService } from './billing-debt.service';

const ACCOUNT = { id: 'acc-1', userId: 'user-1' };

describe('BillingDebtService', () => {
  let service: BillingDebtService;

  const accountFindUnique = jest.fn();
  const invoiceFindMany = jest.fn();

  const buildClient = () =>
    ({
      billingAccount: { findUnique: accountFindUnique },
      billingInvoice: { findMany: invoiceFindMany },
    }) as any;

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingDebtService,
        {
          provide: PrismaService,
          useValue: buildClient(),
        },
      ],
    }).compile();

    service = module.get<BillingDebtService>(BillingDebtService);
  });

  it('returns no debt when the user has no billing account', async () => {
    accountFindUnique.mockResolvedValue(null);

    const result = await service.getDebt('user-1');

    expect(result).toEqual({ hasDebt: false, invoiceIds: [] });
    expect(accountFindUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true },
    });
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });

  it('returns no debt when there are no finalized unpaid invoices', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([]);

    const result = await service.getDebt('user-1');

    expect(result).toEqual({ hasDebt: false, invoiceIds: [] });
    expect(invoiceFindMany).toHaveBeenCalledWith({
      where: {
        billingAccountId: ACCOUNT.id,
        status: 'finalized',
        paidAt: null,
      },
      select: { id: true },
      orderBy: { periodStart: 'asc' },
    });
  });

  it('returns debt with invoice ids for finalized unpaid invoices', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([{ id: 'inv-a' }, { id: 'inv-b' }]);

    const result = await service.getDebt('user-1');

    expect(result).toEqual({
      hasDebt: true,
      invoiceIds: ['inv-a', 'inv-b'],
    });
  });

  it('scopes the account lookup to the requested userId (no cross-user)', async () => {
    accountFindUnique.mockResolvedValue(null);

    await service.getDebt('user-other');

    expect(accountFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-other' },
      }),
    );
  });

  it('queries only finalized + paidAt null (open/needs_review/void/paid excluded by filter)', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([]);

    await service.getDebt('user-1');

    const arg = invoiceFindMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      billingAccountId: ACCOUNT.id,
      status: 'finalized',
      paidAt: null,
    });
    // No amount fields selected — avoid BigInt JSON surface.
    expect(arg.select).toEqual({ id: true });
    expect(arg.select).not.toHaveProperty('totalMicros');
    expect(arg.select).not.toHaveProperty('allocatedMicros');
  });

  it('hasDebt mirrors getDebt.hasDebt', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([{ id: 'inv-1' }]);

    await expect(service.hasDebt('user-1')).resolves.toBe(true);

    invoiceFindMany.mockResolvedValue([]);
    await expect(service.hasDebt('user-1')).resolves.toBe(false);
  });

  it('accepts an interactive transaction client instead of PrismaService', async () => {
    const txAccountFind = jest.fn().mockResolvedValue(ACCOUNT);
    const txInvoiceFind = jest.fn().mockResolvedValue([{ id: 'inv-tx' }]);
    const tx = {
      billingAccount: { findUnique: txAccountFind },
      billingInvoice: { findMany: txInvoiceFind },
    } as any;

    const result = await service.getDebt('user-1', tx);

    expect(result).toEqual({ hasDebt: true, invoiceIds: ['inv-tx'] });
    expect(txAccountFind).toHaveBeenCalled();
    expect(txInvoiceFind).toHaveBeenCalled();
    // Default PrismaService mocks must not be used when tx is supplied.
    expect(accountFindUnique).not.toHaveBeenCalled();
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });

  it('propagates account lookup errors (fail closed, never open)', async () => {
    accountFindUnique.mockRejectedValue(new Error('db down'));

    await expect(service.getDebt('user-1')).rejects.toThrow('db down');
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });

  it('propagates invoice query errors (fail closed, never open)', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockRejectedValue(new Error('query failed'));

    await expect(service.getDebt('user-1')).rejects.toThrow('query failed');
    await expect(service.hasDebt('user-1')).rejects.toThrow('query failed');
  });

  it('does not create accounts or call ensureAccount-style side effects', async () => {
    accountFindUnique.mockResolvedValue(null);

    await service.getDebt('user-1');

    // Only a findUnique on account — no create/upsert.
    expect(accountFindUnique).toHaveBeenCalledTimes(1);
    expect(Object.keys(buildClient().billingAccount)).toEqual(['findUnique']);
  });
});

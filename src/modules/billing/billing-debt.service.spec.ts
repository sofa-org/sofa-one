import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingDebtService } from './billing-debt.service';

const ACCOUNT = { id: 'acc-1', userId: 'user-1' };

describe('BillingDebtService', () => {
  let service: BillingDebtService;

  const accountFindUnique = jest.fn();
  const invoiceFindMany = jest.fn();
  let invoiceRows: any[];

  const buildClient = () =>
    ({
      billingAccount: { findUnique: accountFindUnique },
      billingInvoice: { findMany: invoiceFindMany },
    }) as any;

  beforeEach(async () => {
    jest.resetAllMocks();
    invoiceRows = [];
    invoiceFindMany.mockImplementation(({ where }) =>
      invoiceRows.filter((row) =>
        row.billingAccountId === where.billingAccountId &&
        row.status === where.status &&
        row.paidAt === where.paidAt &&
        row.purpose === where.purpose &&
        (!where.finalizedAt || row.finalizedAt <= where.finalizedAt.lte),
      ).map(({ id, totalMicros, allocatedMicros }) => ({ id, totalMicros, allocatedMicros })),
    );

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
        purpose: 'usage_period',
      },
      select: { id: true, totalMicros: true, allocatedMicros: true },
      orderBy: { periodStart: 'asc' },
    });
  });

  it('returns debt with invoice ids for finalized unpaid invoices', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-a', totalMicros: 5n, allocatedMicros: 0n },
      { id: 'inv-b', totalMicros: 10n, allocatedMicros: 3n },
    ]);

    const result = await service.getDebt('user-1');

    expect(result).toEqual({
      hasDebt: true,
      invoiceIds: ['inv-a', 'inv-b'],
    });
  });

  it('does not count zero-balance invoices, including zero total and fully allocated', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-zero', totalMicros: 0n, allocatedMicros: 0n },
      { id: 'inv-covered', totalMicros: 9n, allocatedMicros: 9n },
    ]);

    await expect(service.getDebt('user-1')).resolves.toEqual({ hasDebt: false, invoiceIds: [] });
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
      purpose: 'usage_period',
    });
    expect(arg.select).toEqual({ id: true, totalMicros: true, allocatedMicros: true });
  });

  it('excludes plan_charge upgrade invoices from ordinary usage debt gates', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([]);

    await service.getDebt('user-1');

    expect(invoiceFindMany.mock.calls[0][0].where.purpose).toBe('usage_period');
  });

  it('hasDebt mirrors getDebt.hasDebt', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    invoiceFindMany.mockResolvedValue([{ id: 'inv-1', totalMicros: 1n, allocatedMicros: 0n }]);

    await expect(service.hasDebt('user-1')).resolves.toBe(true);

    invoiceFindMany.mockResolvedValue([]);
    await expect(service.hasDebt('user-1')).resolves.toBe(false);
  });

  it('uses a fixed seven-day finalizedAt grace for API debt enforcement', async () => {
    accountFindUnique.mockResolvedValue(ACCOUNT);
    const now = new Date('2026-09-26T12:00:00.000Z');
    invoiceRows = [
      { id: 'just-before', billingAccountId: ACCOUNT.id, status: 'finalized', paidAt: null, purpose: 'usage_period', finalizedAt: new Date('2026-09-19T12:00:00.001Z'), totalMicros: 1n, allocatedMicros: 0n },
      { id: 'exactly-seven-days', billingAccountId: ACCOUNT.id, status: 'finalized', paidAt: null, purpose: 'usage_period', finalizedAt: new Date('2026-09-19T12:00:00.000Z'), totalMicros: 10n, allocatedMicros: 3n },
      { id: 'paid', billingAccountId: ACCOUNT.id, status: 'finalized', paidAt: new Date(), purpose: 'usage_period', finalizedAt: new Date('2026-09-01T00:00:00Z'), totalMicros: 1n, allocatedMicros: 0n },
      { id: 'upgrade', billingAccountId: ACCOUNT.id, status: 'finalized', paidAt: null, purpose: 'plan_charge', finalizedAt: new Date('2026-09-01T00:00:00Z'), totalMicros: 1n, allocatedMicros: 0n },
      { id: 'fully-allocated', billingAccountId: ACCOUNT.id, status: 'finalized', paidAt: null, purpose: 'usage_period', finalizedAt: new Date('2026-09-01T00:00:00Z'), totalMicros: 1n, allocatedMicros: 1n },
      { id: 'zero', billingAccountId: ACCOUNT.id, status: 'finalized', paidAt: null, purpose: 'usage_period', finalizedAt: new Date('2026-09-01T00:00:00Z'), totalMicros: 0n, allocatedMicros: 0n },
    ];

    await expect(service.hasEnforceableApiDebt('user-1', now)).resolves.toBe(true);
    invoiceRows[1].allocatedMicros = 10n;
    await expect(service.hasEnforceableApiDebt('user-1', now)).resolves.toBe(false);
    expect(invoiceFindMany.mock.calls[0][0].where.finalizedAt).toEqual({
      lte: new Date('2026-09-19T12:00:00.000Z'),
    });
    expect(invoiceFindMany.mock.calls[0][0].where.purpose).toBe('usage_period');
  });

  it('accepts an interactive transaction client instead of PrismaService', async () => {
    const txAccountFind = jest.fn().mockResolvedValue(ACCOUNT);
    const txInvoiceFind = jest.fn().mockResolvedValue([{ id: 'inv-tx', totalMicros: 1n, allocatedMicros: 0n }]);
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

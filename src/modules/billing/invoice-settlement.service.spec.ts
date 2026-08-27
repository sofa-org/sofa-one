import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceSettlementService } from './invoice-settlement.service';

describe('InvoiceSettlementService', () => {
  let service: InvoiceSettlementService;
  const queryRaw = jest.fn();
  const attemptFindUnique = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceUpdateMany = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvoiceSettlementService],
    }).compile();
    service = module.get<InvoiceSettlementService>(InvoiceSettlementService);

    // The service takes stable row locks (FOR UPDATE) on the attempt and the
    // invoice before re-reading them through the same interactive tx.
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('billing_payment_attempts')) return Promise.resolve([{ id: 'att-stripe' }]);
      if (sql.includes('billing_invoices')) return Promise.resolve([{ id: 'inv-1' }]);
      return Promise.resolve([]);
    });
  });

  // The interactive transaction client is the only dependency; the service
  // locks the attempt + invoice rows, re-reads them, validates the settlement
  // preconditions, then performs one guarded CAS update on the invoice.
  const tx = {
    $queryRaw: queryRaw,
    billingPaymentAttempt: { findUnique: attemptFindUnique },
    billingInvoice: { findUnique: invoiceFindUnique, updateMany: invoiceUpdateMany },
  } as any;

  const succeededAttempt = (overrides: Record<string, unknown> = {}) => ({
    id: 'att-stripe',
    invoiceId: 'inv-1',
    method: 'stripe',
    status: 'succeeded',
    amountMicros: 49_000_000n,
    currency: 'USD',
    ...overrides,
  });

  const finalizedInvoice = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    status: 'finalized',
    totalMicros: 49_000_000n,
    currency: 'USD',
    paidAt: null,
    settlementAttemptId: null,
    ...overrides,
  });

  /** The full CAS where clause the final update must carry. */
  const casWhere = (attemptId: string, method: string) => ({
    id: 'inv-1',
    status: 'finalized',
    paidAt: null,
    settlementAttemptId: null,
    totalMicros: 49_000_000n,
    currency: 'USD',
    paymentAttempts: {
      some: { id: attemptId, method, status: 'succeeded' },
    },
  });

  it('settles an unpaid finalized invoice on the first successful rail', async () => {
    attemptFindUnique.mockResolvedValue(succeededAttempt());
    invoiceFindUnique.mockResolvedValue(finalizedInvoice());
    invoiceUpdateMany.mockResolvedValue({ count: 1 });

    const result = await service.settleInvoice(tx, {
      id: 'att-stripe',
      invoiceId: 'inv-1',
      method: 'stripe',
    });

    expect(result).toEqual({ settled: true });
    expect(invoiceUpdateMany).toHaveBeenCalledWith({
      where: casWhere('att-stripe', 'stripe'),
      data: {
        paidAt: expect.any(Date),
        paidVia: 'stripe',
        settlementAttemptId: 'att-stripe',
      },
    });
  });

  it('locks the attempt row before the invoice row (stable lock order)', async () => {
    attemptFindUnique.mockResolvedValue(succeededAttempt());
    invoiceFindUnique.mockResolvedValue(finalizedInvoice());
    invoiceUpdateMany.mockResolvedValue({ count: 1 });

    await service.settleInvoice(tx, {
      id: 'att-stripe',
      invoiceId: 'inv-1',
      method: 'stripe',
    });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const attemptLockSql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join('');
    const invoiceLockSql = (queryRaw.mock.calls[1][0] as TemplateStringsArray).join('');
    expect(attemptLockSql).toContain('billing_payment_attempts');
    expect(attemptLockSql).toContain('FOR UPDATE');
    expect(invoiceLockSql).toContain('billing_invoices');
    expect(invoiceLockSql).toContain('FOR UPDATE');
  });

  it('is an idempotent no-op for a duplicate settlement of the same attempt', async () => {
    attemptFindUnique.mockResolvedValue(succeededAttempt());
    invoiceFindUnique.mockResolvedValue(finalizedInvoice());
    invoiceUpdateMany.mockResolvedValue({ count: 0 });

    const result = await service.settleInvoice(tx, {
      id: 'att-stripe',
      invoiceId: 'inv-1',
      method: 'stripe',
    });

    expect(result).toEqual({ settled: false });
  });

  it('never lets a competing rail overwrite an existing settlement', async () => {
    attemptFindUnique.mockResolvedValue(succeededAttempt({ id: 'att-usdc', method: 'usdc' }));
    invoiceFindUnique.mockResolvedValue(finalizedInvoice());
    invoiceUpdateMany.mockResolvedValue({ count: 0 });

    const result = await service.settleInvoice(tx, {
      id: 'att-usdc',
      invoiceId: 'inv-1',
      method: 'usdc',
    });

    expect(result).toEqual({ settled: false });
    // The guarded CAS must never match an already-settled invoice.
    expect(invoiceUpdateMany).toHaveBeenCalledWith({
      where: casWhere('att-usdc', 'usdc'),
      data: expect.objectContaining({
        paidVia: 'usdc',
        settlementAttemptId: 'att-usdc',
      }),
    });
  });

  it('records the winning rail on the settlement pointer', async () => {
    attemptFindUnique.mockResolvedValue(succeededAttempt({ id: 'att-usdc', method: 'usdc' }));
    invoiceFindUnique.mockResolvedValue(finalizedInvoice());
    invoiceUpdateMany.mockResolvedValue({ count: 1 });

    await service.settleInvoice(tx, {
      id: 'att-usdc',
      invoiceId: 'inv-1',
      method: 'usdc',
    });

    expect(invoiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidVia: 'usdc', settlementAttemptId: 'att-usdc' }),
      }),
    );
  });

  it('returns settled:false when the attempt row does not exist (no lock, no update)', async () => {
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('billing_payment_attempts')) return Promise.resolve([]);
      return Promise.resolve([{ id: 'inv-1' }]);
    });

    const result = await service.settleInvoice(tx, {
      id: 'att-missing',
      invoiceId: 'inv-1',
      method: 'stripe',
    });

    expect(result).toEqual({ settled: false });
    expect(attemptFindUnique).not.toHaveBeenCalled();
    expect(invoiceUpdateMany).not.toHaveBeenCalled();
  });

  it('returns settled:false when the invoice row does not exist (no lock, no update)', async () => {
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('billing_payment_attempts')) return Promise.resolve([{ id: 'att-stripe' }]);
      return Promise.resolve([]);
    });

    const result = await service.settleInvoice(tx, {
      id: 'att-stripe',
      invoiceId: 'inv-missing',
      method: 'stripe',
    });

    expect(result).toEqual({ settled: false });
    expect(invoiceUpdateMany).not.toHaveBeenCalled();
  });

  describe('settlement preconditions (read under stable row locks)', () => {
    it('refuses to settle when the attempt is not succeeded', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ status: 'pending' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the attempt method does not match the settling rail', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ method: 'usdc' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the attempt belongs to a different invoice', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ invoiceId: 'inv-other' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the invoice is not finalized', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice({ status: 'open' }));

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the invoice is already paid', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({ paidAt: new Date('2026-06-01T00:00:00.000Z') }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the amount does not match the invoice total', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ amountMicros: 48_000_000n }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the currency does not match', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ currency: 'EUR' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the attempt row is missing', async () => {
      attemptFindUnique.mockResolvedValue(null);
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to settle when the invoice row is missing', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(null);

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({ settled: false });
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });
  });
});

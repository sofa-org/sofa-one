import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { InvoiceSettlementService } from './invoice-settlement.service';
import { BillingPlanChangeService } from './billing-plan-change.service';

describe('InvoiceSettlementService', () => {
  let service: InvoiceSettlementService;
  const queryRaw = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptUpdateMany = jest.fn();
  const invoiceFindUnique = jest.fn();
  const invoiceUpdateMany = jest.fn();
  const applyPaidPlanCharge = jest.fn();
  const extendEntitlementForPaidUsageInvoice = jest.fn();

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceSettlementService,
        {
          provide: BillingPlanChangeService,
          useValue: { applyPaidPlanCharge, extendEntitlementForPaidUsageInvoice },
        },
      ],
    }).compile();
    service = module.get<InvoiceSettlementService>(InvoiceSettlementService);

    // Soft-read invoice meta, then FOR UPDATE attempt → invoice, then period lock.
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('billing_payment_attempts')) return Promise.resolve([{ id: 'att-stripe' }]);
      if (sql.includes('billing_invoices')) return Promise.resolve([{ id: 'inv-1' }]);
      return Promise.resolve([]);
    });
    attemptUpdateMany.mockResolvedValue({ count: 1 });
    invoiceUpdateMany.mockResolvedValue({ count: 1 });
    executeRaw.mockResolvedValue(undefined);
    // Default: soft-read + locked re-read both see an unpaid finalized invoice.
    // Tests that need multi-step sequences override with mockResolvedValueOnce.
    invoiceFindUnique.mockResolvedValue(finalizedInvoice());
    attemptFindUnique.mockResolvedValue(succeededAttempt());
  });

  // The interactive transaction client is the only dependency; the service
  // locks the attempt + invoice rows, re-reads them, validates the allocation
  // preconditions, then performs guarded CAS updates.
  const executeRaw = jest.fn();
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    billingPaymentAttempt: { findUnique: attemptFindUnique, updateMany: attemptUpdateMany },
    billingInvoice: { findUnique: invoiceFindUnique, updateMany: invoiceUpdateMany },
  } as any;

  const succeededAttempt = (overrides: Record<string, unknown> = {}) => ({
    id: 'att-stripe',
    invoiceId: 'inv-1',
    method: 'stripe',
    status: 'succeeded',
    amountMicros: 49_000_000n,
    currency: 'USD',
    allocatedAt: null,
    ...overrides,
  });

  const finalizedInvoice = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    status: 'finalized',
    purpose: 'usage_period',
    totalMicros: 49_000_000n,
    allocatedMicros: 0n,
    currency: 'USD',
    paidAt: null,
    settlementAttemptId: null,
    billingAccountId: 'acc-1',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  });

  /** The increment CAS the allocation boundary runs first. */
  const incrementWhere = (covered: bigint) => ({
    id: 'inv-1',
    status: 'finalized',
    paidAt: null,
    settlementAttemptId: null,
    allocatedMicros: covered,
  });

  /** The paid-marker CAS run when cumulative coverage reaches the total. */
  const paidWhere = (nowCovered: bigint) => ({
    id: 'inv-1',
    status: 'finalized',
    paidAt: null,
    settlementAttemptId: null,
    allocatedMicros: nowCovered,
  });

  describe('coverage-first allocation', () => {
    it('allocates a full single-rail attempt and marks the invoice paid', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      // soft-read meta → locked re-read → post-paid activation re-read
      invoiceFindUnique
        .mockResolvedValueOnce(finalizedInvoice())
        .mockResolvedValueOnce(finalizedInvoice())
        .mockResolvedValueOnce(
          finalizedInvoice({
            paidAt: new Date(),
            allocatedMicros: 49_000_000n,
            settlementAttemptId: 'att-stripe',
          }),
        );

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({
        allocated: true,
        paid: true,
        paidByThisAttempt: true,
        replayed: false,
        allocatedMicros: 49_000_000n,
      });
      expect(attemptUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'att-stripe',
          invoiceId: 'inv-1',
          method: 'stripe',
          status: 'succeeded',
          allocatedAt: null,
        },
        data: { allocatedAt: expect.any(Date) },
      });
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: incrementWhere(0n),
        data: { allocatedMicros: { increment: 49_000_000n } },
      });
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: paidWhere(49_000_000n),
        data: {
          paidAt: expect.any(Date),
          paidVia: 'stripe',
          settlementAttemptId: 'att-stripe',
        },
      });
      // usage_period full pay extends renewal entitlement, not upgrade apply.
      expect(applyPaidPlanCharge).not.toHaveBeenCalled();
      expect(extendEntitlementForPaidUsageInvoice).toHaveBeenCalledWith(
        tx,
        'inv-1',
        expect.any(Date),
        { periodLockAlreadyHeld: true },
      );
    });

    it('applies plan change only on first full settlement of a plan_charge invoice', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ amountMicros: 25_000_000n }));
      const charge = finalizedInvoice({
        purpose: 'plan_charge',
        totalMicros: 25_000_000n,
      });
      invoiceFindUnique
        .mockResolvedValueOnce(charge) // soft-read
        .mockResolvedValueOnce(charge) // locked re-read
        .mockResolvedValueOnce(
          finalizedInvoice({
            purpose: 'plan_charge',
            totalMicros: 25_000_000n,
            allocatedMicros: 25_000_000n,
            paidAt: new Date(),
            settlementAttemptId: 'att-stripe',
          }),
        );
      applyPaidPlanCharge.mockResolvedValue(undefined);

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.paid).toBe(true);
      expect(applyPaidPlanCharge).toHaveBeenCalledWith(
        tx,
        'inv-1',
        expect.any(Date),
        { periodLockAlreadyHeld: true },
      );
      // Period advisory lock acquired after row locks (executeRaw).
      expect(executeRaw).toHaveBeenCalled();
    });

    it('does not apply plan change on partial allocation', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ amountMicros: 10_000_000n }));
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({ purpose: 'plan_charge', totalMicros: 25_000_000n }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.paid).toBe(false);
      expect(applyPaidPlanCharge).not.toHaveBeenCalled();
    });

    it('replays apply on already-allocated paid plan_charge (idempotent recovery)', async () => {
      attemptFindUnique.mockResolvedValue(
        succeededAttempt({ allocatedAt: new Date('2026-08-16T00:00:00.000Z') }),
      );
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({
          purpose: 'plan_charge',
          totalMicros: 25_000_000n,
          allocatedMicros: 25_000_000n,
          paidAt: new Date(),
          settlementAttemptId: 'att-stripe',
        }),
      );
      applyPaidPlanCharge.mockResolvedValue(undefined);

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.replayed).toBe(true);
      expect(result.paid).toBe(true);
      expect(applyPaidPlanCharge).toHaveBeenCalledWith(
        tx,
        'inv-1',
        expect.any(Date),
        { periodLockAlreadyHeld: true },
      );
    });

    it('allocates a fixed-fee attempt partially and leaves the invoice unpaid', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice({ totalMicros: 109_000_000n }));

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      // A legitimate fixed-fee partial allocation: coverage counted, invoice
      // still unpaid (the separately-payable overage remainder remains).
      expect(result).toEqual({
        allocated: true,
        paid: false,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: 49_000_000n,
      });
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: incrementWhere(0n),
        data: { allocatedMicros: { increment: 49_000_000n } },
      });
      // No paid-marker CAS when coverage is below the frozen total.
      expect(
        invoiceUpdateMany.mock.calls.some(
          ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paidAt !== undefined,
        ),
      ).toBe(false);
    });

    it('tops an invoice up to paid with the overage remainder', async () => {
      // The fixed fee ($49) was already allocated; the overage attempt carries
      // exactly the remaining $60.
      attemptFindUnique.mockResolvedValue(
        succeededAttempt({ id: 'att-overage', amountMicros: 60_000_000n }),
      );
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({ totalMicros: 109_000_000n, allocatedMicros: 49_000_000n }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-overage',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({
        allocated: true,
        paid: true,
        paidByThisAttempt: true,
        replayed: false,
        allocatedMicros: 60_000_000n,
      });
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: incrementWhere(49_000_000n),
        data: { allocatedMicros: { increment: 60_000_000n } },
      });
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: paidWhere(109_000_000n),
        data: {
          paidAt: expect.any(Date),
          paidVia: 'stripe',
          settlementAttemptId: 'att-overage',
        },
      });
    });

    it('never allocates more than the remaining balance (caps over-coverage)', async () => {
      // A full $109 attempt arrives when $49 was already allocated: only the
      // remaining $60 may be allocated, never a cumulative sum above the total.
      attemptFindUnique.mockResolvedValue(
        succeededAttempt({ id: 'att-full', amountMicros: 109_000_000n }),
      );
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({ totalMicros: 109_000_000n, allocatedMicros: 49_000_000n }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-full',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(true);
      expect(result.paid).toBe(true);
      expect(result.allocatedMicros).toBe(60_000_000n);
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: incrementWhere(49_000_000n),
        data: { allocatedMicros: { increment: 60_000_000n } },
      });
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: paidWhere(109_000_000n),
        data: expect.objectContaining({ settlementAttemptId: 'att-full' }),
      });
    });
  });

  describe('replay and concurrency', () => {
    it('is an idempotent no-op when the same attempt was already allocated', async () => {
      attemptFindUnique.mockResolvedValue(
        succeededAttempt({ allocatedAt: new Date('2026-06-01T00:00:00.000Z') }),
      );
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({
        allocated: false,
        paid: false,
        paidByThisAttempt: false,
        replayed: true,
        allocatedMicros: 0n,
      });
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('does not re-allocate an already-allocated attempt even after the invoice was paid by another rail', async () => {
      attemptFindUnique.mockResolvedValue(
        succeededAttempt({ allocatedAt: new Date('2026-06-01T00:00:00.000Z') }),
      );
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({
          paidAt: new Date('2026-06-02T00:00:00.000Z'),
          settlementAttemptId: 'att-other',
        }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.replayed).toBe(true);
      expect(result.paid).toBe(true);
      expect(result.paidByThisAttempt).toBe(false);
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('never allocates when a competing rail already paid the invoice', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ id: 'att-usdc', method: 'usdc' }));
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({
          paidAt: new Date('2026-06-01T00:00:00.000Z'),
          settlementAttemptId: 'att-stripe',
        }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-usdc',
        invoiceId: 'inv-1',
        method: 'usdc',
      });

      expect(result).toEqual({
        allocated: false,
        paid: true,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: 0n,
      });
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('aborts the whole transaction when the coverage-increment CAS loses (never a half-committed allocation)', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());
      invoiceUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.settleInvoice(tx, {
          id: 'att-stripe',
          invoiceId: 'inv-1',
          method: 'stripe',
        }),
      ).rejects.toThrow(ConflictException);
      // The failure is surfaced as a rollback-triggering throw, never a
      // "successful replay" or a silent no-op with an orphaned attempt marker.
      expect(invoiceUpdateMany).toHaveBeenCalledWith({
        where: incrementWhere(0n),
        data: { allocatedMicros: { increment: 49_000_000n } },
      });
    });

    it('aborts the whole transaction when the paid-marker CAS loses (never diverged coverage/paid markers)', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());
      invoiceUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // increment wins
        .mockResolvedValueOnce({ count: 0 }); // paid-marker CAS loses

      await expect(
        service.settleInvoice(tx, {
          id: 'att-stripe',
          invoiceId: 'inv-1',
          method: 'stripe',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('aborts the whole transaction when the attempt allocation-marker CAS loses (never a fake replay)', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());
      attemptUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.settleInvoice(tx, {
          id: 'att-stripe',
          invoiceId: 'inv-1',
          method: 'stripe',
        }),
      ).rejects.toThrow(ConflictException);
      // A CAS failure must never be reported as `replayed: true`.
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('preconditions (read under stable row locks)', () => {
    it('locks the attempt row before the invoice row (stable lock order)', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

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

    it('refuses to allocate when the attempt is not succeeded', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ status: 'pending' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result).toEqual({
        allocated: false,
        paid: false,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: 0n,
      });
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the attempt method does not match the settling rail', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ method: 'usdc' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the attempt belongs to a different invoice', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ invoiceId: 'inv-other' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the invoice is not finalized', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(finalizedInvoice({ status: 'open' }));

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the currency does not match', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt({ currency: 'EUR' }));
      invoiceFindUnique.mockResolvedValue(finalizedInvoice());

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the attempt row is missing (no lock, no update)', async () => {
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

      expect(result).toEqual({
        allocated: false,
        paid: false,
        paidByThisAttempt: false,
        replayed: false,
        allocatedMicros: 0n,
      });
      expect(attemptFindUnique).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the invoice row is missing (no lock, no update)', async () => {
      queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join('');
        if (sql.includes('billing_payment_attempts'))
          return Promise.resolve([{ id: 'att-stripe' }]);
        return Promise.resolve([]);
      });

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-missing',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when the invoice row is missing after the locks', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(null);

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses to allocate when there is no remaining balance (fully covered, markers unset anomaly)', async () => {
      attemptFindUnique.mockResolvedValue(succeededAttempt());
      invoiceFindUnique.mockResolvedValue(
        finalizedInvoice({ totalMicros: 49_000_000n, allocatedMicros: 49_000_000n }),
      );

      const result = await service.settleInvoice(tx, {
        id: 'att-stripe',
        invoiceId: 'inv-1',
        method: 'stripe',
      });

      expect(result.allocated).toBe(false);
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(invoiceUpdateMany).not.toHaveBeenCalled();
    });
  });
});

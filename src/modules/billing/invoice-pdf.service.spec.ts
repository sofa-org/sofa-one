import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalBillingJson } from './billing-json';
import { InvoicePdfService } from './invoice-pdf.service';
import { buildInvoicePdf } from './invoice-pdf.writer';

jest.mock('./invoice-pdf.writer', () => ({
  // The service test spies on the writer to prove the PDF is priced from the
  // immutable invoice lines/snapshot, never the current plan.
  buildInvoicePdf: jest.fn((doc: { amount: string }) =>
    Buffer.from(`%PDF-1.4 mock ${doc.amount}`),
  ),
}));

const buildInvoicePdfMock = buildInvoicePdf as jest.MockedFunction<typeof buildInvoicePdf>;

function validSnapshot(period = '2026-05') {
  return {
    version: 1,
    period,
    planVersionId: 'plan-version-1',
    plan: { code: 'starter', name: 'Starter' },
    amounts: { totalMicros: '84' },
  };
}

function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalBillingJson(snapshot)).digest('hex');
}

describe('InvoicePdfService', () => {
  const accountFindUnique = jest.fn();
  const invoiceFindFirst = jest.fn();
  let service: InvoicePdfService;

  function invoiceRow(overrides: Record<string, unknown> = {}) {
    const snapshot = validSnapshot();
    return {
      id: 'inv-1',
      billingAccountId: 'acc-1',
      planVersionId: 'plan-version-1',
      periodStart: new Date('2026-05-01T00:00:00.000Z'),
      periodEnd: new Date('2026-06-01T00:00:00.000Z'),
      status: 'finalized',
      currency: 'USD',
      totalMicros: 84_000_000n,
      snapshotJson: snapshot,
      snapshotHash: snapshotHash(snapshot),
      finalizedAt: new Date('2026-06-02T00:00:00.000Z'),
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      paidAt: null,
      lines: [
        {
          lineType: 'monthly_fee',
          description: 'Monthly fee — Starter',
          amountMicros: 49_000_000n,
        },
        {
          lineType: 'outbound_tier',
          description: 'Outbound volume tier 1',
          amountMicros: 35_000_000n,
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    accountFindUnique.mockReset();
    invoiceFindFirst.mockReset();
    service = new InvoicePdfService({ billingAccount: { findUnique: accountFindUnique }, billingInvoice: { findFirst: invoiceFindFirst } } as any);
    buildInvoicePdfMock.mockClear();
  });

  it('generates a PDF for a finalized invoice priced from persisted lines', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(invoiceRow());

    const result = await service.generate('user-1', 'inv-1');

    expect(invoiceFindFirst).toHaveBeenCalledWith({
      where: { id: 'inv-1', billingAccountId: 'acc-1' },
      include: { lines: true },
    });
    expect(result.filename).toBe('invoice-inv-1.pdf');
    expect(result.contentType).toBe('application/pdf');
    expect(result.pdf.toString('ascii')).toBe('%PDF-1.4 mock 84');

    const doc = buildInvoicePdfMock.mock.calls[0][0];
    expect(doc).toMatchObject({
      invoiceNumber: 'inv-1',
      period: '2026-05',
      status: 'finalized',
      amount: '84',
      currency: 'USD',
    });
    // The PDF uses the persisted immutable line amounts (49 + 35), not a
    // recomputation from the current plan catalog.
    expect(doc.lines).toEqual([
      { description: 'Monthly fee — Starter', amount: '49' },
      { description: 'Outbound volume tier 1', amount: '35' },
    ]);
  });

  it('renders status "paid" when the invoice has been settled', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(
      invoiceRow({ paidAt: new Date('2026-06-03T10:00:00.000Z') }),
    );

    await service.generate('user-1', 'inv-1');

    const doc = buildInvoicePdfMock.mock.calls[0][0];
    expect(doc.status).toBe('paid');
  });

  it('throws NotFound when the user has no billing account', async () => {
    accountFindUnique.mockResolvedValue(null);

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(NotFoundException);
    expect(invoiceFindFirst).not.toHaveBeenCalled();
  });

  it('throws NotFound when the invoice is not owned by the user', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(null);

    await expect(service.generate('user-1', 'inv-other')).rejects.toThrow(NotFoundException);
  });

  it('rejects an open invoice (fail closed)', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(invoiceRow({ status: 'open' }));

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(ConflictException);
    expect(buildInvoicePdfMock).not.toHaveBeenCalled();
  });

  it('rejects a needs_review invoice', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(invoiceRow({ status: 'needs_review' }));

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(ConflictException);
  });

  it('rejects a void invoice', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(invoiceRow({ status: 'void' }));

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(ConflictException);
  });

  it('fails closed on a snapshot hash mismatch', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    const row = invoiceRow({ snapshotHash: '0'.repeat(64) });
    invoiceFindFirst.mockResolvedValue(row);

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(buildInvoicePdfMock).not.toHaveBeenCalled();
  });

  it('fails closed when the snapshot is not a plain object', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    const row = invoiceRow({ snapshotJson: null });
    invoiceFindFirst.mockResolvedValue(row);

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('fails closed when the snapshot serializes to a non-finite value', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    // canonicalBillingJson throws for non-finite numbers; the service must
    // translate that into a fail-closed 500 (the stored hash is irrelevant
    // because recomputation throws before the comparison).
    const bad = { amount: Number.POSITIVE_INFINITY };
    invoiceFindFirst.mockResolvedValue(
      invoiceRow({ snapshotJson: bad, snapshotHash: '0'.repeat(64) }),
    );

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('fails closed on a negative total', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    invoiceFindFirst.mockResolvedValue(invoiceRow({ totalMicros: -1n }));

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('fails closed on a negative line amount', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    const row = invoiceRow();
    row.lines[1].amountMicros = -35_000_000n;
    invoiceFindFirst.mockResolvedValue(row);

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('fails closed when the line amounts do not sum to the total', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    const row = invoiceRow();
    row.lines[1].amountMicros = 34_000_000n; // sum = 83, total = 84
    invoiceFindFirst.mockResolvedValue(row);

    await expect(service.generate('user-1', 'inv-1')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('orders line items deterministically for the PDF', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    const row = invoiceRow();
    // Reverse the persisted order; the service must re-sort deterministically.
    row.lines = [row.lines[1], row.lines[0]];
    invoiceFindFirst.mockResolvedValue(row);

    await service.generate('user-1', 'inv-1');

    const doc = buildInvoicePdfMock.mock.calls[0][0];
    expect(doc.lines.map((l: { description: string }) => l.description)).toEqual([
      'Monthly fee — Starter',
      'Outbound volume tier 1',
    ]);
  });

  it('accepts a renewal snapshot shape as long as the hash matches', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acc-1', userId: 'user-1' });
    const renewalSnapshot = {
      renewal: true,
      planVersionId: 'plan-version-1',
      period: '2026-08-01',
      fixedFeeMicros: '49000000',
    };
    invoiceFindFirst.mockResolvedValue(
      invoiceRow({
        snapshotJson: renewalSnapshot,
        snapshotHash: snapshotHash(renewalSnapshot),
        totalMicros: 49_000_000n,
        lines: [{ lineType: 'monthly_fee', description: 'Monthly fee — Starter', amountMicros: 49_000_000n }],
      }),
    );

    const result = await service.generate('user-1', 'inv-1');

    expect(result.pdf.toString('ascii')).toBe('%PDF-1.4 mock 49');
  });
});

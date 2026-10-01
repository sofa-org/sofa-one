import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { canonicalBillingJson } from './billing-json';
import { formatUtcMonth, microsToDecimalUsd } from './billing.utils';
import { buildInvoicePdf, type InvoicePdfDocument } from './invoice-pdf.writer';

type InvoiceRow = Prisma.BillingInvoiceGetPayload<{
  include: { lines: true };
}>;

export interface InvoicePdfResult {
  pdf: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Stable display order for invoice lines (unpaid/paid both keep this order).
 */
const LINE_ORDER: Record<string, number> = {
  monthly_fee: 0,
  outbound_tier: 1,
  api_overage: 2,
  wallet_overage: 3,
};

/**
 * Generates an immutable invoice PDF for the current user's billing account.
 *
 * Fail-closed by construction:
 *  - Only `finalized` invoices are downloadable (a paid invoice keeps
 *    `status = finalized` with `paidAt` set — there is no separate paid
 *    status), never `open`/`needs_review`/`void`.
 *  - Pricing comes exclusively from the persisted immutable `snapshotJson` /
 *    `snapshotHash` and invoice lines — never from the current plan catalog.
 *  - The snapshot hash is recomputed over the canonical JSON and must match;
 *    amounts must be non-negative and the line amounts must sum to the total.
 *    Any integrity violation fails closed with a 500, never a partial PDF.
 *  - The PDF embeds only display-safe strings (no snapshot, metadata, receipts,
 *    or unprocessed user input); the writer sanitizes to ASCII.
 */
@Injectable()
export class InvoicePdfService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(userId: string, invoiceId: string): Promise<InvoicePdfResult> {
    const invoice = await this.loadOwnedInvoice(userId, invoiceId);
    this.assertStatusEligible(invoice);
    this.assertIntegrity(invoice);
    const document = this.toDocument(invoice);
    return {
      pdf: buildInvoicePdf(document),
      filename: `invoice-${invoice.id}.pdf`,
      contentType: 'application/pdf',
    };
  }

  /** Loads the invoice scoped to the current user's BillingAccount (404 otherwise). */
  private async loadOwnedInvoice(userId: string, invoiceId: string): Promise<InvoiceRow> {
    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Invoice not found');

    const invoice = await this.prisma.billingInvoice.findFirst({
      where: { id: invoiceId, billingAccountId: account.id },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  /** Only finalized (incl. paid) invoices are ever printable. */
  private assertStatusEligible(invoice: InvoiceRow): void {
    if (invoice.status !== 'finalized') {
      throw new ConflictException('Invoice is not finalized');
    }
  }

  /**
   * Immutability/integrity gate. Recomputes the SHA-256 hash over the canonical
   * snapshot JSON and rejects any mismatch; rejects negative totals/lines and a
   * line sum that disagrees with the total. Every failure is a 500 (server-side
   * data integrity), never a partial or re-priced PDF.
   */
  private assertIntegrity(invoice: InvoiceRow): void {
    const snapshot = invoice.snapshotJson;
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new InternalServerErrorException('Invoice snapshot is invalid');
    }

    let recomputedHash: string;
    try {
      recomputedHash = createHash('sha256')
        .update(canonicalBillingJson(snapshot))
        .digest('hex');
    } catch {
      throw new InternalServerErrorException('Invoice snapshot is invalid');
    }
    if (recomputedHash !== invoice.snapshotHash) {
      throw new InternalServerErrorException('Invoice snapshot hash mismatch');
    }

    if (typeof invoice.totalMicros !== 'bigint' || invoice.totalMicros < 0n) {
      throw new InternalServerErrorException('Invoice total is invalid');
    }

    let lineSum = 0n;
    for (const line of invoice.lines) {
      if (typeof line.amountMicros !== 'bigint' || line.amountMicros < 0n) {
        throw new InternalServerErrorException('Invoice line amount is invalid');
      }
      lineSum += line.amountMicros;
    }
    if (lineSum !== invoice.totalMicros) {
      throw new InternalServerErrorException('Invoice line total mismatch');
    }
  }

  /** Builds display-safe PDF data from immutable invoice rows only. */
  private toDocument(invoice: InvoiceRow): InvoicePdfDocument {
    const lines = [...invoice.lines]
      .sort(
        (a, b) =>
          (LINE_ORDER[a.lineType] ?? 99) - (LINE_ORDER[b.lineType] ?? 99) ||
          a.description.localeCompare(b.description),
      )
      .map((line) => ({
        description: line.description || line.lineType,
        amount: microsToDecimalUsd(line.amountMicros),
      }));

    return {
      title: 'SOFA ONE Invoice',
      invoiceNumber: invoice.id,
      period: formatUtcMonth(invoice.periodStart),
      issuedAt: (invoice.finalizedAt ?? invoice.createdAt).toISOString().slice(0, 10),
      status: invoice.paidAt ? 'paid' : 'finalized',
      currency: invoice.currency || 'USD',
      amount: microsToDecimalUsd(invoice.totalMicros),
      lines,
      footer: 'Generated by SOFA ONE. Not a tax receipt.',
    };
  }
}

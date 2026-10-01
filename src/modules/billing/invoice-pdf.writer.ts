/**
 * Minimal, dependency-free PDF writer for billing invoices.
 *
 * Emits a single-page PDF using only the standard Helvetica font and printable
 * ASCII text — no third-party library, no CJK/brand fonts (out of scope). All
 * input text is sanitized to printable ASCII and PDF-escaped before it reaches
 * the content stream, so snapshot/metadata/receipts or unprocessed user input
 * are never embedded as-is. Known billing-description punctuation (em dash,
 * arrows) is mapped to readable ASCII first so persisted copy like
 * `Plan upgrade proration — Free → Starter` does not render as `? Free ? Starter`.
 * Amounts and layout are caller-supplied display strings only; the caller owns
 * all business/integrity validation.
 */

import { mapBillingDescriptionToAscii } from './invoice-pdf-description-map';

export interface InvoicePdfLineItem {
  /** Human-readable description (display-safe, sanitized to ASCII). */
  description: string;
  /** Decimal amount string, e.g. "49". */
  amount: string;
}

export interface InvoicePdfDocument {
  /** Invoice title, e.g. "SOFA ONE Invoice". */
  title: string;
  /** Invoice number (immutable DB id). */
  invoiceNumber: string;
  /** UTC period `YYYY-MM`. */
  period: string;
  /** Issued date (UTC ISO date `YYYY-MM-DD`). */
  issuedAt: string;
  /** Invoice status ("finalized"/"paid" display text). */
  status: string;
  /** 3-letter currency code. */
  currency: string;
  /** Total amount as a decimal USD string. */
  amount: string;
  /** Immutable invoice line items. */
  lines: InvoicePdfLineItem[];
  /** Footer note. */
  footer: string;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const OBJECT_COUNT = 7; // catalog, pages, page, F1, F2, contents = 6 objects + free entry 0

/**
 * Reduces arbitrary text to printable ASCII (7-bit) and escapes the PDF
 * text-string delimiters `\`, `(`, and `)`. Known billing punctuation is mapped
 * to readable ASCII first; remaining non-ASCII becomes `?`. Line breaks
 * collapse to a space.
 */
export function escapePdfText(text: string): string {
  return mapBillingDescriptionToAscii(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Builds a single-page invoice PDF as a Buffer (pure, no I/O, no deps). */
export function buildInvoicePdf(doc: InvoicePdfDocument): Buffer {
  if (doc.lines.length > 100) {
    throw new RangeError('Invoice PDF line count exceeds the single-page limit');
  }
  const content = buildContentStream(doc);
  return buildPdfBinary(content);
}

function buildContentStream(doc: InvoicePdfDocument): string {
  const cmds: string[] = ['BT'];
  let y = 720;

  const put = (text: string, font: 'F1' | 'F2', size: number, x: number, yy: number) => {
    cmds.push(`/${font} ${size} Tf`);
    cmds.push(`1 0 0 1 ${x} ${yy} Tm`);
    cmds.push(`(${escapePdfText(text)}) Tj`);
  };

  put(doc.title, 'F2', 18, MARGIN, y);
  y -= 26;
  put(`Invoice: ${doc.invoiceNumber}`, 'F1', 11, MARGIN, y);
  y -= 16;
  put(`Period: ${doc.period}`, 'F1', 11, MARGIN, y);
  y -= 16;
  put(`Issued: ${doc.issuedAt}`, 'F1', 11, MARGIN, y);
  y -= 16;
  put(`Status: ${doc.status}`, 'F1', 11, MARGIN, y);
  y -= 26;
  put(`Amount: ${doc.amount} ${doc.currency}`, 'F2', 14, MARGIN, y);
  y -= 32;
  put('Line items', 'F2', 12, MARGIN, y);
  y -= 18;

  for (const line of doc.lines) {
    if (y < 72) break;
    const description =
      line.description.length > 60 ? `${line.description.slice(0, 57)}...` : line.description;
    put(description, 'F1', 10, MARGIN, y);
    put(`${line.amount} ${doc.currency}`, 'F1', 10, PAGE_WIDTH - MARGIN - 130, y);
    y -= 14;
  }

  y = Math.max(y, 72) - 24;
  put(doc.footer, 'F1', 9, MARGIN, y);

  cmds.push('ET');
  return cmds.join('\n');
}

function buildPdfBinary(content: string): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n`,
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
    `6 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefOffset = pdf.length;

  let xref = `xref\n0 ${OBJECT_COUNT}\n`;
  for (let i = 0; i < OBJECT_COUNT; i++) {
    const offset = String(offsets[i] ?? 0).padStart(10, '0');
    const generation = i === 0 ? '65535' : '00000';
    const kind = i === 0 ? 'f' : 'n';
    xref += `${offset} ${generation} ${kind} \n`;
  }
  xref += `trailer\n<< /Size ${OBJECT_COUNT} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  // Every string above is printable ASCII, so byte length === string length.
  return Buffer.from(pdf + xref, 'ascii');
}

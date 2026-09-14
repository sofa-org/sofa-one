/**
 * Pure usage-evidence checks for billing-fixture integrity.
 */

/** Provider/evidence columns that fixture rows must keep as strict null. */
export const FIXTURE_USAGE_MUST_BE_NULL = [
  'baseUnitAmount',
  'assetId',
  'assetDecimals',
  'unitPriceMicros',
  'priceSource',
  'chainId',
  'walletAddress',
  'txHash',
  'receiptRef',
  'receiptLogIndex',
  'receiptBlockNumber',
  'receiptBlockHash',
  'receiptBlockTimestamp',
  'receiptStatus',
  'receiptData',
  'reconciliationRunId',
  'reconciledAt',
  'transactionId',
  'requestId',
  'endpoint',
  'statusCode',
  'reversalOfId',
  'adjustmentOfId',
] as const;

export type UsageEvidenceCheckResult = { ok: true } | { ok: false; field: string };

/** Strict null-only check (undefined fails). */
export function assertUsageEvidenceAllNull(row: Record<string, unknown>): UsageEvidenceCheckResult {
  for (const field of FIXTURE_USAGE_MUST_BE_NULL) {
    if (row[field] !== null) return { ok: false, field };
  }
  return { ok: true };
}

export type CleanupMissingInvoiceDecision = 'absent_ok' | 'fail_elsewhere' | 'fail_residue';

/**
 * Pure fail-closed decision when cleanup finds no current period invoice.
 * Does not delete — caller must only no-op on `absent_ok`.
 */
export function decideCleanupMissingInvoice(args: {
  invoiceAnywhere: boolean;
  periodUsageCount: number;
  periodAssignmentExists: boolean;
  assignmentAnywhere: boolean;
}): CleanupMissingInvoiceDecision {
  if (args.invoiceAnywhere) return 'fail_elsewhere';
  if (args.periodUsageCount === 0 && !args.periodAssignmentExists && !args.assignmentAnywhere) {
    return 'absent_ok';
  }
  return 'fail_residue';
}

export type ManifestPublishDecision = 'write_exclusive' | 'fail_exists';

/** Pure no-clobber gate before exclusive manifest publish. */
export function decideManifestPublish(targetExists: boolean): ManifestPublishDecision {
  return targetExists ? 'fail_exists' : 'write_exclusive';
}

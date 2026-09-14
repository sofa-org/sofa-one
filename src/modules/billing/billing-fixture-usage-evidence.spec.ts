import {
  assertUsageEvidenceAllNull,
  decideCleanupMissingInvoice,
  decideManifestPublish,
  FIXTURE_USAGE_MUST_BE_NULL,
} from './billing-fixture-usage-evidence';

describe('billing-fixture-usage-evidence', () => {
  const allNullRow = () =>
    Object.fromEntries(FIXTURE_USAGE_MUST_BE_NULL.map((f) => [f, null])) as Record<string, unknown>;

  it('accepts only strict null for every evidence column', () => {
    expect(assertUsageEvidenceAllNull(allNullRow())).toEqual({ ok: true });
  });

  it('rejects undefined (column not loaded) and non-null values', () => {
    const missing = allNullRow();
    delete missing.txHash;
    expect(assertUsageEvidenceAllNull(missing).ok).toBe(false);

    const dirty = allNullRow();
    dirty.chainId = 1n;
    expect(assertUsageEvidenceAllNull(dirty)).toEqual({ ok: false, field: 'chainId' });

    const receipt = allNullRow();
    receipt.receiptData = {};
    expect(assertUsageEvidenceAllNull(receipt).ok).toBe(false);
  });

  it('cleanup missing-invoice decision is fail-closed on residue or elsewhere', () => {
    expect(
      decideCleanupMissingInvoice({
        invoiceAnywhere: false,
        periodUsageCount: 0,
        periodAssignmentExists: false,
        assignmentAnywhere: false,
      }),
    ).toBe('absent_ok');

    expect(
      decideCleanupMissingInvoice({
        invoiceAnywhere: true,
        periodUsageCount: 0,
        periodAssignmentExists: false,
        assignmentAnywhere: false,
      }),
    ).toBe('fail_elsewhere');

    expect(
      decideCleanupMissingInvoice({
        invoiceAnywhere: false,
        periodUsageCount: 1,
        periodAssignmentExists: false,
        assignmentAnywhere: false,
      }),
    ).toBe('fail_residue');

    expect(
      decideCleanupMissingInvoice({
        invoiceAnywhere: false,
        periodUsageCount: 0,
        periodAssignmentExists: true,
        assignmentAnywhere: false,
      }),
    ).toBe('fail_residue');
  });

  it('manifest publish refuses clobber when target exists', () => {
    expect(decideManifestPublish(false)).toBe('write_exclusive');
    expect(decideManifestPublish(true)).toBe('fail_exists');
  });
});

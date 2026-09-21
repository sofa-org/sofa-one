import {
  AUTO_SUB_PM_NOT_REUSABLE_CODE,
  AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
  classifyAutoSubNeedsReviewOutcome,
  isSafeTerminalNoFundsIntent,
  isUnresolvedAutoSubNeedsReviewIntent,
  prismaWhereSafeTerminalNoFunds,
  prismaWhereUnresolvedAutoSubNeedsReview,
} from './auto-subscription-terminal-no-funds';

describe('auto-subscription-terminal-no-funds (BILL-020 B4)', () => {
  const safe = {
    status: 'needs_review' as const,
    lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
    lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
    dispatchedAt: null as Date | null,
    stripeSubscriptionId: null as string | null,
  };

  it('accepts only the complete safe terminal predicate', () => {
    expect(isSafeTerminalNoFundsIntent(safe)).toBe(true);
    expect(isUnresolvedAutoSubNeedsReviewIntent(safe)).toBe(false);
    expect(classifyAutoSubNeedsReviewOutcome(safe)).toBe('terminal_no_funds_review');
  });

  it('rejects both lastErrorType and lastErrorCode null', () => {
    const row = { ...safe, lastErrorType: null, lastErrorCode: null };
    expect(isSafeTerminalNoFundsIntent(row)).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent(row)).toBe(true);
    expect(classifyAutoSubNeedsReviewOutcome(row)).toBe('needs_review');
  });

  it('rejects lastErrorType null with exact code (one null)', () => {
    const row = {
      ...safe,
      lastErrorType: null,
      lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
    };
    expect(isSafeTerminalNoFundsIntent(row)).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent(row)).toBe(true);
    expect(classifyAutoSubNeedsReviewOutcome(row)).toBe('needs_review');
  });

  it('rejects lastErrorCode null with exact type (one null)', () => {
    const row = {
      ...safe,
      lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
      lastErrorCode: null,
    };
    expect(isSafeTerminalNoFundsIntent(row)).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent(row)).toBe(true);
    expect(classifyAutoSubNeedsReviewOutcome(row)).toBe('needs_review');
  });

  it('rejects partial type/code matches', () => {
    expect(
      isSafeTerminalNoFundsIntent({
        ...safe,
        lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
        lastErrorCode: 'pm_save_error',
      }),
    ).toBe(false);
    expect(
      isSafeTerminalNoFundsIntent({
        ...safe,
        lastErrorType: 'uncertain',
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
      }),
    ).toBe(false);
    expect(
      isUnresolvedAutoSubNeedsReviewIntent({
        ...safe,
        lastErrorType: 'uncertain',
        lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
      }),
    ).toBe(true);
  });

  it('rejects exact labels with dispatchedAt set', () => {
    const row = {
      ...safe,
      dispatchedAt: new Date('2026-09-18T12:00:00.000Z'),
    };
    expect(isSafeTerminalNoFundsIntent(row)).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent(row)).toBe(true);
    expect(classifyAutoSubNeedsReviewOutcome(row)).toBe('needs_review');
  });

  it('rejects exact labels with stripeSubscriptionId bound', () => {
    const row = {
      ...safe,
      stripeSubscriptionId: 'sub_bound',
    };
    expect(isSafeTerminalNoFundsIntent(row)).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent(row)).toBe(true);
    expect(classifyAutoSubNeedsReviewOutcome(row)).toBe('needs_review');
  });

  it('rejects empty-string subscription binding as unresolved', () => {
    const row = { ...safe, stripeSubscriptionId: '' };
    expect(isSafeTerminalNoFundsIntent(row)).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent(row)).toBe(true);
  });

  it('rejects non-needs_review status when provided', () => {
    expect(isSafeTerminalNoFundsIntent({ ...safe, status: 'pending' })).toBe(false);
    expect(isSafeTerminalNoFundsIntent({ ...safe, status: 'in_flight' })).toBe(false);
    // pending/in_flight are not counted by the needs_review unresolved probe.
    expect(isUnresolvedAutoSubNeedsReviewIntent({ ...safe, status: 'pending' })).toBe(false);
    expect(isUnresolvedAutoSubNeedsReviewIntent({ ...safe, status: 'in_flight' })).toBe(false);
  });

  it('prisma safe-where encodes the complete fence', () => {
    expect(prismaWhereSafeTerminalNoFunds()).toEqual({
      status: 'needs_review',
      lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
      lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
      dispatchedAt: null,
      stripeSubscriptionId: null,
    });
  });

  it('prisma unresolved-where uses explicit OR branches for nullables, partials, and fences', () => {
    const unresolved = prismaWhereUnresolvedAutoSubNeedsReview();
    expect(unresolved.status).toBe('needs_review');
    expect(unresolved.OR).toEqual([
      { lastErrorType: null },
      { lastErrorType: { not: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE } },
      { lastErrorCode: null },
      { lastErrorCode: { not: AUTO_SUB_PM_NOT_REUSABLE_CODE } },
      { dispatchedAt: { not: null } },
      { stripeSubscriptionId: { not: null } },
    ]);
    // Must not rely on NOT(AND …) which drops SQL NULL rows.
    expect(unresolved).not.toHaveProperty('NOT');
  });
});

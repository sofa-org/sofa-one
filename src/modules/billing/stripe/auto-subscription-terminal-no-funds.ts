/**
 * BILL-020 shared terminal no-funds predicates (worker backlog + processDue
 * classification). Constants live here so the worker/health lane does not depend
 * on loading the full auto-subscription service module.
 */

/** Persisted lastErrorType for terminal no-funds auto-subscription review. */
export const AUTO_SUB_TERMINAL_NO_FUNDS_TYPE = 'terminal_no_funds' as const;

/** Persisted lastErrorCode when a Card PaymentMethod cannot be re-attached. */
export const AUTO_SUB_PM_NOT_REUSABLE_CODE = 'payment_method_not_reusable' as const;

/**
 * Fields required to evaluate the BILL-020 safe terminal no-funds predicate.
 * Used by immediate classification outcomes and persisted worker backlog checks.
 */
export type TerminalNoFundsIntentFields = {
  status?: string | null;
  lastErrorType?: string | null;
  lastErrorCode?: string | null;
  dispatchedAt?: Date | string | null;
  stripeSubscriptionId?: string | null;
};

/**
 * Complete safe terminal no-funds predicate (BILL-020 B4).
 *
 * Safe (does NOT fail worker heartbeat / does NOT count as unresolved backlog)
 * only when ALL hold:
 * - status is `needs_review` (when provided)
 * - lastErrorType is exactly `terminal_no_funds` (null/other → unresolved)
 * - lastErrorCode is exactly `payment_method_not_reusable` (null/partial → unresolved)
 * - dispatchedAt IS NULL (any dispatch → unresolved)
 * - stripeSubscriptionId IS NULL (any binding, including empty string → unresolved)
 *
 * Null, unclassified, or partially matched labels remain unresolved.
 */
export function isSafeTerminalNoFundsIntent(intent: TerminalNoFundsIntentFields): boolean {
  if (intent.status != null && intent.status !== 'needs_review') {
    return false;
  }
  // Exact equality only — null/undefined/empty/partial never qualify.
  if (intent.lastErrorType !== AUTO_SUB_TERMINAL_NO_FUNDS_TYPE) {
    return false;
  }
  if (intent.lastErrorCode !== AUTO_SUB_PM_NOT_REUSABLE_CODE) {
    return false;
  }
  if (intent.dispatchedAt != null) {
    return false;
  }
  // Any non-null subscription id (including empty string) is unresolved.
  if (intent.stripeSubscriptionId != null) {
    return false;
  }
  return true;
}

/**
 * Inverse of the safe terminal predicate for needs_review rows.
 * True when the row is operator-unresolved risk (null labels, partial labels,
 * dispatched, or subscription-bound). Pending/in_flight are handled separately
 * by the worker pending/in_flight backlog count.
 */
export function isUnresolvedAutoSubNeedsReviewIntent(intent: TerminalNoFundsIntentFields): boolean {
  if (intent.status != null && intent.status !== 'needs_review') {
    return false;
  }
  return !isSafeTerminalNoFundsIntent({ ...intent, status: 'needs_review' });
}

/**
 * processDue outcome split: safe terminal → terminal_no_funds_review (does not
 * fail heartbeat); everything else under needs_review → needs_review (fails).
 */
export function classifyAutoSubNeedsReviewOutcome(
  intent: TerminalNoFundsIntentFields,
): 'needs_review' | 'terminal_no_funds_review' {
  return isSafeTerminalNoFundsIntent(intent) ? 'terminal_no_funds_review' : 'needs_review';
}

/**
 * Prisma WHERE for rows that satisfy the full safe terminal predicate
 * (excluded from unresolved backlog).
 */
export function prismaWhereSafeTerminalNoFunds(): {
  status: 'needs_review';
  lastErrorType: typeof AUTO_SUB_TERMINAL_NO_FUNDS_TYPE;
  lastErrorCode: typeof AUTO_SUB_PM_NOT_REUSABLE_CODE;
  dispatchedAt: null;
  stripeSubscriptionId: null;
} {
  return {
    status: 'needs_review',
    lastErrorType: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE,
    lastErrorCode: AUTO_SUB_PM_NOT_REUSABLE_CODE,
    dispatchedAt: null,
    stripeSubscriptionId: null,
  };
}

/**
 * Prisma WHERE for auto-sub `needs_review` rows that are NOT safe terminal.
 *
 * Explicit OR branches (not `NOT (AND …)`) so SQL three-valued logic cannot
 * drop nullable lastErrorType/lastErrorCode rows. A row is unresolved when any
 * of:
 * - lastErrorType IS NULL
 * - lastErrorType is not the exact terminal type (partial / other labels)
 * - lastErrorCode IS NULL
 * - lastErrorCode is not the exact PM-not-reusable code (partial / other labels)
 * - dispatchedAt IS NOT NULL
 * - stripeSubscriptionId IS NOT NULL
 *
 * Only exact type+code with both fence columns null is excluded (safe).
 */
export function prismaWhereUnresolvedAutoSubNeedsReview(): {
  status: 'needs_review';
  OR: Array<Record<string, unknown>>;
} {
  return {
    status: 'needs_review',
    OR: [
      { lastErrorType: null },
      { lastErrorType: { not: AUTO_SUB_TERMINAL_NO_FUNDS_TYPE } },
      { lastErrorCode: null },
      { lastErrorCode: { not: AUTO_SUB_PM_NOT_REUSABLE_CODE } },
      { dispatchedAt: { not: null } },
      { stripeSubscriptionId: { not: null } },
    ],
  };
}

import { Prisma } from '@prisma/client';

/**
 * Shared billing lock protocol (Gate 1 attempt 3 — uniform across all rails):
 *
 *   1. period advisory lock  (accountId + periodStart)
 *   2. attempt FOR UPDATE     (when settling a payment)
 *   3. invoice FOR UPDATE
 *
 * Callers must NOT hold attempt/invoice row locks before acquiring the period
 * lock. InvoiceSettlementService owns this order end-to-end; Stripe webhook /
 * USDC / renewal catch-up must not pre-lock attempt/invoice before settleInvoice.
 *
 * Cross-period account scheduling uses the target period's advisory key.
 * First-subscription create uses a separate account lease on BillingAccount.
 *
 * PostgreSQL xact advisory locks are re-entrant for the same key in one TX;
 * that is convenience only — not a substitute for correct order.
 */
export async function acquireBillingPeriodAdvisoryLock(
  tx: Prisma.TransactionClient,
  billingAccountId: string,
  periodStart: Date,
): Promise<void> {
  const key = `${billingAccountId}:${periodStart.toISOString()}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** Account-scoped advisory lock for subscription-create / cross-period races. */
export async function acquireBillingAccountAdvisoryLock(
  tx: Prisma.TransactionClient,
  billingAccountId: string,
): Promise<void> {
  const key = `billing-account:${billingAccountId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

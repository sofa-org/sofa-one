import { Prisma } from '@prisma/client';

/** The single advisory-lock key protocol shared by billing writers. */
export async function acquireBillingPeriodAdvisoryLock(
  tx: Prisma.TransactionClient,
  billingAccountId: string,
  periodStart: Date,
): Promise<void> {
  const key = `${billingAccountId}:${periodStart.toISOString()}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

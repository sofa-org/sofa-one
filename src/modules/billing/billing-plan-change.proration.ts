/**
 * Pure proration helpers for payment-aware plan upgrades.
 *
 * All amounts are bigint microdollars (1 USD = 1_000_000 micros).
 * Stripe cents are 10_000 micros. Never use floating-point money math.
 */

/** 1 Stripe cent = 10,000 microdollars. */
export const MICROS_PER_CENT = 10_000n;

/**
 * Ceiling division for non-negative bigints: ceil(numerator / denominator).
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('ceilDiv requires a positive denominator');
  }
  if (numerator < 0n) {
    throw new RangeError('ceilDiv requires a non-negative numerator');
  }
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Prorated upgrade charge in microdollars, ceil'd to micros then to Stripe cents.
 *
 * amount = ceil_micros((targetFee - currentFee) * remainingMs / totalMs)
 * then ceil to the next cent boundary so Stripe and USDC share one positive amount.
 *
 * Returns null when the target fee is not strictly greater than the current fee
 * (cannot walk the upgrade-charge path).
 */
export function calculateUpgradeProrationMicros(args: {
  currentMonthlyFeeMicros: bigint;
  targetMonthlyFeeMicros: bigint;
  now: Date;
  periodStart: Date;
  periodEnd: Date;
}): bigint | null {
  const {
    currentMonthlyFeeMicros,
    targetMonthlyFeeMicros,
    now,
    periodStart,
    periodEnd,
  } = args;

  if (targetMonthlyFeeMicros <= currentMonthlyFeeMicros) return null;

  const diff = targetMonthlyFeeMicros - currentMonthlyFeeMicros;
  const totalMs = BigInt(periodEnd.getTime() - periodStart.getTime());
  if (totalMs <= 0n) {
    throw new RangeError('billing period must have positive duration');
  }

  const clampedNowMs = Math.min(
    Math.max(now.getTime(), periodStart.getTime()),
    periodEnd.getTime(),
  );
  const remainingMs = BigInt(periodEnd.getTime() - clampedNowMs);
  if (remainingMs <= 0n) return null;

  const rawMicros = ceilDiv(diff * remainingMs, totalMs);
  if (rawMicros <= 0n) return null;

  // Stripe-cent ceil so both rails store the same positive, cent-aligned amount.
  return ceilDiv(rawMicros, MICROS_PER_CENT) * MICROS_PER_CENT;
}

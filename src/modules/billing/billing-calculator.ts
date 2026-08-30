/**
 * Pure billing calculator for SOFA ONE.
 *
 * All monetary amounts are bigints denominated in microdollars (1 USD = 1_000_000
 * microdollars). Rates are expressed in ppm (parts per million): 100 ppm = 0.0100%.
 *
 * Values follow PRICING.md:
 * - Plans Free/Starter/Growth/Scale/Business carry a fixed monthly fee plus free
 *   outbound volume, wallet and API-call allowances. Enterprise is custom (nulls).
 * - Outbound overage is billed in marginal, half-open tiers against billable volume
 *   = max(gross outbound - included allowance, 0), each tier rounded half-up.
 */

export const MICROS_PER_DOLLAR = 1_000_000n;
export const PPM_DENOMINATOR = 1_000_000n;

export type PlanId = 'free' | 'starter' | 'growth' | 'scale' | 'business' | 'enterprise';

export interface BillingPlanConfig {
  readonly id: PlanId;
  readonly name: string;
  readonly monthlyFeeMicros: bigint | null;
  readonly includedOutboundMicros: bigint | null;
  readonly includedWallets: number | null;
  readonly includedApiCallsPerMonth: number | null;
}

export interface OutboundTier {
  /** Exclusive upper bound in microdollars; null means unbounded. */
  readonly upperBoundMicros: bigint | null;
  /** Marginal rate in ppm (e.g. 100 = 0.0100%). */
  readonly ratePpm: number;
}

export interface OutboundTierBreakdownEntry {
  readonly upperBoundMicros: bigint | null;
  readonly ratePpm: number;
  readonly volumeMicros: bigint;
  readonly feeMicros: bigint;
}

export interface InvoiceTotalsInput {
  readonly plan: BillingPlanConfig;
  readonly grossOutboundMicros: bigint;
  readonly activeWallets?: number;
  readonly apiCallsTotal?: number;
  /** Overage rate per over-limit API call, in microdollars; defaults to 0. */
  readonly apiOverageRateMicros?: bigint;
  /** Overage rate per over-limit wallet per month, in microdollars; defaults to 0. */
  readonly walletOverageRateMicros?: bigint;
  readonly tiers?: readonly OutboundTier[];
}

export interface InvoiceTotals {
  readonly monthlyFeeMicros: bigint;
  readonly billableOutboundMicros: bigint;
  readonly outboundOverageMicros: bigint;
  readonly apiOverageMicros: bigint;
  readonly walletOverageMicros: bigint;
  readonly totalMicros: bigint;
  readonly outboundTiers: readonly OutboundTierBreakdownEntry[];
}

/**
 * Default overage rates from the accepted product boundary (PRICING.md §7
 * ranges narrowed to fixed values): API calls at $0.001/call (1_000 micros)
 * and active wallets at $0.01/wallet/month (10_000 micros). Seeded into new
 * plan versions; existing used plan versions are versioned forward, never
 * rewritten in place.
 */
export const DEFAULT_API_OVERAGE_RATE_MICROS = 1_000n;
export const DEFAULT_WALLET_OVERAGE_RATE_MICROS = 10_000n;

function micros(dollars: number): bigint {
  return BigInt(dollars) * MICROS_PER_DOLLAR;
}

/**
 * Marginal outbound overage tiers from PRICING.md section 4, applied to billable
 * volume. Half-open intervals: [0, $500K), [$500K, $2M), [$2M, $10M), [$10M, $50M),
 * [$50M, $200M), [$200M, +inf).
 */
export const STANDARD_OUTBOUND_TIERS: readonly OutboundTier[] = [
  { upperBoundMicros: micros(500_000), ratePpm: 100 },
  { upperBoundMicros: micros(2_000_000), ratePpm: 75 },
  { upperBoundMicros: micros(10_000_000), ratePpm: 50 },
  { upperBoundMicros: micros(50_000_000), ratePpm: 25 },
  { upperBoundMicros: micros(200_000_000), ratePpm: 15 },
  { upperBoundMicros: null, ratePpm: 10 },
];

/** Public plan configurations from PRICING.md section 3; Enterprise is custom (nulls). */
export const PLANS: Record<PlanId, BillingPlanConfig> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyFeeMicros: micros(0),
    includedOutboundMicros: micros(50_000),
    includedWallets: 10,
    includedApiCallsPerMonth: 10_000,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyFeeMicros: micros(49),
    includedOutboundMicros: micros(250_000),
    includedWallets: 100,
    includedApiCallsPerMonth: 100_000,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    monthlyFeeMicros: micros(199),
    includedOutboundMicros: micros(1_000_000),
    includedWallets: 1_000,
    includedApiCallsPerMonth: 1_000_000,
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    monthlyFeeMicros: micros(799),
    includedOutboundMicros: micros(5_000_000),
    includedWallets: 5_000,
    includedApiCallsPerMonth: 5_000_000,
  },
  business: {
    id: 'business',
    name: 'Business',
    monthlyFeeMicros: micros(1_999),
    includedOutboundMicros: micros(25_000_000),
    includedWallets: 25_000,
    includedApiCallsPerMonth: 25_000_000,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyFeeMicros: null,
    includedOutboundMicros: null,
    includedWallets: null,
    includedApiCallsPerMonth: null,
  },
};

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      'roundHalfUp requires a non-negative numerator and a positive denominator',
    );
  }
  return (numerator * 2n + denominator) / (2n * denominator);
}

function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new RangeError(`${name} must not be negative`);
  }
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function computeOutboundBreakdown(
  grossOutboundMicros: bigint,
  includedMicros: bigint,
  tiers: readonly OutboundTier[],
): { billableMicros: bigint; totalFeeMicros: bigint; entries: OutboundTierBreakdownEntry[] } {
  assertNonNegative(grossOutboundMicros, 'grossOutboundMicros');
  assertNonNegative(includedMicros, 'includedMicros');

  const billableMicros =
    grossOutboundMicros > includedMicros ? grossOutboundMicros - includedMicros : 0n;

  const entries: OutboundTierBreakdownEntry[] = [];
  let cursor = 0n;
  let totalFeeMicros = 0n;

  for (const tier of tiers) {
    if (billableMicros <= cursor) break;
    const tierUpper =
      tier.upperBoundMicros === null
        ? billableMicros
        : minBigint(tier.upperBoundMicros, billableMicros);
    if (tierUpper <= cursor) continue;
    const volumeMicros = tierUpper - cursor;
    cursor = tierUpper;
    const feeMicros = roundHalfUp(volumeMicros * BigInt(tier.ratePpm), PPM_DENOMINATOR);
    totalFeeMicros += feeMicros;
    entries.push({
      upperBoundMicros: tier.upperBoundMicros,
      ratePpm: tier.ratePpm,
      volumeMicros,
      feeMicros,
    });
  }

  return { billableMicros, totalFeeMicros, entries };
}

/**
 * Calculates the outbound volume overage fee after subtracting the included
 * allowance, applied against marginal half-open tiers. Each tier fee is
 * roundHalfUp(tierVolume * ratePpm / 1_000_000) and results are summed.
 */
export function calculateOutboundOverage(
  grossOutboundMicros: bigint,
  includedMicros: bigint,
  tiers: readonly OutboundTier[] = STANDARD_OUTBOUND_TIERS,
): bigint {
  return computeOutboundBreakdown(grossOutboundMicros, includedMicros, tiers).totalFeeMicros;
}

/**
 * Totals a monthly invoice: plan monthly fee + outbound overage + API-call
 * overage + wallet overage. All amounts are bigints in microdollars and the
 * outbound tier breakdown is included.
 */
export function calculateInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  const monthlyFeeMicros = input.plan.monthlyFeeMicros ?? 0n;
  const includedOutboundMicros = input.plan.includedOutboundMicros ?? 0n;
  const tiers = input.tiers ?? STANDARD_OUTBOUND_TIERS;

  const breakdown = computeOutboundBreakdown(
    input.grossOutboundMicros,
    includedOutboundMicros,
    tiers,
  );

  const apiOverageMicros = computeUsageOverage(
    input.apiCallsTotal ?? 0,
    input.plan.includedApiCallsPerMonth ?? 0,
    input.apiOverageRateMicros ?? DEFAULT_API_OVERAGE_RATE_MICROS,
  );
  const walletOverageMicros = computeUsageOverage(
    input.activeWallets ?? 0,
    input.plan.includedWallets ?? 0,
    input.walletOverageRateMicros ?? DEFAULT_WALLET_OVERAGE_RATE_MICROS,
  );

  const totalMicros =
    monthlyFeeMicros + breakdown.totalFeeMicros + apiOverageMicros + walletOverageMicros;

  return {
    monthlyFeeMicros,
    billableOutboundMicros: breakdown.billableMicros,
    outboundOverageMicros: breakdown.totalFeeMicros,
    apiOverageMicros,
    walletOverageMicros,
    totalMicros,
    outboundTiers: breakdown.entries,
  };
}

function computeUsageOverage(
  totalUnits: number,
  includedUnits: number,
  rateMicrosPerUnit: bigint,
): bigint {
  if (totalUnits < 0 || includedUnits < 0) {
    throw new RangeError('usage counts must not be negative');
  }
  if (rateMicrosPerUnit < 0n) {
    throw new RangeError('usage overage rate must not be negative');
  }
  const billableUnits = Math.max(totalUnits - includedUnits, 0);
  return rateMicrosPerUnit * BigInt(billableUnits);
}

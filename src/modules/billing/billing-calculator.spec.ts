import {
  DEFAULT_API_OVERAGE_RATE_MICROS,
  DEFAULT_WALLET_OVERAGE_RATE_MICROS,
  MICROS_PER_DOLLAR,
  PLANS,
  STANDARD_OUTBOUND_TIERS,
  calculateInvoiceTotals,
  calculateOutboundOverage,
} from './billing-calculator';

const micros = (dollars: number): bigint => BigInt(dollars) * MICROS_PER_DOLLAR;

describe('billing-calculator', () => {
  describe('calculateOutboundOverage', () => {
    it('returns 0 when gross outbound is within the free allowance', () => {
      expect(calculateOutboundOverage(micros(40_000), micros(50_000))).toBe(0n);
    });

    it('returns 0 when gross outbound exactly equals the allowance', () => {
      expect(calculateOutboundOverage(micros(50_000), micros(50_000))).toBe(0n);
    });

    it('charges only the first tier for the PRICING.md Starter example', () => {
      // $600K gross - $250K allowance = $350K billable at 100 ppm = $35
      expect(calculateOutboundOverage(micros(600_000), micros(250_000))).toBe(micros(35));
    });

    it('bills marginal tiers for the PRICING.md Scale example', () => {
      // $18M gross - $5M allowance = $13M billable
      // $50 + $112.50 + $400 + $75 = $637.50
      expect(calculateOutboundOverage(micros(18_000_000), micros(5_000_000))).toBe(637_500_000n);
    });

    it('bills marginal tiers for the PRICING.md Business example', () => {
      // $90M gross - $25M allowance = $65M billable
      // $50 + $112.50 + $400 + $1,000 + $225 = $1,787.50
      expect(calculateOutboundOverage(micros(90_000_000), micros(25_000_000))).toBe(1_787_500_000n);
    });

    it('respects the half-open $500K tier boundary', () => {
      // Exactly $500K billable stays entirely in tier 1 (100 ppm) = $50
      expect(calculateOutboundOverage(micros(500_000), 0n)).toBe(micros(50));
      // One microdollar past $500K moves 1 microdollar into tier 2 (75 ppm),
      // which rounds down to 0, so the fee is unchanged.
      expect(calculateOutboundOverage(micros(500_000) + 1n, 0n)).toBe(micros(50));
    });

    it('respects the half-open $2M tier boundary', () => {
      // Just below $2M: $50 + (1,499,999 * 0.0075%) = $112.499925
      expect(calculateOutboundOverage(micros(1_999_999), 0n)).toBe(162_499_925n);
      // Exactly $2M: $50 + $112.50 = $162.50
      expect(calculateOutboundOverage(micros(2_000_000), 0n)).toBe(162_500_000n);
    });

    it('applies the unbounded final tier', () => {
      // $300M billable: $50 + $112.50 + $400 + $1,000 + $2,250 + $1,000 = $4,812.50
      expect(calculateOutboundOverage(micros(300_000_000), 0n)).toBe(4_812_500_000n);
    });

    it('rounds half up per tier', () => {
      // 5,000 microdollars at 100 ppm = 0.5 microdollar -> rounds up to 1
      expect(calculateOutboundOverage(5_000n, 0n)).toBe(1n);
      // 4,999 microdollars at 100 ppm = 0.4999 -> rounds down to 0
      expect(calculateOutboundOverage(4_999n, 0n)).toBe(0n);
      // 5,001 microdollars at 100 ppm = 0.5001 -> rounds up to 1
      expect(calculateOutboundOverage(5_001n, 0n)).toBe(1n);
    });

    it('handles very large volumes without overflow', () => {
      // $1T billable: [0,500K) $50 + [500K,2M) $112.50 + [2M,10M) $400 +
      // [10M,50M) $1,000 + [50M,200M) $2,250 + [200M,1T) = 999,800M * 0.001% = $9,998,000
      expect(calculateOutboundOverage(micros(1_000_000_000_000), 0n)).toBe(10_001_812_500_000n);
    });

    it('throws on negative inputs', () => {
      expect(() => calculateOutboundOverage(-1n, 0n)).toThrow(RangeError);
      expect(() => calculateOutboundOverage(0n, -1n)).toThrow(RangeError);
    });
  });

  describe('calculateInvoiceTotals', () => {
    it('totals the PRICING.md Starter example: $49 + $35 = $84', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.starter,
        grossOutboundMicros: micros(600_000),
      });

      expect(totals.monthlyFeeMicros).toBe(micros(49));
      expect(totals.billableOutboundMicros).toBe(micros(350_000));
      expect(totals.outboundOverageMicros).toBe(micros(35));
      expect(totals.apiOverageMicros).toBe(0n);
      expect(totals.walletOverageMicros).toBe(0n);
      expect(totals.totalMicros).toBe(micros(84));
      expect(totals.outboundTiers).toEqual([
        {
          upperBoundMicros: micros(500_000),
          ratePpm: 100,
          volumeMicros: micros(350_000),
          feeMicros: micros(35),
        },
      ]);
    });

    it('totals the PRICING.md Scale example: $799 + $637.50 = $1,436.50', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.scale,
        grossOutboundMicros: micros(18_000_000),
      });

      expect(totals.monthlyFeeMicros).toBe(micros(799));
      expect(totals.outboundOverageMicros).toBe(637_500_000n);
      expect(totals.totalMicros).toBe(1_436_500_000n);
      expect(totals.outboundTiers).toEqual([
        {
          upperBoundMicros: micros(500_000),
          ratePpm: 100,
          volumeMicros: micros(500_000),
          feeMicros: micros(50),
        },
        {
          upperBoundMicros: micros(2_000_000),
          ratePpm: 75,
          volumeMicros: micros(1_500_000),
          feeMicros: 112_500_000n,
        },
        {
          upperBoundMicros: micros(10_000_000),
          ratePpm: 50,
          volumeMicros: micros(8_000_000),
          feeMicros: micros(400),
        },
        {
          upperBoundMicros: micros(50_000_000),
          ratePpm: 25,
          volumeMicros: micros(3_000_000),
          feeMicros: micros(75),
        },
      ]);
    });

    it('totals the PRICING.md Business example: $1,999 + $1,787.50 = $3,786.50', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.business,
        grossOutboundMicros: micros(90_000_000),
      });

      expect(totals.monthlyFeeMicros).toBe(micros(1_999));
      expect(totals.outboundOverageMicros).toBe(1_787_500_000n);
      expect(totals.totalMicros).toBe(3_786_500_000n);
      expect(totals.outboundTiers).toHaveLength(5);
    });

    it('bills nothing on the Free plan within the allowance', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.free,
        grossOutboundMicros: micros(40_000),
      });

      expect(totals.totalMicros).toBe(0n);
      expect(totals.outboundTiers).toEqual([]);
    });

    it('never charges API overage even when over the allowance with a nonzero legacy rate set', () => {
      // API usage is a hard quota (HTTP 429 at the limit), so over-limit calls
      // can never appear on an invoice. A legacy/persisted nonzero
      // apiOverageRateMicros ($0.001/call) is deliberately inert.
      const totals = calculateInvoiceTotals({
        plan: PLANS.starter, // 100K included API calls
        grossOutboundMicros: 0n,
        apiCallsTotal: 150_000,
        apiOverageRateMicros: 1_000n, // legacy $0.001 per call
      });

      expect(totals.apiOverageMicros).toBe(0n);
      // Only the $49 monthly fee is billed; no $50 API-overage charge appears.
      expect(totals.totalMicros).toBe(micros(49));
    });

    it('does not charge API overage by any default rate when over the allowance', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.starter,
        grossOutboundMicros: 0n,
        apiCallsTotal: 500_000,
      });

      expect(totals.apiOverageMicros).toBe(0n);
      expect(totals.totalMicros).toBe(micros(49));
    });

    it('charges wallet overage when over the allowance and a rate is set', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.scale, // 5,000 included wallets
        grossOutboundMicros: 0n,
        activeWallets: 5_020,
        walletOverageRateMicros: 5_000n, // $0.005 per wallet/month
      });

      // 20 over-limit wallets * $0.005 = $0.10
      expect(totals.walletOverageMicros).toBe(100_000n);
      expect(totals.totalMicros).toBe(799_100_000n);
    });

    it('treats Enterprise custom nulls as zero base fee and zero allowance', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.enterprise,
        grossOutboundMicros: micros(100_000),
      });

      expect(totals.monthlyFeeMicros).toBe(0n);
      expect(totals.billableOutboundMicros).toBe(micros(100_000));
      expect(totals.outboundOverageMicros).toBe(micros(10));
      expect(totals.totalMicros).toBe(micros(10));
    });

    it('accepts custom tiers', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.enterprise, // zero allowance so the full $1,000 is billable
        grossOutboundMicros: micros(1_000),
        tiers: [{ upperBoundMicros: null, ratePpm: 50 }],
      });

      expect(totals.outboundOverageMicros).toBe(50_000n); // $1,000 * 0.0050% = $0.05
    });
  });

  describe('API hard-limit and overage rate defaults (P0)', () => {
    it('ships an API default of $0 (hard quota) and wallet $0.01/wallet/month', () => {
      // API usage is a hard limit (HTTP 429 at the allowance), never an
      // overage dimension, so no per-call default price exists anymore.
      expect(DEFAULT_API_OVERAGE_RATE_MICROS).toBe(0n);
      expect(DEFAULT_WALLET_OVERAGE_RATE_MICROS).toBe(10_000n);
    });

    it('cannot produce an API-overage charge from a nonzero legacy rate', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.starter, // 100K included API calls
        grossOutboundMicros: 0n,
        apiCallsTotal: 250_000, // 150K over the allowance
        apiOverageRateMicros: 1_000n, // legacy/persisted $0.001/call rate
      });
      expect(totals.apiOverageMicros).toBe(0n);
      expect(totals.totalMicros).toBe(micros(49)); // base fee only
    });

    it('charges nothing at exactly one over the API allowance (hard limit)', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.free, // 10_000 included API calls
        grossOutboundMicros: 0n,
        apiCallsTotal: 10_001, // exactly 1 over
        apiOverageRateMicros: DEFAULT_API_OVERAGE_RATE_MICROS,
      });
      expect(totals.apiOverageMicros).toBe(0n);
      expect(totals.totalMicros).toBe(0n);
    });

    it('charges nothing at exactly the API allowance', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.free,
        grossOutboundMicros: 0n,
        apiCallsTotal: 10_000,
        apiOverageRateMicros: DEFAULT_API_OVERAGE_RATE_MICROS,
      });
      expect(totals.apiOverageMicros).toBe(0n);
    });

    it('keeps the wallet overage boundary unchanged ($0.01/wallet/month)', () => {
      const oneOver = calculateInvoiceTotals({
        plan: PLANS.free, // 10 included wallets
        grossOutboundMicros: 0n,
        activeWallets: 11, // exactly 1 over
        walletOverageRateMicros: DEFAULT_WALLET_OVERAGE_RATE_MICROS,
      });
      // 1 over-limit wallet * $0.01 = $0.01
      expect(oneOver.walletOverageMicros).toBe(10_000n);

      const atLimit = calculateInvoiceTotals({
        plan: PLANS.free,
        grossOutboundMicros: 0n,
        activeWallets: 10,
        walletOverageRateMicros: DEFAULT_WALLET_OVERAGE_RATE_MICROS,
      });
      expect(atLimit.walletOverageMicros).toBe(0n);
    });

    it('keeps huge API over-limit traffic at an exact BigInt zero (no float, no charge)', () => {
      const totals = calculateInvoiceTotals({
        plan: PLANS.starter, // 100_000 included
        grossOutboundMicros: 0n,
        apiCallsTotal: 1_000_000_000, // ~1e9 over-limit calls
        apiOverageRateMicros: 1_000n, // legacy nonzero rate is still inert
      });
      // Hard quota: over-limit traffic was rejected with 429 and never billed.
      expect(totals.apiOverageMicros).toBe(0n);
      expect(totals.totalMicros).toBe(micros(49));
    });

    it('keeps outbound overage exact at one microdollar past the allowance', () => {
      // Free plan allowance $50K; 1 microdollar over is billed in tier 1 at
      // 100 ppm and rounds half-up to 0 microdollars (exact, no overflow).
      expect(calculateOutboundOverage(micros(50_000) + 1n, micros(50_000))).toBe(0n);
    });
  });

  describe('plan configs', () => {
    it('match the PRICING.md public plan values', () => {
      expect(PLANS.free).toMatchObject({
        monthlyFeeMicros: micros(0),
        includedOutboundMicros: micros(50_000),
        includedWallets: 10,
        includedApiCallsPerMonth: 10_000,
      });
      expect(PLANS.starter).toMatchObject({
        monthlyFeeMicros: micros(49),
        includedOutboundMicros: micros(250_000),
        includedWallets: 100,
        includedApiCallsPerMonth: 100_000,
      });
      expect(PLANS.growth).toMatchObject({
        monthlyFeeMicros: micros(199),
        includedOutboundMicros: micros(1_000_000),
        includedWallets: 1_000,
        includedApiCallsPerMonth: 1_000_000,
      });
      expect(PLANS.scale).toMatchObject({
        monthlyFeeMicros: micros(799),
        includedOutboundMicros: micros(5_000_000),
        includedWallets: 5_000,
        includedApiCallsPerMonth: 5_000_000,
      });
      expect(PLANS.business).toMatchObject({
        monthlyFeeMicros: micros(1_999),
        includedOutboundMicros: micros(25_000_000),
        includedWallets: 25_000,
        includedApiCallsPerMonth: 25_000_000,
      });
      expect(PLANS.enterprise).toMatchObject({
        monthlyFeeMicros: null,
        includedOutboundMicros: null,
        includedWallets: null,
        includedApiCallsPerMonth: null,
      });
    });

    it('define the standard marginal tiers from PRICING.md section 4', () => {
      expect(STANDARD_OUTBOUND_TIERS).toEqual([
        { upperBoundMicros: micros(500_000), ratePpm: 100 },
        { upperBoundMicros: micros(2_000_000), ratePpm: 75 },
        { upperBoundMicros: micros(10_000_000), ratePpm: 50 },
        { upperBoundMicros: micros(50_000_000), ratePpm: 25 },
        { upperBoundMicros: micros(200_000_000), ratePpm: 15 },
        { upperBoundMicros: null, ratePpm: 10 },
      ]);
    });
  });
});

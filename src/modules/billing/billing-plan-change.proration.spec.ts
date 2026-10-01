import {
  calculateUpgradeProrationMicros,
  ceilDiv,
  MICROS_PER_CENT,
} from './billing-plan-change.proration';

describe('billing-plan-change.proration', () => {
  describe('ceilDiv', () => {
    it('ceil-divides positive bigints', () => {
      expect(ceilDiv(10n, 3n)).toBe(4n);
      expect(ceilDiv(9n, 3n)).toBe(3n);
      expect(ceilDiv(1n, 10_000n)).toBe(1n);
      expect(ceilDiv(0n, 10n)).toBe(0n);
    });
  });

  describe('calculateUpgradeProrationMicros', () => {
    const periodStart = new Date('2026-08-01T00:00:00.000Z');
    const periodEnd = new Date('2026-09-01T00:00:00.000Z');

    it('returns null when target fee is not higher', () => {
      expect(
        calculateUpgradeProrationMicros({
          currentMonthlyFeeMicros: 49_000_000n,
          targetMonthlyFeeMicros: 49_000_000n,
          now: new Date('2026-08-15T00:00:00.000Z'),
          periodStart,
          periodEnd,
        }),
      ).toBeNull();
      expect(
        calculateUpgradeProrationMicros({
          currentMonthlyFeeMicros: 49_000_000n,
          targetMonthlyFeeMicros: 0n,
          now: new Date('2026-08-15T00:00:00.000Z'),
          periodStart,
          periodEnd,
        }),
      ).toBeNull();
    });

    it('returns null at period end', () => {
      expect(
        calculateUpgradeProrationMicros({
          currentMonthlyFeeMicros: 0n,
          targetMonthlyFeeMicros: 49_000_000n,
          now: periodEnd,
          periodStart,
          periodEnd,
        }),
      ).toBeNull();
    });

    it('prorates free→starter for half the month and ceil-aligns to cents', () => {
      // Aug has 31 days. Midpoint of remaining from Aug 1 is not used; we pin
      // now to exactly halfway through the month in ms.
      const totalMs = periodEnd.getTime() - periodStart.getTime();
      const now = new Date(periodStart.getTime() + totalMs / 2);
      const result = calculateUpgradeProrationMicros({
        currentMonthlyFeeMicros: 0n,
        targetMonthlyFeeMicros: 49_000_000n,
        now,
        periodStart,
        periodEnd,
      });
      // raw = ceil(49e6 * 0.5) = 24_500_000 already cent-aligned
      expect(result).toBe(24_500_000n);
      expect(result! % MICROS_PER_CENT).toBe(0n);
    });

    it('ceil-aligns non-cent raw micros up to the next Stripe cent', () => {
      // Force a remainder that is not cent-aligned by using a short remaining window.
      const now = new Date(periodEnd.getTime() - 1); // 1 ms remaining
      const result = calculateUpgradeProrationMicros({
        currentMonthlyFeeMicros: 0n,
        targetMonthlyFeeMicros: 49_000_000n,
        now,
        periodStart,
        periodEnd,
      });
      // raw micros = ceil(49e6 * 1 / totalMs) >= 1, then ceil to cents
      expect(result).toBe(MICROS_PER_CENT);
    });

    it('uses fee delta (target - current), not full target fee', () => {
      const totalMs = periodEnd.getTime() - periodStart.getTime();
      const now = new Date(periodStart.getTime() + totalMs / 2);
      const result = calculateUpgradeProrationMicros({
        currentMonthlyFeeMicros: 49_000_000n,
        targetMonthlyFeeMicros: 199_000_000n,
        now,
        periodStart,
        periodEnd,
      });
      // delta = 150_000_000; half = 75_000_000
      expect(result).toBe(75_000_000n);
    });
  });
});

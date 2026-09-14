import {
  compareLineMultisets,
  lineMultisetKey,
  normalizeLineForMultiset,
} from './billing-fixture-line-multiset';
import { buildInvoiceLineSpecs, planVersionToConfig, validatePlanVersion } from './billing.service';
import { calculateInvoiceTotals, PLANS } from './billing-calculator';

describe('billing-fixture-line-multiset', () => {
  /** At least two distinct legal lines: monthly fee + wallet overage. */
  function twoLineExpected() {
    const plan = {
      ...PLANS.starter,
      // Force wallet overage: include 0 wallets so 2 active → overage line.
      includedWallets: 0,
    };
    const totals = calculateInvoiceTotals({
      plan,
      grossOutboundMicros: 0n,
      activeWallets: 2,
      apiCallsTotal: 0,
      walletOverageRateMicros: 10_000n,
    });
    expect(totals.walletOverageMicros).toBeGreaterThan(0n);
    const lines = buildInvoiceLineSpecs({
      planVersionName: plan.name,
      plan,
      apiCalls: 0,
      activeWallets: 2,
      totals,
      apiOverageRateMicros: 0n,
      walletOverageRateMicros: 10_000n,
    });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.lineType === 'monthly_fee')).toBe(true);
    expect(lines.some((l) => l.lineType === 'wallet_overage')).toBe(true);
    return lines;
  }

  it('passes when actual is a reverse of expected (order differs, multiset equal)', () => {
    const expected = twoLineExpected();
    const reversed = [...expected].reverse();
    // Prove order actually differs
    expect(reversed.map((l) => l.lineType).join(',')).not.toBe(
      expected.map((l) => l.lineType).join(','),
    );
    expect(compareLineMultisets(reversed as any, expected)).toEqual({ ok: true });
  });

  it('does not collide when lineType/description contain JSON metacharacters', () => {
    const a = normalizeLineForMultiset({
      lineType: 'fee","hack',
      description: 'desc\\x',
      quantity: 1n,
      amountMicros: 1n,
    });
    const b = normalizeLineForMultiset({
      lineType: 'fee',
      description: '","hackdesc\\x',
      quantity: 1n,
      amountMicros: 1n,
    });
    expect(lineMultisetKey(a)).not.toBe(lineMultisetKey(b));
    expect(compareLineMultisets([{ ...a }] as any, [{ ...b } as any]).ok).toBe(false);
  });

  it('rejects amount / type / description / quantity / rate / unitAmount drift', () => {
    const expected = twoLineExpected();
    const base = expected.map((l) => ({ ...l }));

    const amountDrift = base.map((l, i) =>
      i === 0 ? { ...l, amountMicros: l.amountMicros + 1n } : l,
    );
    expect(compareLineMultisets(amountDrift as any, expected).ok).toBe(false);

    const typeDrift = base.map((l, i) => (i === 0 ? { ...l, lineType: 'hacked_fee' } : l));
    expect(compareLineMultisets(typeDrift as any, expected).ok).toBe(false);

    const descDrift = base.map((l, i) => (i === 0 ? { ...l, description: 'nope' } : l));
    expect(compareLineMultisets(descDrift as any, expected).ok).toBe(false);

    const qtyDrift = base.map((l, i) => (i === 0 ? { ...l, quantity: l.quantity + 1n } : l));
    expect(compareLineMultisets(qtyDrift as any, expected).ok).toBe(false);

    const rateDrift = base.map((l, i) =>
      i === 0 ? { ...l, unitRatePpm: (l.unitRatePpm ?? 0) + 1 } : l,
    );
    expect(compareLineMultisets(rateDrift as any, expected).ok).toBe(false);

    const unitDrift = base.map((l, i) =>
      i === 0 ? { ...l, unitAmountMicros: (l.unitAmountMicros ?? 0n) + 1n } : l,
    );
    expect(compareLineMultisets(unitDrift as any, expected).ok).toBe(false);
  });

  it('rejects metadata on actual lines', () => {
    const expected = twoLineExpected();
    const actual = expected.map((l) => ({ ...l, metadata: { x: 1 } }));
    expect(compareLineMultisets(actual as any, expected)).toEqual({
      ok: false,
      reason: 'normalize',
    });
  });

  it('rejects extra and missing lines (including duplicate substitution)', () => {
    const expected = twoLineExpected();
    const extra = [
      ...expected,
      {
        lineType: 'api_overage',
        description: 'API call overage',
        quantity: 1n,
        unitRatePpm: null,
        unitAmountMicros: 1n,
        amountMicros: 1n,
      },
    ];
    expect(compareLineMultisets(extra as any, expected).ok).toBe(false);

    const missing = expected.slice(0, 1);
    expect(compareLineMultisets(missing as any, expected).ok).toBe(false);

    // Duplicate one line twice, drop the other — count preserved wrongly
    const dup = [expected[0], expected[0]];
    expect(compareLineMultisets(dup as any, expected).ok).toBe(false);
  });

  it('normalize treats undefined unit fields as null', () => {
    const n = normalizeLineForMultiset({
      lineType: 'monthly_fee',
      description: 'Monthly fee — Starter',
      quantity: 1n,
      amountMicros: 49_000_000n,
    });
    expect(n.unitRatePpm).toBeNull();
    expect(n.unitAmountMicros).toBeNull();
  });
});

describe('planVersionToConfig uses pinned DB terms for overage lines', () => {
  it('builds wallet overage from drifted DB wallet quota not static PLANS', () => {
    const staticIncluded = PLANS.starter.includedWallets!;
    const row = {
      id: 'pv-drift-w',
      code: 'starter',
      version: 99,
      name: 'Starter',
      monthlyFeeMicros: PLANS.starter.monthlyFeeMicros,
      includedOutboundMicros: PLANS.starter.includedOutboundMicros,
      includedApiCalls: BigInt(PLANS.starter.includedApiCallsPerMonth!),
      // Drift: zero included wallets vs static starter (100)
      includedWallets: 0,
      apiOverageRateMicros: 0n,
      walletOverageRateMicros: 10_000n,
      description: null,
      includedTeamMembers: null,
      effectiveFrom: new Date(),
      createdAt: new Date(),
    };
    expect(staticIncluded).toBeGreaterThan(0);
    validatePlanVersion(row as any);
    const cfg = planVersionToConfig(row as any);
    expect(cfg.includedWallets).toBe(0);

    const totals = calculateInvoiceTotals({
      plan: cfg,
      grossOutboundMicros: 0n,
      activeWallets: 3,
      apiCallsTotal: 0,
      walletOverageRateMicros: 10_000n,
    });
    expect(totals.walletOverageMicros).toBe(30_000n);

    const lines = buildInvoiceLineSpecs({
      planVersionName: 'Starter',
      plan: cfg,
      apiCalls: 0,
      activeWallets: 3,
      totals,
      apiOverageRateMicros: 0n,
      walletOverageRateMicros: 10_000n,
    });
    const walletLine = lines.find((l) => l.lineType === 'wallet_overage');
    expect(walletLine).toBeDefined();
    expect(walletLine!.quantity).toBe(3n);
    expect(walletLine!.amountMicros).toBe(30_000n);
  });
});

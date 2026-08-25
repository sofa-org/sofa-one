import { SUPPORTED_CHAINS } from '../../common/chains/supported-chains';
import {
  PRICING_POLICY_EFFECTIVE_FROM,
  PRICING_POLICY_VERSION,
  TOKEN_PRICES,
  evaluatePricing,
  type PricingRequest,
  type TokenPriceEntry,
} from './billing-pricing';

const baseUsdc = SUPPORTED_CHAINS[8453].usdcAddress as string;
const ethUsdc = SUPPORTED_CHAINS[1].usdcAddress as string;
const ethUsdt = SUPPORTED_CHAINS[1].usdtAddress as string;
const arbitrumUsdt = SUPPORTED_CHAINS[42161].usdtAddress as string;

const OBSERVED_AT = '2026-08-10T00:00:00.000Z';

function evaluate(request: PricingRequest) {
  return evaluatePricing(request);
}

function pricedRequest(overrides: Partial<PricingRequest> = {}): PricingRequest {
  return {
    chainId: 8453,
    tokenAddress: baseUsdc,
    amountBaseUnits: 1_000_000n,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe('billing-pricing', () => {
  describe('USDC/USDT fixed $1 USD peg', () => {
    it('prices 1 USDC on Base as $1.00', () => {
      const result = evaluate(pricedRequest({ amountBaseUnits: 1_000_000n }));

      expect(result.status).toBe('priced');
      if (result.status !== 'priced') return;
      expect(result.assetSymbol).toBe('USDC');
      expect(result.tokenAddress).toBe(baseUsdc);
      expect(result.tokenDecimals).toBe(6);
      expect(result.priceUsdMicros).toBe('1000000');
      expect(result.amountUsdMicros).toBe('1000000');
      expect(result.needsReview).toBe(false);
    });

    it('prices fractional USDC exactly in microdollars', () => {
      const result = evaluate(pricedRequest({ amountBaseUnits: 123_456_789n }));
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.amountUsdMicros).toBe('123456789'); // $123.456789
    });

    it('prices down to a single base unit as 1 microdollar', () => {
      const result = evaluate(pricedRequest({ amountBaseUnits: 1n }));
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.amountUsdMicros).toBe('1'); // $0.000001
    });

    it('prices 5 USDT on Ethereum', () => {
      const result = evaluate(
        pricedRequest({ chainId: 1, tokenAddress: ethUsdt, amountBaseUnits: 5_000_000n }),
      );
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.assetSymbol).toBe('USDT');
      expect(result.amountUsdMicros).toBe('5000000'); // $5.00
    });

    it('prices USDT on Arbitrum using its distinct address', () => {
      const result = evaluate(
        pricedRequest({ chainId: 42161, tokenAddress: arbitrumUsdt, amountBaseUnits: 1n }),
      );
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.assetSymbol).toBe('USDT');
      expect(result.tokenAddress).toBe(arbitrumUsdt);
    });

    it('rounds half-up when the conversion is not exact', () => {
      // Inject a $0.000003-per-unit price (3 micros) to exercise rounding:
      // 500_000 base units * 3 = 1_500_000 micros / 10^6 = 1.5 -> 2
      const oddPrices = TOKEN_PRICES.map((p) =>
        p.chainId === 8453 && p.asset === 'USDC' ? { ...p, priceUsdMicros: 3n } : p,
      );
      const up = evaluatePricing(pricedRequest({ amountBaseUnits: 500_000n }), oddPrices);
      if (up.status !== 'priced') throw new Error('expected priced');
      expect(up.amountUsdMicros).toBe('2');

      // 499_999 * 3 = 1_499_997 micros / 10^6 = 1.499997 -> 1
      const down = evaluatePricing(pricedRequest({ amountBaseUnits: 499_999n }), oddPrices);
      if (down.status !== 'priced') throw new Error('expected priced');
      expect(down.amountUsdMicros).toBe('1');
    });
  });

  describe('case-insensitive address matching', () => {
    it('matches an all-uppercase USDC address', () => {
      const result = evaluate(pricedRequest({ tokenAddress: baseUsdc.toUpperCase() }));
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.assetSymbol).toBe('USDC');
      // canonical config casing is preserved in the result
      expect(result.tokenAddress).toBe(baseUsdc);
      expect(result.amountUsdMicros).toBe('1000000');
    });

    it('matches a mixed-case USDC address', () => {
      const mixed = baseUsdc.replace(/[a-fA-F0-9]{4}(?=.{4}$)/, (m) =>
        m.toUpperCase() === m ? m.toLowerCase() : m.toUpperCase(),
      );
      const result = evaluate(pricedRequest({ tokenAddress: mixed }));
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.assetSymbol).toBe('USDC');
      expect(result.amountUsdMicros).toBe('1000000');
    });

    it('matches an all-uppercase USDT address on Ethereum', () => {
      const result = evaluate(pricedRequest({ chainId: 1, tokenAddress: ethUsdt.toUpperCase() }));
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.assetSymbol).toBe('USDT');
    });
  });

  describe('chain scoping (never guesses by symbol)', () => {
    it('quarantines a valid USDC address used on the wrong chain', () => {
      const result = evaluate(pricedRequest({ chainId: 1, tokenAddress: baseUsdc }));
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('unknown_token');
      expect(result.needsReview).toBe(true);
    });

    it('quarantines a USDT address used on a chain that does not carry it', () => {
      const result = evaluate(pricedRequest({ chainId: 8453, tokenAddress: ethUsdt }));
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('unknown_token');
    });

    it('quarantines any valid address on a chain with no stablecoin config (Monad)', () => {
      const result = evaluate(
        pricedRequest({
          chainId: 143,
          tokenAddress: '0x1111111111111111111111111111111111111111',
        }),
      );
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('unknown_token');
    });
  });

  describe('quarantined results (never fabricate zero)', () => {
    it('quarantines unsupported chains', () => {
      const result = evaluate(pricedRequest({ chainId: 999_999 }));
      expect(result).toMatchObject({
        status: 'quarantined',
        needsReview: true,
        reason: 'unsupported_chain',
        chainId: 999_999,
      });
      if (result.status === 'priced') throw new Error('expected quarantined');
      expect(result.tokenAddress).toBe(baseUsdc);
      expect(result).not.toHaveProperty('amountUsdMicros');
    });

    it('quarantines native assets (no token address)', () => {
      for (const tokenAddress of [undefined, null]) {
        const result = evaluate(pricedRequest({ tokenAddress }));
        expect(result.status).toBe('quarantined');
        if (result.status !== 'quarantined') return;
        expect(result.reason).toBe('native_asset');
        expect(result.assetSymbol).toBeNull();
      }
    });

    it('quarantines unknown tokens', () => {
      const result = evaluate(
        pricedRequest({ tokenAddress: '0x2222222222222222222222222222222222222222' }),
      );
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('unknown_token');
      expect(result.assetSymbol).toBeNull();
    });

    it('quarantines missing prices when the price table lacks an entry', () => {
      const withoutEthUsdt = TOKEN_PRICES.filter((p) => !(p.chainId === 1 && p.asset === 'USDT'));
      const result = evaluatePricing(
        pricedRequest({ chainId: 1, tokenAddress: ethUsdt }),
        withoutEthUsdt,
      );
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('missing_price');
      expect(result.assetSymbol).toBe('USDT');
    });

    it('quarantines stale prices observed before the policy effective date', () => {
      const result = evaluate(pricedRequest({ observedAt: '2020-01-01T00:00:00.000Z' }));
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('stale_price');
      expect(result.details?.validFrom).toBe(PRICING_POLICY_EFFECTIVE_FROM);
    });

    it('quarantines decimal mismatches between the receipt and the canonical token', () => {
      const result = evaluate(pricedRequest({ tokenDecimals: 18 }));
      expect(result.status).toBe('quarantined');
      if (result.status !== 'quarantined') return;
      expect(result.reason).toBe('decimals_mismatch');
      expect(result.assetSymbol).toBe('USDC');
      expect(result.details).toEqual({ expectedDecimals: 6, observedDecimals: 18 });
    });

    it('accepts matching tokenDecimals and rejects none', () => {
      const withDecimals = evaluate(pricedRequest({ tokenDecimals: 6 }));
      expect(withDecimals.status).toBe('priced');
      const withoutDecimals = evaluate(pricedRequest({ tokenDecimals: null }));
      expect(withoutDecimals.status).toBe('priced');
    });

    it('keeps quarantine reasons distinct from priced results', () => {
      const priced = evaluate(pricedRequest());
      const quarantined = evaluate(pricedRequest({ tokenAddress: ethUsdc, chainId: 8453 }));
      expect(priced.status).toBe('priced');
      expect(quarantined.status).toBe('quarantined');
      if (quarantined.status !== 'quarantined') return;
      expect(quarantined.reason).not.toBe('unsupported_chain');
    });
  });

  describe('input validation (typed errors, never silent)', () => {
    it.each([
      [-1n, 'negative_amount'],
      [-1_000_000_000_000_000_000_000n, 'negative_amount'],
    ] as const)('rejects negative amount %s', (amount, code) => {
      expect(() => evaluate(pricedRequest({ amountBaseUnits: amount }))).toThrow(
        expect.objectContaining({ name: 'PricingInputError', code }),
      );
    });

    it('rejects non-bigint amounts', () => {
      expect(() => evaluate(pricedRequest({ amountBaseUnits: 123 as unknown as bigint }))).toThrow(
        expect.objectContaining({ code: 'amount_not_bigint' }),
      );
    });

    it('rejects invalid chain ids', () => {
      for (const chainId of [0, -1, 1.5, NaN, 2 ** 53]) {
        expect(() => evaluate(pricedRequest({ chainId }))).toThrow(
          expect.objectContaining({ name: 'PricingInputError', code: 'invalid_chain_id' }),
        );
      }
    });

    it('rejects empty and malformed token addresses', () => {
      for (const tokenAddress of [
        '',
        '0x123',
        '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        'abc',
      ]) {
        expect(() => evaluate(pricedRequest({ tokenAddress }))).toThrow(
          expect.objectContaining({ name: 'PricingInputError', code: 'invalid_token_address' }),
        );
      }
    });

    it('rejects unsafe token decimals', () => {
      for (const tokenDecimals of [-1, 1.5, NaN, 2 ** 53]) {
        expect(() => evaluate(pricedRequest({ tokenDecimals }))).toThrow(
          expect.objectContaining({ name: 'PricingInputError', code: 'invalid_token_decimals' }),
        );
      }
    });

    it('rejects unparseable observedAt values', () => {
      for (const observedAt of ['not-a-date', '', NaN, new Date('nope')]) {
        expect(() => evaluate(pricedRequest({ observedAt }))).toThrow(
          expect.objectContaining({ name: 'PricingInputError', code: 'invalid_observed_at' }),
        );
      }
    });
  });

  describe('large bigint safety (no overflow, no floats)', () => {
    it('handles amounts far beyond the Number safe range exactly', () => {
      const amount = 10n ** 30n;
      const result = evaluate(pricedRequest({ amountBaseUnits: amount }));
      if (result.status !== 'priced') throw new Error('expected priced');
      // 10^30 * 10^6 / 10^6 = 10^30 microdollars
      expect(result.amountUsdMicros).toBe((10n ** 30n).toString());
      expect(result.amountUsdMicros).toBe('1000000000000000000000000000000');
    });

    it('handles 2^256 base units without precision loss', () => {
      const amount = 2n ** 256n;
      const result = evaluate(pricedRequest({ amountBaseUnits: amount }));
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.amountUsdMicros).toBe(amount.toString());
    });
  });

  describe('policy version and auditable price metadata', () => {
    it('exposes policy version, price source, and canonical address on priced results', () => {
      const result = evaluate(pricedRequest());
      if (result.status !== 'priced') throw new Error('expected priced');
      expect(result.policyVersion).toBe(PRICING_POLICY_VERSION);
      expect(result.priceSource).toBe('static_usd_peg');
      expect(result.priceUsdMicros).toBe('1000000');
    });

    it('derives every price-table entry from the supported-chains config', () => {
      expect(TOKEN_PRICES.length).toBeGreaterThan(0);
      for (const entry of TOKEN_PRICES) {
        const chain = SUPPORTED_CHAINS[entry.chainId];
        const configAddress = entry.asset === 'USDC' ? chain.usdcAddress : chain.usdtAddress;
        expect(configAddress?.toLowerCase()).toBe(entry.tokenAddress.toLowerCase());
        expect(entry.decimals).toBe(6);
        expect(entry.priceSource).toBe('static_usd_peg');
        expect(entry.policyVersion).toBe(PRICING_POLICY_VERSION);
        expect(entry.validUntil).toBeNull();
      }
    });

    it('carries one entry per configured USDC/USDT address', () => {
      const configured = Object.values(SUPPORTED_CHAINS).reduce(
        (count, chain) => count + (chain.usdcAddress ? 1 : 0) + (chain.usdtAddress ? 1 : 0),
        0,
      );
      expect(TOKEN_PRICES).toHaveLength(configured);
    });
  });

  describe('observedAt forms', () => {
    it('accepts Date, ISO string, and numeric epoch millis', () => {
      const asDate = evaluate(pricedRequest({ observedAt: new Date(OBSERVED_AT) }));
      const asString = evaluate(pricedRequest({ observedAt: OBSERVED_AT }));
      const asNumber = evaluate(pricedRequest({ observedAt: Date.parse(OBSERVED_AT) }));
      for (const result of [asDate, asString, asNumber]) {
        expect(result.status).toBe('priced');
        if (result.status !== 'priced') return;
        expect(result.observedAt).toBe(OBSERVED_AT);
        expect(result.amountUsdMicros).toBe('1000000');
      }
    });

    it('prices observations at the policy effective-from instant (inclusive boundary)', () => {
      const result = evaluate(pricedRequest({ observedAt: PRICING_POLICY_EFFECTIVE_FROM }));
      expect(result.status).toBe('priced');
    });
  });

  describe('JSON-safe results (no BigInt leaks)', () => {
    it('serializes a priced result without throwing', () => {
      const result = evaluate(pricedRequest({ amountBaseUnits: 123_456_789n }));
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      expect(parsed.status).toBe('priced');
      expect(parsed.amountUsdMicros).toBe('123456789');
      expect(parsed.priceUsdMicros).toBe('1000000');
      expect(typeof parsed.amountUsdMicros).toBe('string');
    });

    it('serializes a quarantined result without throwing', () => {
      const result = evaluate(pricedRequest({ chainId: 999_999, tokenAddress: baseUsdc }));
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      expect(parsed.status).toBe('quarantined');
      expect(parsed.reason).toBe('unsupported_chain');
      expect(parsed.needsReview).toBe(true);
    });

    it('serializes a decimals-mismatch quarantine with its details', () => {
      const result = evaluate(pricedRequest({ tokenDecimals: 18 }));
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      expect(parsed.details).toEqual({ expectedDecimals: 6, observedDecimals: 18 });
    });
  });

  describe('price table shape', () => {
    it('exposes a typed TokenPriceEntry with auditable fields', () => {
      const entry: TokenPriceEntry | undefined = TOKEN_PRICES.find(
        (p) => p.chainId === 8453 && p.asset === 'USDC',
      );
      expect(entry).toBeDefined();
      expect(entry?.tokenAddress).toBe(baseUsdc);
      expect(entry?.priceUsdMicros).toBe(1_000_000n);
      expect(entry?.validFrom).toBe(PRICING_POLICY_EFFECTIVE_FROM);
    });
  });
});

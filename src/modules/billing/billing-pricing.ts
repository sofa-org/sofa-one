/**
 * Deterministic pricing boundary for SOFA ONE billing (Phase 1).
 *
 * This module is intentionally pure and dependency-light: given a chain id, an
 * optional token address, an amount in base units, and an observation time, it
 * deterministically converts USDC/USDT transfers to microdollar outbound volume
 * for later receipt reconciliation. It performs no I/O, no RPC, and no price
 * oracle lookups.
 *
 * Phase 1 policy:
 * - Only the USDC/USDT addresses declared in
 *   `src/common/chains/supported-chains.ts` are eligible. Address matching is
 *   case-insensitive and always scoped to the exact `chainId` from the request;
 *   the symbol is never used to guess an address.
 * - USDC and USDT are priced at a fixed $1.00 USD peg
 *   (`priceUsdMicros = 1_000_000`). Both use 6 token decimals on every
 *   supported chain in the current config.
 * - All arithmetic is bigint; no floating point and no implicit Number
 *   conversions. Malformed inputs (negative/non-bigint amounts, empty or
 *   non-hex addresses, unsafe decimals, unparseable observation times) throw a
 *   typed `PricingInputError` — they are never silently coerced.
 * - Business-level unpriced conditions (unsupported chain, native asset,
 *   unknown token, missing/stale price, decimal mismatch) return a structured
 *   `quarantined` result so receipt reconciliation can flag the invoice line
 *   for `needs_review` instead of fabricating a zero.
 *
 * Results are JSON-safe by construction: every bigint-derived amount is
 * serialized as a string, so `JSON.stringify` never throws and never leaks a
 * BigInt.
 */

import { SUPPORTED_CHAINS, type SupportedChain } from '../../common/chains/supported-chains';

/** Version of the pricing policy table and computation below. */
export const PRICING_POLICY_VERSION = 1;

/**
 * ISO instant when the Phase 1 static USD-peg pricing policy takes effect.
 * Receipts observed strictly before this instant have no applicable price and
 * are quarantined as `stale_price`.
 */
export const PRICING_POLICY_EFFECTIVE_FROM = '2026-08-01T00:00:00.000Z';

const MICROS_PER_DOLLAR = 1_000_000n;
const USD_PEG_PRICE_MICROS = MICROS_PER_DOLLAR;
const STABLECOIN_DECIMALS = 6;
const HEX_ADDRESS_REGEX = /^0[xX][a-fA-F0-9]{40}$/;

export type AssetSymbol = 'USDC' | 'USDT';
export type PriceSource = 'static_usd_peg';

export interface TokenPriceEntry {
  readonly chainId: number;
  readonly asset: AssetSymbol;
  /** Canonical (config) token address; matching is case-insensitive. */
  readonly tokenAddress: string;
  readonly decimals: number;
  readonly priceUsdMicros: bigint;
  readonly priceSource: PriceSource;
  readonly policyVersion: number;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface PricingRequest {
  readonly chainId: number;
  /** Omit/null for native asset transfers (e.g. ETH). */
  readonly tokenAddress?: string | null;
  readonly amountBaseUnits: bigint;
  /** Optional receipt-reported token decimals; a mismatch is quarantined. */
  readonly tokenDecimals?: number | null;
  readonly observedAt: Date | string | number;
}

export type QuarantineReason =
  | 'unsupported_chain'
  | 'unknown_token'
  | 'native_asset'
  | 'missing_price'
  | 'stale_price'
  | 'decimals_mismatch';

export interface PricedResult {
  readonly status: 'priced';
  readonly needsReview: false;
  readonly chainId: number;
  readonly assetSymbol: AssetSymbol;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
  readonly amountBaseUnits: string;
  readonly priceUsdMicros: string;
  readonly amountUsdMicros: string;
  readonly priceSource: PriceSource;
  readonly policyVersion: number;
  readonly observedAt: string;
}

export interface QuarantinedResult {
  readonly status: 'quarantined';
  readonly needsReview: true;
  readonly chainId: number;
  readonly tokenAddress: string | null;
  readonly assetSymbol: AssetSymbol | null;
  readonly reason: QuarantineReason;
  readonly details?: Record<string, string | number | boolean | null>;
}

export type PricingResult = PricedResult | QuarantinedResult;

export type PricingInputErrorCode =
  | 'amount_not_bigint'
  | 'negative_amount'
  | 'invalid_chain_id'
  | 'invalid_token_address'
  | 'invalid_token_decimals'
  | 'invalid_observed_at';

/**
 * Thrown for malformed request inputs that cannot be priced or quarantined.
 * The error is typed and must never be silently swallowed by callers.
 */
export class PricingInputError extends Error {
  readonly code: PricingInputErrorCode;

  constructor(code: PricingInputErrorCode, message: string) {
    super(message);
    this.name = 'PricingInputError';
    this.code = code;
  }
}

/**
 * Deterministically values a USDC/USDT transfer against the Phase 1 static USD
 * peg. Returns a `priced` result with JSON-safe string amounts, or a structured
 * `quarantined` result with the reason for the unpriced condition.
 *
 * `prices` is an optional advanced seam for tests/audit; callers normally rely
 * on the exported `TOKEN_PRICES` table derived from the supported-chains config.
 */
export function evaluatePricing(
  request: PricingRequest,
  prices: readonly TokenPriceEntry[] = TOKEN_PRICES,
): PricingResult {
  const chainId = assertChainId(request.chainId);
  const amountBaseUnits = assertAmount(request.amountBaseUnits);
  const observedAt = assertObservedAt(request.observedAt);
  const requestedDecimals =
    request.tokenDecimals == null ? null : assertTokenDecimals(request.tokenDecimals);

  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) {
    return quarantined(chainId, optionalAddress(request.tokenAddress), 'unsupported_chain');
  }

  if (request.tokenAddress == null) {
    return quarantined(chainId, null, 'native_asset');
  }

  const tokenAddress = assertTokenAddress(request.tokenAddress);

  const token = resolveSupportedToken(chain, tokenAddress);
  if (!token) {
    return quarantined(chainId, tokenAddress, 'unknown_token');
  }

  const price = findPrice(prices, chainId, token.asset);
  if (!price || !sameAddress(price.tokenAddress, token.tokenAddress)) {
    return quarantined(chainId, tokenAddress, 'missing_price', { assetSymbol: token.asset });
  }

  const validFromMs = Date.parse(price.validFrom);
  if (!Number.isFinite(validFromMs) || observedAt.getTime() < validFromMs) {
    return quarantined(chainId, tokenAddress, 'stale_price', {
      assetSymbol: token.asset,
      details: { validFrom: price.validFrom },
    });
  }
  if (price.validUntil !== null) {
    const validUntilMs = Date.parse(price.validUntil);
    if (!Number.isFinite(validUntilMs) || observedAt.getTime() > validUntilMs) {
      return quarantined(chainId, tokenAddress, 'stale_price', {
        assetSymbol: token.asset,
        details: { validUntil: price.validUntil },
      });
    }
  }

  if (requestedDecimals !== null && requestedDecimals !== price.decimals) {
    return quarantined(chainId, tokenAddress, 'decimals_mismatch', {
      assetSymbol: token.asset,
      details: { expectedDecimals: price.decimals, observedDecimals: requestedDecimals },
    });
  }

  const scale = 10n ** BigInt(price.decimals);
  const amountUsdMicros = roundHalfUp(amountBaseUnits * price.priceUsdMicros, scale);

  return {
    status: 'priced',
    needsReview: false,
    chainId,
    assetSymbol: token.asset,
    tokenAddress: price.tokenAddress,
    tokenDecimals: price.decimals,
    amountBaseUnits: amountBaseUnits.toString(),
    priceUsdMicros: price.priceUsdMicros.toString(),
    amountUsdMicros: amountUsdMicros.toString(),
    priceSource: price.priceSource,
    policyVersion: price.policyVersion,
    observedAt: observedAt.toISOString(),
  };
}

// ── Price table (derived from the supported-chains config) ───────────────────

function buildTokenPrices(): readonly TokenPriceEntry[] {
  const entries: TokenPriceEntry[] = [];
  for (const chain of Object.values(SUPPORTED_CHAINS)) {
    const candidates: readonly { asset: AssetSymbol; address: `0x${string}` | undefined }[] = [
      { asset: 'USDC', address: chain.usdcAddress },
      { asset: 'USDT', address: chain.usdtAddress },
    ];
    for (const { asset, address } of candidates) {
      if (!address) continue;
      entries.push({
        chainId: chain.chainId,
        asset,
        tokenAddress: address,
        decimals: STABLECOIN_DECIMALS,
        priceUsdMicros: USD_PEG_PRICE_MICROS,
        priceSource: 'static_usd_peg',
        policyVersion: PRICING_POLICY_VERSION,
        validFrom: PRICING_POLICY_EFFECTIVE_FROM,
        validUntil: null,
      });
    }
  }
  return entries;
}

export const TOKEN_PRICES: readonly TokenPriceEntry[] = buildTokenPrices();

// ── Resolvers ────────────────────────────────────────────────────────────────

function resolveSupportedToken(
  chain: SupportedChain,
  address: string,
): { asset: AssetSymbol; tokenAddress: string } | null {
  const normalized = address.toLowerCase();
  if (chain.usdcAddress && chain.usdcAddress.toLowerCase() === normalized) {
    return { asset: 'USDC', tokenAddress: chain.usdcAddress };
  }
  if (chain.usdtAddress && chain.usdtAddress.toLowerCase() === normalized) {
    return { asset: 'USDT', tokenAddress: chain.usdtAddress };
  }
  return null;
}

function findPrice(
  prices: readonly TokenPriceEntry[],
  chainId: number,
  asset: AssetSymbol,
): TokenPriceEntry | null {
  return prices.find((p) => p.chainId === chainId && p.asset === asset) ?? null;
}

// ── Input validation (thrown, never silently coerced) ────────────────────────

function assertChainId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PricingInputError(
      'invalid_chain_id',
      `chainId must be a positive safe integer, got ${String(value)}`,
    );
  }
  return value;
}

function assertAmount(value: bigint): bigint {
  if (typeof value !== 'bigint') {
    throw new PricingInputError('amount_not_bigint', 'amountBaseUnits must be a bigint');
  }
  if (value < 0n) {
    throw new PricingInputError(
      'negative_amount',
      `amountBaseUnits must not be negative, got ${value.toString()}`,
    );
  }
  return value;
}

function assertTokenAddress(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !HEX_ADDRESS_REGEX.test(value)) {
    throw new PricingInputError(
      'invalid_token_address',
      `tokenAddress must be a non-empty 0x-prefixed 40-hex address, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertTokenDecimals(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingInputError(
      'invalid_token_decimals',
      `tokenDecimals must be a non-negative safe integer, got ${String(value)}`,
    );
  }
  return value;
}

function assertObservedAt(value: Date | string | number): Date {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PricingInputError('invalid_observed_at', `observedAt must be finite, got ${value}`);
    }
    date = new Date(value);
  } else if (typeof value === 'string') {
    if (value.trim() === '') {
      throw new PricingInputError('invalid_observed_at', 'observedAt must not be an empty string');
    }
    date = new Date(value);
  } else {
    throw new PricingInputError(
      'invalid_observed_at',
      `observedAt must be a Date, number, or ISO string, got ${typeof value}`,
    );
  }
  if (Number.isNaN(date.getTime())) {
    throw new PricingInputError(
      'invalid_observed_at',
      `observedAt could not be parsed, got ${String(value)}`,
    );
  }
  return date;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function optionalAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      'roundHalfUp requires a non-negative numerator and a positive denominator',
    );
  }
  return (numerator * 2n + denominator) / (2n * denominator);
}

function quarantined(
  chainId: number,
  tokenAddress: string | null,
  reason: QuarantineReason,
  extra: {
    assetSymbol?: AssetSymbol | null;
    details?: Record<string, string | number | boolean | null>;
  } = {},
): QuarantinedResult {
  return {
    status: 'quarantined',
    needsReview: true,
    chainId,
    tokenAddress,
    assetSymbol: extra.assetSymbol ?? null,
    reason,
    ...(extra.details ? { details: extra.details } : {}),
  };
}

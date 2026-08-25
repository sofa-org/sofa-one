import { BadRequestException } from '@nestjs/common';
import { MICROS_PER_DOLLAR } from './billing-calculator';

/**
 * Pure billing helpers: period parsing, microdollar -> decimal USD formatting,
 * ppm -> percentage string formatting, and safe number conversion.
 *
 * All monetary amounts are bigints denominated in microdollars
 * (1 USD = 1_000_000 microdollars). Formatting never uses floating point.
 */

const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Current UTC month as `YYYY-MM`. */
export function currentUtcMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Format a Date's UTC month as `YYYY-MM`. */
export function formatUtcMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface ParsedPeriod {
  /** Normalized `YYYY-MM` string. */
  period: string;
  /** Inclusive UTC start of the month. */
  start: Date;
  /** Exclusive UTC end of the month (first instant of the following month). */
  end: Date;
}

/**
 * Parses and validates a `YYYY-MM` period. Defaults to the current UTC month.
 * Throws BadRequestException for malformed periods.
 */
export function parsePeriod(period?: string): ParsedPeriod {
  const value = period ?? currentUtcMonth();
  if (!PERIOD_REGEX.test(value)) {
    throw new BadRequestException('period must be in YYYY-MM format');
  }
  const [yearStr, monthStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { period: value, start, end };
}

/**
 * Converts a microdollar bigint to a decimal USD string with up to 6 decimal
 * places, truncating trailing zeros. Never uses floating point.
 *
 * Examples: 1_000_000n -> "1", 1_234_500n -> "1.2345", 0n -> "0".
 */
export function microsToDecimalUsd(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_PER_DOLLAR;
  const frac = abs % MICROS_PER_DOLLAR;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  const result = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${result}` : result;
}

/**
 * Converts a ppm rate to a percentage string with 4 decimal places.
 * 100 ppm -> "0.0100%", 75 ppm -> "0.0075%".
 */
export function ppmToPercentString(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 0) {
    throw new RangeError('ppm must be a non-negative integer');
  }
  return `${(ppm / 10_000).toFixed(4)}%`;
}

/** Converts an unknown value to a finite number, throwing on NaN/Infinity. */
export function safeNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new RangeError('value must be a finite number');
  }
  return n;
}

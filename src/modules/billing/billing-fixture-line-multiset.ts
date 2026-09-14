/**
 * Order-independent multiset comparison for invoice lines (fixture integrity).
 * Pure helpers — no I/O.
 */

export type LineComparable = {
  lineType: string;
  description: string;
  quantity: bigint;
  unitRatePpm: number | null;
  unitAmountMicros: bigint | null;
  amountMicros: bigint;
  /** Must be null for fixture lines (absent counts as null after normalize). */
  metadata: null;
};

export function normalizeLineForMultiset(line: {
  lineType: unknown;
  description: unknown;
  quantity: unknown;
  unitRatePpm?: unknown;
  unitAmountMicros?: unknown;
  amountMicros: unknown;
  metadata?: unknown;
}): LineComparable {
  if (typeof line.lineType !== 'string' || !line.lineType) {
    throw new Error('line_type');
  }
  if (typeof line.description !== 'string') throw new Error('line_description');
  if (typeof line.quantity !== 'bigint') throw new Error('line_quantity');
  if (typeof line.amountMicros !== 'bigint') throw new Error('line_amount');
  const unitRatePpm =
    line.unitRatePpm === undefined || line.unitRatePpm === null
      ? null
      : typeof line.unitRatePpm === 'number'
        ? line.unitRatePpm
        : (() => {
            throw new Error('line_unit_rate');
          })();
  const unitAmountMicros =
    line.unitAmountMicros === undefined || line.unitAmountMicros === null
      ? null
      : typeof line.unitAmountMicros === 'bigint'
        ? line.unitAmountMicros
        : (() => {
            throw new Error('line_unit_amount');
          })();
  if (line.metadata !== null && line.metadata !== undefined) {
    throw new Error('line_metadata');
  }
  return {
    lineType: line.lineType,
    description: line.description,
    quantity: line.quantity,
    unitRatePpm,
    unitAmountMicros,
    amountMicros: line.amountMicros,
    metadata: null,
  };
}

/**
 * Unambiguous multiset key via JSON array of already-normalized scalar fields.
 * Avoids delimiter collision (e.g. lineType/description containing separators).
 */
export function lineMultisetKey(line: LineComparable): string {
  return JSON.stringify([
    line.lineType,
    line.description,
    line.quantity.toString(),
    line.unitRatePpm,
    line.unitAmountMicros === null ? null : line.unitAmountMicros.toString(),
    line.amountMicros.toString(),
    null, // metadata sentinel
  ]);
}

export type MultisetCompareResult =
  | { ok: true }
  | { ok: false; reason: 'count' | 'missing' | 'extra' | 'normalize' };

/**
 * Compare actual vs expected lines as multisets (duplicate counts matter;
 * order does not).
 */
export function compareLineMultisets(
  actualRaw: Array<Record<string, unknown>>,
  expected: Array<{
    lineType: string;
    description: string;
    quantity: bigint;
    unitRatePpm: number | null;
    unitAmountMicros: bigint | null;
    amountMicros: bigint;
  }>,
): MultisetCompareResult {
  if (actualRaw.length !== expected.length) return { ok: false, reason: 'count' };

  const actualCounts = new Map<string, number>();
  try {
    for (const raw of actualRaw) {
      const n = normalizeLineForMultiset(raw as any);
      const k = lineMultisetKey(n);
      actualCounts.set(k, (actualCounts.get(k) ?? 0) + 1);
    }
  } catch {
    return { ok: false, reason: 'normalize' };
  }

  const expectedCounts = new Map<string, number>();
  for (const e of expected) {
    const n: LineComparable = {
      lineType: e.lineType,
      description: e.description,
      quantity: e.quantity,
      unitRatePpm: e.unitRatePpm,
      unitAmountMicros: e.unitAmountMicros,
      amountMicros: e.amountMicros,
      metadata: null,
    };
    const k = lineMultisetKey(n);
    expectedCounts.set(k, (expectedCounts.get(k) ?? 0) + 1);
  }

  for (const [k, c] of expectedCounts) {
    if ((actualCounts.get(k) ?? 0) !== c) return { ok: false, reason: 'missing' };
  }
  for (const [k, c] of actualCounts) {
    if ((expectedCounts.get(k) ?? 0) !== c) return { ok: false, reason: 'extra' };
  }
  return { ok: true };
}

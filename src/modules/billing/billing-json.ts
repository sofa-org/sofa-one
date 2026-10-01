/** Stable JSON representation for hashes stored alongside JSONB snapshots. */
export function canonicalBillingJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Billing snapshot contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalBillingJson).join(',')}]`;
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Billing snapshot contains an unsupported object');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalBillingJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Billing snapshot contains an unsupported value');
}

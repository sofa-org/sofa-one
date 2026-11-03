export type CapabilityMode = 'all' | 'custom';

/** Narrow contexts without a persisted mode are legacy/test records, never implicit all. */
export function normalizeCapabilityMode(mode: unknown): CapabilityMode {
  return mode === 'all' || mode === 'custom' ? mode : 'custom';
}

export function hasCapability(mode: unknown, ids: readonly string[] | null | undefined, capabilityId: string): boolean {
  if (mode === undefined) return Array.isArray(ids) && ids.includes(capabilityId);
  if (mode === 'all') return Array.isArray(ids) && ids.length === 0;
  return mode === 'custom' && Array.isArray(ids) && ids.includes(capabilityId);
}

export function assertCapabilityConfiguration(mode: unknown, ids: unknown): asserts mode is CapabilityMode {
  if (mode !== 'all' && mode !== 'custom') throw new TypeError('Invalid capability mode');
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new TypeError('Invalid capability IDs');
  if (mode === 'all' && ids.length !== 0) throw new TypeError('All capability mode requires an empty capability ID list');
}

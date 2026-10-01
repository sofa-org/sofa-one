import { canonicalBillingJson } from './billing-json';

describe('canonicalBillingJson', () => {
  it('sorts keys recursively and preserves array order', () => {
    expect(canonicalBillingJson({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}',
    );
  });

  it('is stable for JSONB key reordering', () => {
    const first = canonicalBillingJson({ plan: { fee: 49, id: 'p1' }, renewal: true });
    const roundTripped = canonicalBillingJson(JSON.parse('{"renewal":true,"plan":{"id":"p1","fee":49}}'));
    expect(first).toBe(roundTripped);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite number %s', (value) => {
    expect(() => canonicalBillingJson({ value })).toThrow(TypeError);
  });

  it('rejects unsupported values instead of hashing an ambiguous representation', () => {
    expect(() => canonicalBillingJson({ value: 1n })).toThrow(TypeError);
    expect(() => canonicalBillingJson({ value: new Date('2026-01-01T00:00:00.000Z') })).toThrow(TypeError);
  });
});

import { hashRequest } from './request-hash';

describe('hashRequest', () => {
  it('returns a 64-character hex string', () => {
    const hash = hashRequest({ to: '0xabc', value: '0' });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same hash for identical objects', () => {
    const a = hashRequest({ to: '0xabc', value: '0' });
    const b = hashRequest({ to: '0xabc', value: '0' });
    expect(a).toBe(b);
  });

  it('produces different hashes for different values', () => {
    const a = hashRequest({ to: '0xabc', value: '0' });
    const b = hashRequest({ to: '0xabc', value: '1' });
    expect(a).not.toBe(b);
  });

  it('is key-order independent', () => {
    const a = hashRequest({ to: '0xabc', value: '0' });
    const b = hashRequest({ value: '0', to: '0xabc' });
    expect(a).toBe(b);
  });

  it('handles nested objects with consistent key ordering', () => {
    const a = hashRequest({ outer: { z: 1, a: 2 } });
    const b = hashRequest({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('handles arrays in order (array order matters)', () => {
    const a = hashRequest([1, 2, 3]);
    const b = hashRequest([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it('handles null and primitive values', () => {
    expect(hashRequest(null)).toBeTruthy();
    expect(hashRequest(42)).toBeTruthy();
    expect(hashRequest('hello')).toBeTruthy();
  });

  it('produces different hashes for null vs undefined vs zero', () => {
    const a = hashRequest(null);
    const b = hashRequest(undefined);
    const c = hashRequest(0);
    const values = new Set([a, b, c]);
    expect(values.size).toBe(3);
  });
});

import { parseTrustProxy } from './main';

describe('parseTrustProxy', () => {
  it('returns false for missing/blank value outside production', () => {
    expect(parseTrustProxy(undefined, 'test')).toBe(false);
    expect(parseTrustProxy('   ', 'development')).toBe(false);
  });

  it('throws for missing/blank value in production', () => {
    expect(() => parseTrustProxy(undefined, 'production')).toThrow(
      'TRUST_PROXY must be set in production to trusted proxy IP/CIDR values',
    );
    expect(() => parseTrustProxy(' ', 'production')).toThrow(
      'TRUST_PROXY must be set in production to trusted proxy IP/CIDR values',
    );
  });

  it.each(['false', '0', 'off'])('returns false for %s', (value) => {
    expect(parseTrustProxy(value, 'production')).toBe(false);
  });

  it.each(['true', '1'])('throws for %s', (value) => {
    expect(() => parseTrustProxy(value, 'production')).toThrow(
      'TRUST_PROXY must name trusted proxy IP/CIDR values, not a boolean or hop count',
    );
  });

  it('trims comma-separated entries and removes empties', () => {
    expect(parseTrustProxy(' 10.0.0.1 , , 192.168.0.0/16 ,', 'production')).toEqual([
      '10.0.0.1',
      '192.168.0.0/16',
    ]);
  });
});

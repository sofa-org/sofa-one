import { describe, expect, it } from 'vitest';

import { SUPPORTED_PROTOCOLS } from './supported-protocols';

describe('supported protocol directory', () => {
  it('keeps canonical names unique and all directory links HTTPS', () => {
    const names = SUPPORTED_PROTOCOLS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(SUPPORTED_PROTOCOLS.every(({ website }) => website.startsWith('https://'))).toBe(true);
  });
});

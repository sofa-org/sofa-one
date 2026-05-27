import { sanitizeErrorMessage, getErrorText } from './sanitize';

describe('sanitizeErrorMessage', () => {
  it('strips long hex values', () => {
    const msg =
      'Transaction reverted at 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    expect(sanitizeErrorMessage(msg)).toBe(
      'Transaction reverted at [hex]',
    );
  });

  it('preserves short hex values (less than 16 hex chars)', () => {
    const msg = 'Chain ID 0x1 is not supported';
    expect(sanitizeErrorMessage(msg)).toBe('Chain ID 0x1 is not supported');
  });

  it('strips internal URLs', () => {
    const msg = 'Connection refused to http://localhost:5432/postgres';
    expect(sanitizeErrorMessage(msg)).toBe('Connection refused to [url]');
  });

  it('strips https URLs', () => {
    const msg = 'Failed to call https://api.openfort.io/v1/accounts/abc123';
    expect(sanitizeErrorMessage(msg)).toBe('Failed to call [url]');
  });

  it('strips file paths', () => {
    const msg = 'Error at /usr/src/app/dist/modules/wallet/wallet.service.js:42:15';
    expect(sanitizeErrorMessage(msg)).toBe('Error at [path]:42:15');
  });

  it('strips stack trace lines', () => {
    const msg = `TypeError: Cannot read property 'id' of undefined
    at WalletService.sign (wallet.service.ts:100:25)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
    expect(sanitizeErrorMessage(msg)).toBe(
      "TypeError: Cannot read property 'id' of undefined",
    );
  });

  it('collapses whitespace', () => {
    const msg = 'Error:   too   many   spaces   ';
    expect(sanitizeErrorMessage(msg)).toBe('Error: too many spaces');
  });

  it('truncates to maxLength', () => {
    const msg = 'a'.repeat(600);
    expect(sanitizeErrorMessage(msg)).toBe('a'.repeat(500));
  });

  it('uses default maxLength of 500', () => {
    const msg = 'x'.repeat(600);
    expect(sanitizeErrorMessage(msg)).toBe('x'.repeat(500));
  });

  it('allows custom maxLength', () => {
    const msg = 'x'.repeat(300);
    expect(sanitizeErrorMessage(msg, 240)).toBe('x'.repeat(240));
  });

  it('handles empty string', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });

  it('handles combined sanitization', () => {
    const msg = `Error at https://internal.api:8080/v1/tx for 0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef1234567890 in /src/app/service.ts:10
    at Service.process (service.ts:10:5)`;
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('https://');
    expect(result).not.toContain('0xdeadbeef');
    expect(result).not.toContain('at Service.process');
  });
});

describe('getErrorText', () => {
  it('returns empty string for null', () => {
    expect(getErrorText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(getErrorText(undefined)).toBe('');
  });

  it('returns string as-is', () => {
    expect(getErrorText('something failed')).toBe('something failed');
  });

  it('extracts message from Error objects', () => {
    expect(getErrorText(new Error('test error'))).toBe('test error');
  });

  it('extracts shortMessage, message, and details', () => {
    const error = {
      shortMessage: 'short',
      message: 'full message',
      details: 'detail info',
    };
    expect(getErrorText(error)).toBe('short full message detail info');
  });

  it('extracts cause chain one level deep', () => {
    const error = {
      message: 'outer',
      cause: { message: 'inner cause', details: 'cause detail' },
    };
    expect(getErrorText(error)).toBe('outer inner cause cause detail');
  });

  it('skips non-string fields', () => {
    const error = { message: 'valid', code: 500, data: { key: 'val' } };
    expect(getErrorText(error)).toBe('valid');
  });

  it('handles empty object', () => {
    expect(getErrorText({})).toBe('');
  });
});
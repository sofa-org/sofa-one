import {
  safeIdTag,
  safeManifestLabel,
  sanitizeFixtureLogMessage,
} from './billing-fixture-log-safety';

describe('billing-fixture-log-safety', () => {
  it('uses fixed labels for manifest paths (never basename free-text)', () => {
    expect(safeManifestLabel(undefined, true)).toBe('<default-manifest>');
    expect(safeManifestLabel('/tmp/billing-fixtures/demo-user.json', false)).toBe(
      '<custom-manifest>',
    );
    expect(safeManifestLabel('sk_test_secret_in_path.json', false)).toBe('<custom-manifest>');
  });

  it('tags validated ids without echoing free text', () => {
    expect(safeIdTag('user', '00000000-0000-4000-8000-000000000001')).toBe('<user-uuid>');
    expect(safeIdTag('fixture', 'demo-jan')).toBe('<fixture-id>');
    expect(safeIdTag('fixture', 'bad id!')).toBe('<fixture-invalid>');
  });

  it('redacts database URLs, bearer/JWT, stripe patterns, and configured secrets present in input', () => {
    const secret = 'KEYVAL_extra_secret_value_32chars!!';
    const dbUrl = 'postgresql://user:pass@host:5432/db';
    // Secret MUST appear in the message so redaction is actually exercised.
    const msg = `fail ${dbUrl} Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig sk_test_abc123 whsec_zzz ${secret}`;
    const out = sanitizeFixtureLogMessage(msg, {
      manifestKey: secret,
      dbUrl,
    });
    expect(out).not.toMatch(/postgresql:\/\//);
    expect(out).toContain('<database-url-redacted>');
    expect(out).toContain('<jwt-redacted>');
    expect(out).toContain('<stripe-key-redacted>');
    expect(out).toContain('<webhook-secret-redacted>');
    expect(out).toContain('<manifest-key-redacted>');
    expect(out).not.toContain('pass@host');
    expect(out).not.toContain(secret);
    expect(out).not.toContain(dbUrl);
  });
});

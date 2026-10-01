/**
 * Pure log-safety helpers shared by the billing-fixture CLI and unit tests.
 * Prefer fixed labels over free-text user/path values.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXTURE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function safeManifestLabel(_filePath: string | undefined, isDefault: boolean): string {
  return isDefault ? '<default-manifest>' : '<custom-manifest>';
}

export function safeIdTag(kind: 'fixture' | 'user', value: string): string {
  if (kind === 'user' && UUID_RE.test(value)) return '<user-uuid>';
  if (kind === 'fixture' && FIXTURE_ID_RE.test(value)) return '<fixture-id>';
  return `<${kind}-invalid>`;
}

export function sanitizeFixtureLogMessage(
  msg: string,
  secrets: { manifestKey?: string; dbUrl?: string; databaseUrl?: string } = {},
): string {
  let out = msg
    .replace(/\bpostgres(ql)?:\/\/[^\s"'`]+/gi, '<database-url-redacted>')
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, '<stripe-key-redacted>')
    .replace(/whsec_[A-Za-z0-9]+/g, '<webhook-secret-redacted>')
    // JWT before generic bearer token so bare and Bearer-prefixed JWTs both redact.
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<jwt-redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <token-redacted>');

  if (secrets.manifestKey && secrets.manifestKey.length >= 8) {
    out = out.split(secrets.manifestKey).join('<manifest-key-redacted>');
  }
  if (secrets.dbUrl && secrets.dbUrl.length >= 8) {
    out = out.split(secrets.dbUrl).join('<database-url-redacted>');
  }
  if (secrets.databaseUrl && secrets.databaseUrl.length >= 8) {
    out = out.split(secrets.databaseUrl).join('<database-url-redacted>');
  }
  return out;
}

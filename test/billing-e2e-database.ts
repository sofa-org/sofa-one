/**
 * Shared fail-closed database gate for destructive billing E2E suites
 * (billing-http, claim-concurrency, settlement-concurrency).
 *
 * Ownership/exclusivity is proven only by a runner-provisioned target:
 *   1. Explicit BILLING_E2E_DATABASE_URL (never falls back to DATABASE_URL)
 *   2. BILLING_E2E_DISPOSABLE_DB=true
 *   3. BILLING_E2E_PROVISIONED=runner-v1 (runner ack only — not operator self-attest)
 *   4. BILLING_E2E_RUN_ID + expected database/user/owner/application_name metadata
 *   5. Live identity: current_database, current_user, session_user, database owner,
 *      application_name must all match the generated target
 *
 * Static shared names (agent_wallet, sofa_one_e2e, …) are refused without full
 * runner metadata. Errors never include the full URL, userinfo, or password.
 */

export const BILLING_E2E_DATABASE_URL_ENV = 'BILLING_E2E_DATABASE_URL';
export const BILLING_E2E_DISPOSABLE_ENV = 'BILLING_E2E_DISPOSABLE_DB';
export const BILLING_E2E_PROVISIONED_ENV = 'BILLING_E2E_PROVISIONED';
export const BILLING_E2E_RUN_ID_ENV = 'BILLING_E2E_RUN_ID';
export const BILLING_E2E_EXPECTED_DATABASE_ENV = 'BILLING_E2E_EXPECTED_DATABASE';
export const BILLING_E2E_EXPECTED_USER_ENV = 'BILLING_E2E_EXPECTED_USER';
export const BILLING_E2E_EXPECTED_OWNER_ENV = 'BILLING_E2E_EXPECTED_OWNER';
export const BILLING_E2E_APPLICATION_NAME_ENV = 'BILLING_E2E_APPLICATION_NAME';

/** Runner must set this exact token after provisioning a fresh DB+role. */
export const BILLING_E2E_PROVISIONED_TOKEN = 'runner-v1';

/** Known non-disposable / shared catalog names that must never be accepted. */
const FORBIDDEN_DATABASE_NAMES = new Set([
  'agent_wallet',
  'postgres',
  'template0',
  'template1',
  'sofa_one_e2e',
  'sofa_one_test',
]);

const RUN_ID_RE = /^[a-z0-9]{8,32}$/;
const PG_IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

export type BillingE2eDatabaseTarget = {
  /** Full connection string — only for client construction, never log. */
  url: string;
  databaseName: string;
  runId: string;
  expectedUser: string;
  expectedOwner: string;
  applicationName: string;
};

export type BillingE2eIdentitySnapshot = {
  databaseName: string;
  currentUser: string;
  sessionUser: string;
  databaseOwner: string;
  applicationName: string;
};

/**
 * Canonical read-only identity SQL. Usable via `pg` (runner) or Prisma $queryRaw
 * (suites). Column aliases are stable for both drivers.
 */
export const BILLING_E2E_IDENTITY_SQL = `
SELECT
  current_database() AS database_name,
  current_user::text AS current_user,
  session_user::text AS session_user,
  pg_catalog.pg_get_userbyid(d.datdba)::text AS database_owner,
  COALESCE(current_setting('application_name', true), '') AS application_name
FROM pg_catalog.pg_database d
WHERE d.datname = current_database()
`.trim();

/**
 * Resolve and statically validate the runner-provisioned billing E2E target.
 * Does not connect. Throws without embedding credentials.
 */
export function resolveBillingE2eDatabaseTarget(
  env: NodeJS.ProcessEnv = process.env,
): BillingE2eDatabaseTarget {
  // Never fall back to inherited DATABASE_URL — require the explicit target.
  const raw = env[BILLING_E2E_DATABASE_URL_ENV]?.trim() ?? '';
  if (!raw) {
    throw new Error(
      `${BILLING_E2E_DATABASE_URL_ENV} is required for billing E2E (no DATABASE_URL fallback)`,
    );
  }

  if (env[BILLING_E2E_DISPOSABLE_ENV] !== 'true') {
    throw new Error(
      `${BILLING_E2E_DISPOSABLE_ENV}=true is required before billing E2E may seed or clean a database`,
    );
  }

  if (env[BILLING_E2E_PROVISIONED_ENV] !== BILLING_E2E_PROVISIONED_TOKEN) {
    throw new Error(
      `${BILLING_E2E_PROVISIONED_ENV}=${BILLING_E2E_PROVISIONED_TOKEN} is required (runner-owned target only)`,
    );
  }

  const runId = env[BILLING_E2E_RUN_ID_ENV]?.trim() ?? '';
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`${BILLING_E2E_RUN_ID_ENV} is missing or invalid`);
  }

  const expectedDatabase = env[BILLING_E2E_EXPECTED_DATABASE_ENV]?.trim() ?? '';
  const expectedUser = env[BILLING_E2E_EXPECTED_USER_ENV]?.trim() ?? '';
  const expectedOwner = env[BILLING_E2E_EXPECTED_OWNER_ENV]?.trim() ?? '';
  const applicationName = env[BILLING_E2E_APPLICATION_NAME_ENV]?.trim() ?? '';

  if (!expectedDatabase || !PG_IDENT_RE.test(expectedDatabase)) {
    throw new Error(`${BILLING_E2E_EXPECTED_DATABASE_ENV} is missing or invalid`);
  }
  if (!expectedUser || !PG_IDENT_RE.test(expectedUser)) {
    throw new Error(`${BILLING_E2E_EXPECTED_USER_ENV} is missing or invalid`);
  }
  if (!expectedOwner || !PG_IDENT_RE.test(expectedOwner)) {
    throw new Error(`${BILLING_E2E_EXPECTED_OWNER_ENV} is missing or invalid`);
  }
  if (!applicationName || applicationName.length > 64 || /\s/.test(applicationName)) {
    throw new Error(`${BILLING_E2E_APPLICATION_NAME_ENV} is missing or invalid`);
  }

  // Generated names must embed the run id so a static shared DB cannot pass.
  if (!expectedDatabase.includes(runId) || !expectedUser.includes(runId)) {
    throw new Error('billing E2E expected database/user must embed the run id');
  }
  if (!applicationName.includes(runId)) {
    throw new Error('billing E2E application_name must embed the run id');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${BILLING_E2E_DATABASE_URL_ENV} is not a parseable URL`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`${BILLING_E2E_DATABASE_URL_ENV} must use the postgres(ql) scheme`);
  }

  const databaseName = databaseNameFromPostgresUrl(parsed);
  if (!databaseName) {
    throw new Error(`${BILLING_E2E_DATABASE_URL_ENV} must include a database name in the path`);
  }

  const lower = databaseName.toLowerCase();
  if (FORBIDDEN_DATABASE_NAMES.has(lower)) {
    throw new Error(`${BILLING_E2E_DATABASE_URL_ENV} targets a forbidden database name (refused)`);
  }
  if (!lower.includes('e2e') && !lower.includes('test')) {
    throw new Error(`${BILLING_E2E_DATABASE_URL_ENV} database name must contain "test" or "e2e"`);
  }
  if (databaseName !== expectedDatabase) {
    throw new Error(
      `${BILLING_E2E_DATABASE_URL_ENV} path name does not match ${BILLING_E2E_EXPECTED_DATABASE_ENV}`,
    );
  }

  // Dedicated runner role in the URL is part of ownership proof — never accept
  // peer-auth / missing-username URLs that would connect as an ambient role.
  const urlUser = decodeURIComponent(parsed.username || '');
  if (!urlUser) {
    throw new Error(
      `${BILLING_E2E_DATABASE_URL_ENV} must include a username (dedicated test role)`,
    );
  }
  if (urlUser !== expectedUser) {
    throw new Error(`${BILLING_E2E_DATABASE_URL_ENV} user does not match expected test role`);
  }

  return {
    url: raw,
    databaseName,
    runId,
    expectedUser,
    expectedOwner,
    applicationName,
  };
}

/**
 * Point process.env.DATABASE_URL at the explicit E2E target so Prisma / Nest
 * never inherit a developer or production DATABASE_URL for these suites.
 */
export function applyBillingE2eDatabaseUrl(
  target?: BillingE2eDatabaseTarget,
  env: NodeJS.ProcessEnv = process.env,
): BillingE2eDatabaseTarget {
  const resolved = target ?? resolveBillingE2eDatabaseTarget(env);
  env.DATABASE_URL = resolved.url;
  return resolved;
}

/**
 * Normalize a raw identity query row (pg or Prisma) into a snapshot.
 */
export function normalizeBillingE2eIdentityRow(row: unknown): BillingE2eIdentitySnapshot {
  if (!row || typeof row !== 'object') {
    throw new Error('billing E2E identity row is missing');
  }
  const r = row as Record<string, unknown>;
  const databaseName = stringField(r, 'database_name', 'databaseName');
  const currentUser = stringField(r, 'current_user', 'currentUser');
  const sessionUser = stringField(r, 'session_user', 'sessionUser');
  const databaseOwner = stringField(r, 'database_owner', 'databaseOwner');
  const applicationName = stringField(r, 'application_name', 'applicationName');
  return { databaseName, currentUser, sessionUser, databaseOwner, applicationName };
}

/**
 * Live identity check before first migration/seed/cleanup.
 * `queryIdentity` must run BILLING_E2E_IDENTITY_SQL (or equivalent) and return one row.
 */
export async function assertBillingE2eDatabaseIdentity(
  target: BillingE2eDatabaseTarget,
  queryIdentity: () => Promise<unknown>,
): Promise<BillingE2eIdentitySnapshot> {
  let raw: unknown;
  try {
    raw = await queryIdentity();
  } catch {
    throw new Error('billing E2E database identity check failed (could not read identity)');
  }

  const row = firstIdentityRow(raw);
  let snapshot: BillingE2eIdentitySnapshot;
  try {
    snapshot = normalizeBillingE2eIdentityRow(row);
  } catch {
    throw new Error('billing E2E database identity check failed (empty or malformed identity)');
  }

  if (snapshot.databaseName !== target.databaseName) {
    throw new Error('billing E2E identity mismatch: current_database');
  }
  if (snapshot.currentUser !== target.expectedUser) {
    throw new Error('billing E2E identity mismatch: current_user');
  }
  if (snapshot.sessionUser !== target.expectedUser) {
    throw new Error('billing E2E identity mismatch: session_user');
  }
  if (snapshot.databaseOwner !== target.expectedOwner) {
    throw new Error('billing E2E identity mismatch: database_owner');
  }
  if (snapshot.applicationName !== target.applicationName) {
    throw new Error('billing E2E identity mismatch: application_name');
  }

  return snapshot;
}

/** pg Client-compatible identity query helper. */
export async function queryBillingE2eIdentityWithPg(client: {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}): Promise<BillingE2eIdentitySnapshot> {
  const result = await client.query(BILLING_E2E_IDENTITY_SQL);
  return normalizeBillingE2eIdentityRow(result.rows[0]);
}

/** Prisma $queryRawUnsafe-compatible identity query helper. */
export async function queryBillingE2eIdentityWithPrisma(prisma: {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
}): Promise<BillingE2eIdentitySnapshot> {
  const rows = await prisma.$queryRawUnsafe(BILLING_E2E_IDENTITY_SQL);
  return normalizeBillingE2eIdentityRow(firstIdentityRow(rows));
}

/**
 * Build child-process env for suites: strips admin URL and injects only the
 * generated target + runner metadata. Does not mutate the caller's env object
 * beyond the returned copy.
 */
export function buildBillingE2eChildEnv(
  target: BillingE2eDatabaseTarget,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...baseEnv };
  // Never leak the admin provisioning URL into Jest/Prisma.
  delete child.BILLING_E2E_ADMIN_DATABASE_URL;
  child[BILLING_E2E_DATABASE_URL_ENV] = target.url;
  child.DATABASE_URL = target.url;
  child[BILLING_E2E_DISPOSABLE_ENV] = 'true';
  child[BILLING_E2E_PROVISIONED_ENV] = BILLING_E2E_PROVISIONED_TOKEN;
  child[BILLING_E2E_RUN_ID_ENV] = target.runId;
  child[BILLING_E2E_EXPECTED_DATABASE_ENV] = target.databaseName;
  child[BILLING_E2E_EXPECTED_USER_ENV] = target.expectedUser;
  child[BILLING_E2E_EXPECTED_OWNER_ENV] = target.expectedOwner;
  child[BILLING_E2E_APPLICATION_NAME_ENV] = target.applicationName;
  child.NODE_ENV = child.NODE_ENV || 'test';
  return child;
}

export function databaseNameFromPostgresUrl(parsed: URL): string {
  const rawPath = parsed.pathname ?? '';
  const trimmed = rawPath.replace(/^\//, '');
  if (!trimmed) return '';
  const first = trimmed.split('/')[0] ?? '';
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
}

function firstIdentityRow(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw[0];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: unknown[] }).rows[0];
  }
  return raw;
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // Prefer the first key name in error context without dumping the row.
  throw new Error(`billing E2E identity field missing: ${keys[0]}`);
}

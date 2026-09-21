/**
 * Runner-owned billing E2E entrypoint (Gate 1).
 *
 * Provisions a fresh per-run PostgreSQL database + dedicated login role under
 * a unique run id, verifies identity (database/user/session/owner/application
 * marker), runs migrations, then executes the billing E2E suites against that
 * exact target. Drops the database (FORCE) and role in finally.
 *
 * Failures inside provisioning/migrate/test throw (never process.exit) so the
 * main try/finally always runs teardown when names were registered.
 *
 * Admin input (never passed to child Jest):
 *   BILLING_E2E_ADMIN_DATABASE_URL  — superuser URL to maintenance DB (postgres)
 *
 * Child env is built only from the generated target + runner metadata
 * (see test/billing-e2e-database.ts). No static shared DB is accepted.
 *
 * Usage:
 *   npm run test:e2e:billing
 *   npm run test:e2e:billing -- --gate-only   # no-DB negative tests only
 */
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import * as path from 'path';
import {
  BILLING_E2E_IDENTITY_SQL,
  assertBillingE2eDatabaseIdentity,
  buildBillingE2eChildEnv,
  type BillingE2eDatabaseTarget,
} from '../test/billing-e2e-database';

const ADMIN_URL_ENV = 'BILLING_E2E_ADMIN_DATABASE_URL';
const ROOT = path.resolve(__dirname, '..');

type PgClient = {
  connect: () => Promise<void>;
  end: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

type PgClientCtor = new (config: {
  connectionString: string;
  connectionTimeoutMillis?: number;
}) => PgClient;

/** Names registered as soon as chosen so partial provision failures still clean up. */
export type BillingE2eProvisionedNames = {
  database?: string;
  role?: string;
};

function loadPg(): PgClientCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('pg') as { Client: PgClientCtor };
  return pg.Client;
}

/** Fatal config/identity error for the runner (does not call process.exit). */
export class BillingE2eRunnerError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'BillingE2eRunnerError';
    this.exitCode = exitCode;
  }
}

function runnerFail(message: string, exitCode = 2): never {
  throw new BillingE2eRunnerError(message, exitCode);
}

function assertSafeIdent(name: string, label: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    runnerFail(`${label} is not a safe PostgreSQL identifier`);
  }
  return name;
}

function quoteIdent(name: string): string {
  assertSafeIdent(name, 'identifier');
  return `"${name}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sanitizeAdminUrl(raw: string): { url: string; maintenanceDb: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    runnerFail(`${ADMIN_URL_ENV} is not a parseable URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    runnerFail(`${ADMIN_URL_ENV} must use the postgres(ql) scheme`);
  }
  const db =
    decodeURIComponent((parsed.pathname || '').replace(/^\//, '').split('/')[0] || '') ||
    'postgres';
  // Prefer connecting to maintenance catalog for CREATE DATABASE.
  if (db !== 'postgres') {
    parsed.pathname = '/postgres';
  }
  return { url: parsed.toString(), maintenanceDb: 'postgres' };
}

function buildTargetUrl(args: {
  adminUrl: string;
  database: string;
  user: string;
  password: string;
  applicationName: string;
}): string {
  const parsed = new URL(args.adminUrl);
  parsed.username = args.user;
  parsed.password = args.password;
  parsed.pathname = `/${args.database}`;
  parsed.search = '';
  parsed.searchParams.set('application_name', args.applicationName);
  return parsed.toString();
}

async function withClient<T>(
  Client: PgClientCtor,
  connectionString: string,
  work: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitForAdmin(
  Client: PgClientCtor,
  adminUrl: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      await withClient(Client, adminUrl, async (client) => {
        const res = await client.query(
          `SELECT current_database() AS database_name, current_user::text AS current_user`,
        );
        const row = res.rows[0] as { database_name?: string; current_user?: string };
        if (row?.database_name !== 'postgres') {
          // Identity mismatch must fail clearly — not retry as generic unreadiness.
          throw Object.assign(
            new Error('admin identity mismatch: expected maintenance database postgres'),
            { fatal: true },
          );
        }
        if (!row.current_user) {
          throw Object.assign(new Error('admin identity mismatch: empty current_user'), {
            fatal: true,
          });
        }
      });
      return;
    } catch (err) {
      const fatal = Boolean((err as { fatal?: boolean })?.fatal);
      lastError = err instanceof Error ? err.message : 'connect_failed';
      if (fatal) runnerFail(lastError);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  runnerFail(`admin PostgreSQL did not become ready: ${lastError}`);
}

/**
 * Create role + database. Calls `registerNames` with the chosen identifiers
 * *before* any CREATE so the caller can DROP IF EXISTS even if creation fails
 * mid-way (role created, database not; grant failed; etc.).
 */
export async function provisionBillingE2eTarget(
  Client: PgClientCtor,
  adminUrl: string,
  registerNames: (names: BillingE2eProvisionedNames) => void,
): Promise<{
  runId: string;
  database: string;
  role: string;
  password: string;
  applicationName: string;
  targetUrl: string;
}> {
  const runId = randomBytes(8).toString('hex'); // 16 hex chars
  const database = assertSafeIdent(`billing_e2e_d_${runId}`, 'database');
  const role = assertSafeIdent(`billing_e2e_r_${runId}`, 'role');
  const password = randomBytes(24).toString('base64url');
  const applicationName = `billing-e2e-${runId}`;

  // Register before any server mutation so finally can always attempt cleanup.
  registerNames({ database, role });

  await withClient(Client, adminUrl, async (client) => {
    // Role + DB are always created fresh for this run id (no reuse of shared DBs).
    await client.query(
      `CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await client.query(
      `CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(role)} TEMPLATE template0`,
    );
    // Allow the role to connect; ownership already grants full rights inside DB.
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(role)}`,
    );
  });

  const targetUrl = buildTargetUrl({
    adminUrl,
    database,
    user: role,
    password,
    applicationName,
  });

  // Verify as the generated role against the fresh DB before migrate/tests.
  const target: BillingE2eDatabaseTarget = {
    url: targetUrl,
    databaseName: database,
    runId,
    expectedUser: role,
    expectedOwner: role,
    applicationName,
  };
  await withClient(Client, targetUrl, async (client) => {
    // PG15+ locks down public schema; ensure the owner role can migrate.
    await client.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(role)}`);
    await client.query(`GRANT CREATE ON SCHEMA public TO ${quoteIdent(role)}`);
    await assertBillingE2eDatabaseIdentity(target, async () => {
      const res = await client.query(BILLING_E2E_IDENTITY_SQL);
      return res.rows;
    });
  });

  return { runId, database, role, password, applicationName, targetUrl };
}

/**
 * Best-effort DROP DATABASE / DROP ROLE. Swallows cleanup errors so callers
 * can preserve the original failure. Returns false if any cleanup step failed.
 */
export async function destroyBillingE2eTarget(
  Client: PgClientCtor,
  adminUrl: string,
  names: BillingE2eProvisionedNames,
): Promise<boolean> {
  const { database, role } = names;
  if (!database && !role) return true;

  let ok = true;
  try {
    await withClient(Client, adminUrl, async (client) => {
      if (database) {
        try {
          // PG 13+: terminate backends and drop. FORCE is the primary cleanup path.
          await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
        } catch {
          try {
            await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
          } catch {
            ok = false;
            console.error('[billing-e2e-runner] failed to drop run database (name omitted)');
          }
        }
      }
      if (role) {
        try {
          await client.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
        } catch {
          ok = false;
          console.error('[billing-e2e-runner] failed to drop run role (name omitted)');
        }
      }
    });
  } catch {
    ok = false;
    console.error('[billing-e2e-runner] teardown failed (details omitted)');
  }
  return ok;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function redactErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : 'runner_failed';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-url>');
}

async function main(): Promise<number> {
  const gateOnly = process.argv.includes('--gate-only');

  // Always run no-DB gate tests first (no admin URL required; no provisioned resources).
  const gateEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'test',
  };
  delete gateEnv[ADMIN_URL_ENV];
  const gateCode = await runCommand(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'jest',
      '--config',
      './test/jest-e2e.json',
      '--runInBand',
      'test/billing-e2e-database.e2e-spec.ts',
    ],
    gateEnv,
  );
  if (gateCode !== 0) {
    return gateCode;
  }
  if (gateOnly) {
    console.log('[billing-e2e-runner] gate-only complete');
    return 0;
  }

  const adminRaw = process.env[ADMIN_URL_ENV]?.trim() ?? '';
  if (!adminRaw) {
    runnerFail(
      `${ADMIN_URL_ENV} is required to provision a disposable billing E2E database (no static target)`,
    );
  }

  const Client = loadPg();
  const { url: adminUrl } = sanitizeAdminUrl(adminRaw);

  // Tracked as soon as provision chooses names — even if CREATE fails mid-way.
  const provisionedNames: BillingE2eProvisionedNames = {};
  let exitCode = 1;
  let primaryError: unknown;

  try {
    await waitForAdmin(Client, adminUrl);
    const provisioned = await provisionBillingE2eTarget(Client, adminUrl, (names) => {
      if (names.database) provisionedNames.database = names.database;
      if (names.role) provisionedNames.role = names.role;
    });

    const target: BillingE2eDatabaseTarget = {
      url: provisioned.targetUrl,
      databaseName: provisioned.database,
      runId: provisioned.runId,
      expectedUser: provisioned.role,
      expectedOwner: provisioned.role,
      applicationName: provisioned.applicationName,
    };

    // Child env: generated target only — never admin credentials.
    const childEnv = buildBillingE2eChildEnv(target, process.env);

    console.log(
      `[billing-e2e-runner] provisioned run_id=${provisioned.runId} (database/role names embed run id; credentials omitted)`,
    );

    const migrateCode = await runCommand(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['prisma', 'migrate', 'deploy'],
      childEnv,
    );
    if (migrateCode !== 0) {
      runnerFail('prisma migrate deploy failed against runner-provisioned target', migrateCode);
    }

    // Re-verify after migrate (still same generated target).
    await withClient(Client, provisioned.targetUrl, async (client) => {
      await assertBillingE2eDatabaseIdentity(target, async () => {
        const res = await client.query(BILLING_E2E_IDENTITY_SQL);
        return res.rows;
      });
    });

    const jestCode = await runCommand(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      [
        'jest',
        '--config',
        './test/jest-e2e.json',
        '--runInBand',
        'test/billing-http.e2e-spec.ts',
        'test/claim-concurrency.e2e-spec.ts',
        'test/settlement-concurrency.e2e-spec.ts',
        // BILL-016 Phase 2A: API-key direct-egress destination/cooldown runtime evidence
        'test/api-key-direct-egress.e2e-spec.ts',
        'test/api-key-direct-egress-concurrency.e2e-spec.ts',
        // BILL-016 Phase 2B: quote-bound wallet-payment runtime evidence
        'test/usdc-wallet-payment.e2e-spec.ts',
        // Phase 3: payment/reconciliation integrity (cross-rail, cleanup lease, worker health)
        'test/phase3-billing.e2e-spec.ts',
      ],
      childEnv,
    );
    exitCode = jestCode;
  } catch (err) {
    primaryError = err;
    if (err instanceof BillingE2eRunnerError) {
      exitCode = err.exitCode;
    } else {
      exitCode = 2;
    }
  } finally {
    // Always attempt DROP when names were registered; never mask primaryError.
    const cleaned = await destroyBillingE2eTarget(Client, adminUrl, provisionedNames);
    if (!cleaned && exitCode === 0) {
      exitCode = 1;
    }
  }

  if (primaryError) {
    console.error(`[billing-e2e-runner] ${redactErrorMessage(primaryError)}`);
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    // Unexpected rejection outside the provisioned try/finally (e.g. gate spawn).
    console.error(`[billing-e2e-runner] ${redactErrorMessage(err)}`);
    process.exit(2);
  });

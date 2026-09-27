/**
 * Historical billing-period fixture CLI (ops / local validation only).
 *
 * Atomic create path: assignment + posted usage + create-only finalize all run
 * inside one Serializable tx holding the shared billing-period advisory lock.
 * Ownership is proven only by BillingService.createFinalizedInvoiceOnlyInTx
 * returning { created: true } — never by timestamps or “absence before start”.
 *
 * Safety (writes/deletes require ALL of):
 *   - BILLING_FIXTURE_ENABLED=true
 *   - explicit --apply
 *   - BILLING_FIXTURE_DATABASE_URL (never falls back to DATABASE_URL)
 *   - BILLING_FIXTURE_MANIFEST_KEY (HMAC; never written to disk)
 *   - NODE_ENV in {development, test, staging} (script never sets NODE_ENV)
 * Invoice/assignment cleanup also requires BILLING_FIXTURE_DISPOSABLE_DB=true.
 *
 * Default: dry-run (no DB writes, no manifest file).
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

const MANIFEST_SCHEMA = 'sofa-one.billing-fixture';
const MANIFEST_VERSION = 2;
const ALLOWED_NODE_ENV = new Set(['development', 'test', 'staging']);
const SELF_SERVICE_PLAN_CODES = new Set(['free', 'starter', 'growth', 'scale', 'business']);
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXTURE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const BIGINT_STR_RE = /^-?\d+$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DEFAULT_PLAN = 'starter';
const DEFAULT_API_CALLS = 0;
const MIN_MANIFEST_KEY_LEN = 32;
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_SAFETY = 2;

const ENV_ENABLED = 'BILLING_FIXTURE_ENABLED';
const ENV_DB_URL = 'BILLING_FIXTURE_DATABASE_URL';
const ENV_MANIFEST_KEY = 'BILLING_FIXTURE_MANIFEST_KEY';
const ENV_DISPOSABLE = 'BILLING_FIXTURE_DISPOSABLE_DB';
const BILLING_E2E_RUNNER_TOKEN = 'runner-v1';

const MANIFEST_ROOT_KEYS = new Set([
  'schema',
  'version',
  'fixtureId',
  'userId',
  'billingAccountId',
  'planCode',
  'planVersionId',
  'planVersionCode',
  'planVersionNumber',
  'planTermsFingerprint',
  'periods',
  'apiCallsPerPeriod',
  'inputFingerprint',
  'createdAt',
  'periodDetails',
  'signature',
]);

const MANIFEST_PERIOD_KEYS = new Set([
  'period',
  'periodStart',
  'periodEnd',
  'assignmentId',
  'assignmentOwnedByFixture',
  'invoiceId',
  'invoiceOwnedByFixture',
  'snapshotHash',
  'totalMicros',
  'planVersionId',
  'usageSourceKeys',
  'apiCallCount',
  'mode',
  'syntheticWalletUsageId',
]);

type Command = 'seed' | 'verify' | 'cleanup';
type PeriodMode = 'created' | 'verified_readonly';
type ErrKind = 'safety' | 'conflict' | 'not_found' | 'invalid' | 'internal';

interface CliArgs {
  command: Command | null;
  help: boolean;
  apply: boolean;
  userId?: string;
  periods: string[];
  fixtureId?: string;
  planCode: string;
  apiCalls: number;
  manifestPath?: string;
}

interface PeriodParsed {
  period: string;
  start: Date;
  end: Date;
}

interface ManifestPeriod {
  period: string;
  periodStart: string;
  periodEnd: string;
  assignmentId: string;
  assignmentOwnedByFixture: boolean;
  invoiceId: string;
  invoiceOwnedByFixture: boolean;
  snapshotHash: string;
  totalMicros: string;
  planVersionId: string;
  usageSourceKeys: string[];
  apiCallCount: number;
  mode: PeriodMode;
  /** Present only for manifests that created their own synthetic peak row. */
  syntheticWalletUsageId?: string;
}

interface FixtureManifest {
  schema: typeof MANIFEST_SCHEMA;
  version: typeof MANIFEST_VERSION;
  fixtureId: string;
  userId: string;
  billingAccountId: string;
  planCode: string;
  planVersionId: string;
  planVersionCode: string;
  planVersionNumber: number;
  /** SHA-256 of canonical plan terms + ordered tiers (read-only integrity). */
  planTermsFingerprint: string;
  periods: string[];
  apiCallsPerPeriod: number;
  inputFingerprint: string;
  createdAt: string;
  periodDetails: ManifestPeriod[];
  signature: string;
}

type PrismaServiceType = import('../src/core/database/prisma.service').PrismaService;
type BillingServiceType = import('../src/modules/billing/billing.service').BillingService;
type Tx = import('@prisma/client').Prisma.TransactionClient;

// ── Controlled errors (no raw provider messages on the wire) ─────────────────

class FixtureError extends Error {
  readonly exitCode: number;
  readonly kind: ErrKind;
  constructor(kind: ErrKind, publicCode: string, exitCode: number) {
    super(publicCode);
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

function safetyFail(code: string): never {
  throw new FixtureError('safety', code, EXIT_SAFETY);
}
function opFail(code: string): never {
  throw new FixtureError('conflict', code, EXIT_FAIL);
}

function logInfoRaw(msg: string): void {
  // Static help only — never pass user/runtime values through this path.
  process.stdout.write(`${msg}\n`);
}

function logInfo(msg: string): void {
  process.stdout.write(`${sanitizeSecrets(msg)}\n`);
}

function logErr(msg: string): void {
  process.stderr.write(`${sanitizeSecrets(msg)}\n`);
}

function safeManifestLabel(filePath: string | undefined, isDefault: boolean): string {
  const { safeManifestLabel: impl } =
    require('../src/modules/billing/billing-fixture-log-safety') as {
      safeManifestLabel: (p: string | undefined, d: boolean) => string;
    };
  return impl(filePath, isDefault);
}

function safeIdTag(kind: 'fixture' | 'user', value: string): string {
  const { safeIdTag: impl } = require('../src/modules/billing/billing-fixture-log-safety') as {
    safeIdTag: (k: 'fixture' | 'user', v: string) => string;
  };
  return impl(kind, value);
}

function sanitizeSecrets(msg: string): string {
  const { sanitizeFixtureLogMessage } =
    require('../src/modules/billing/billing-fixture-log-safety') as {
      sanitizeFixtureLogMessage: (
        m: string,
        s: { manifestKey?: string; dbUrl?: string; databaseUrl?: string },
      ) => string;
    };
  return sanitizeFixtureLogMessage(msg, {
    manifestKey: process.env[ENV_MANIFEST_KEY],
    dbUrl: process.env[ENV_DB_URL],
    databaseUrl: process.env.DATABASE_URL,
  });
}

function planTermsFromPinned(pv: {
  monthlyFeeMicros: bigint | null;
  includedOutboundMicros: bigint | null;
  includedApiCalls: bigint | null;
  includedWallets: number | null;
  apiOverageRateMicros: bigint;
  walletOverageRateMicros: bigint;
}): {
  monthlyFeeMicros: bigint;
  includedOutboundMicros: bigint;
  includedApiCalls: bigint;
  includedWallets: number;
  apiOverageRateMicros: bigint;
  walletOverageRateMicros: bigint;
} {
  if (
    pv.monthlyFeeMicros === null ||
    pv.includedOutboundMicros === null ||
    pv.includedApiCalls === null ||
    pv.includedWallets === null
  ) {
    opFail('plan_terms_null');
  }
  return {
    monthlyFeeMicros: pv.monthlyFeeMicros,
    includedOutboundMicros: pv.includedOutboundMicros,
    includedApiCalls: pv.includedApiCalls,
    includedWallets: pv.includedWallets,
    apiOverageRateMicros: pv.apiOverageRateMicros,
    walletOverageRateMicros: pv.walletOverageRateMicros,
  };
}

function publicErrorMessage(err: unknown): string {
  if (err instanceof FixtureError) return err.message;
  // Nest/Prisma/etc. — never forward raw message (may embed connection strings).
  const code = (err as { code?: string })?.code;
  if (code === 'P2002') return 'unique_constraint_conflict';
  if (code === 'P2025') return 'record_not_found';
  if (code === 'P1000' || code === 'P1001') return 'database_unavailable';
  const name = (err as { name?: string })?.name;
  if (name === 'ConflictException') return 'billing_conflict';
  if (name === 'BadRequestException') return 'billing_bad_request';
  if (name === 'PrismaClientValidationError') {
    const message = (err as { message?: string })?.message ?? '';
    const issue = message.match(/(?:Unknown argument|Argument|Unknown field)\s+[`']([A-Za-z0-9_]+)[`']/);
    return issue ? `prisma_validation_${issue[1]}` : 'prisma_validation_error';
  }
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return `database_error_${code}`;
  if (typeof name === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(name)) return `internal_error_${name}`;
  return 'operation_failed';
}

// ── Usage ────────────────────────────────────────────────────────────────────

function usage(): string {
  return `
Billing historical-period fixture CLI (signed manifests, atomic create-only finalize)

Creates unpaid finalized invoices for explicit past UTC months. Does NOT fake
Stripe/USDC payment. Real payment: Checkout/webhook or USDC quote/claim.

Commands:
  seed      Atomic create (blank period) or verify-only match; prior signed manifest is immutable
  verify    Read-only checks against HMAC-signed manifest
  cleanup   Delete only invoice-owned created periods (requires disposable DB gate)

Options:
  --user-id <uuid>           Existing user (prefer a dedicated fixture user)
  --periods YYYY-MM,...      Past UTC months only (periodEnd+24h <= now); no auto-select
  --fixture-id <id>          Stable id [A-Za-z0-9._-], max 64
  --plan-code <code>         free|starter|growth|scale|business (default starter)
  --api-calls <n>            Posted api_call events per period (default 0, max 1000)
  --manifest <path>          Default tmp/billing-fixtures/<id>-<user>.json
  --apply                    Perform writes (default dry-run)
  --help, -h

Safety env:
  ${ENV_ENABLED}=true
  ${ENV_DB_URL}              explicit URL only (never logs the value; no DATABASE_URL fallback)
  ${ENV_MANIFEST_KEY}        HMAC secret, min ${MIN_MANIFEST_KEY_LEN} chars (never stored in file)
  ${ENV_DISPOSABLE}=true     required to delete invoices/assignments on cleanup
  NODE_ENV=development|test|staging   (script never sets NODE_ENV)

Generate a manifest key (run openssl yourself, then export the variable):
  openssl rand -hex 32
  export ${ENV_MANIFEST_KEY}   # paste the hex output as the value

Notes:
  - Does not bootstrap the plan catalog; missing canonical plan/version fails closed.
  - Historical BillingPlanAssignment rows affect plan resolution from that periodStart
    onward for the account — use a dedicated fixture user when possible.
  - Prior signed manifests are never rewritten from drifted DB state.
  - Cleanup deletes a period only when invoiceOwnedByFixture=true (created provenance).

Exit: 0 ok | 1 operational | 2 safety/config
`.trim();
}

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    help: false,
    apply: false,
    periods: [],
    planCode: DEFAULT_PLAN,
    apiCalls: DEFAULT_API_CALLS,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--user-id') args.userId = needVal(argv, ++i, '--user-id');
    else if (a === '--periods') {
      args.periods = needVal(argv, ++i, '--periods')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (a === '--fixture-id') args.fixtureId = needVal(argv, ++i, '--fixture-id');
    else if (a === '--plan-code') args.planCode = needVal(argv, ++i, '--plan-code');
    else if (a === '--api-calls') {
      const n = Number(needVal(argv, ++i, '--api-calls'));
      if (!Number.isInteger(n) || n < 0 || n > 1000) safetyFail('invalid_api_calls');
      args.apiCalls = n;
    } else if (a === '--manifest') args.manifestPath = needVal(argv, ++i, '--manifest');
    else if (a.startsWith('-')) safetyFail('unknown_flag');
    else positionals.push(a);
  }
  if (positionals.length > 1) safetyFail('unexpected_args');
  if (positionals[0]) {
    if (positionals[0] !== 'seed' && positionals[0] !== 'verify' && positionals[0] !== 'cleanup') {
      safetyFail('unknown_command');
    }
    args.command = positionals[0];
  }
  return args;
}

function needVal(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (!v || v.startsWith('-')) safetyFail(`missing_value_for_${flag.replace(/^--/, '')}`);
  return v;
}

// ── Gates ────────────────────────────────────────────────────────────────────

function requireManifestKey(): string {
  const key = process.env[ENV_MANIFEST_KEY];
  if (key === undefined || key.length < MIN_MANIFEST_KEY_LEN) safetyFail('manifest_key_required');
  if (/\s/.test(key) || /postgres(ql)?:\/\//i.test(key)) safetyFail('manifest_key_invalid');
  return key;
}

function requireApplyGates(): string {
  const reasons: string[] = [];
  if (process.env[ENV_ENABLED] !== 'true') reasons.push('enabled_flag');
  const dbUrl = process.env[ENV_DB_URL]?.trim() ?? '';
  if (!dbUrl) reasons.push('fixture_database_url');
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv || !ALLOWED_NODE_ENV.has(nodeEnv)) reasons.push('node_env');
  try {
    requireManifestKey();
  } catch {
    reasons.push('manifest_key');
  }
  if (reasons.length) safetyFail(`apply_gates_failed:${reasons.join(',')}`);
  return dbUrl;
}

function requireDbReadGates(): string {
  const dbUrl = process.env[ENV_DB_URL]?.trim();
  if (!dbUrl) safetyFail('fixture_database_url');
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv || !ALLOWED_NODE_ENV.has(nodeEnv)) safetyFail('node_env');
  requireManifestKey();
  return dbUrl;
}

function requireDisposable(): void {
  if (process.env[ENV_DISPOSABLE] !== 'true') safetyFail('disposable_db_required');
}

function requireRunnerIsolatedTarget(): void {
  // Match the established billing E2E runner identity contract. An operator
  // boolean alone is not proof that historical evidence is safe to fabricate.
  const env = process.env;
  if (
    env.BILLING_E2E_PROVISIONED !== BILLING_E2E_RUNNER_TOKEN ||
    env.BILLING_E2E_DISPOSABLE_DB !== 'true' ||
    !env.BILLING_E2E_RUN_ID ||
    !env.BILLING_E2E_EXPECTED_DATABASE ||
    !env.BILLING_E2E_EXPECTED_USER ||
    !env.BILLING_E2E_EXPECTED_OWNER ||
    !env.BILLING_E2E_APPLICATION_NAME ||
    !env.BILLING_E2E_DATABASE_URL
  ) safetyFail('runner_isolated_database_required');
  if (env[ENV_DB_URL]?.trim() !== env.BILLING_E2E_DATABASE_URL.trim()) {
    safetyFail('runner_fixture_database_mismatch');
  }
}

async function assertRunnerDatabaseIdentity(prisma: PrismaServiceType): Promise<void> {
  requireRunnerIsolatedTarget();
  const { assertBillingE2eDatabaseIdentity, BILLING_E2E_IDENTITY_SQL } =
    require('../test/billing-e2e-database') as {
      assertBillingE2eDatabaseIdentity: (target: any, query: () => Promise<unknown>) => Promise<unknown>;
      BILLING_E2E_IDENTITY_SQL: string;
    };
  const env = process.env;
  await assertBillingE2eDatabaseIdentity({
    url: env.BILLING_E2E_DATABASE_URL!,
    databaseName: env.BILLING_E2E_EXPECTED_DATABASE!,
    runId: env.BILLING_E2E_RUN_ID!,
    expectedUser: env.BILLING_E2E_EXPECTED_USER!,
    expectedOwner: env.BILLING_E2E_EXPECTED_OWNER!,
    applicationName: env.BILLING_E2E_APPLICATION_NAME!,
  }, () => prisma.$queryRawUnsafe(BILLING_E2E_IDENTITY_SQL));
}

async function assertSyntheticWalletUsage(
  tx: Tx,
  id: string | undefined,
  accountId: string,
  period: string,
): Promise<void> {
  const start = exactMonthBounds(period).start;
  const rows = await tx.billingWalletUsagePeriod.findMany({
    where: { billingAccountId: accountId, periodStart: start },
  });
  if (!id) {
    // Legacy manifests never prove ownership. Preserve their verification
    // contract without claiming/deleting any historical evidence.
    if (rows.length !== 1) opFail('wallet_usage_legacy_count');
    return;
  }
  if (rows.length !== 1 || rows[0].id !== id || rows[0].peakWalletCount !== 0 ||
      rows[0].observedAt?.getTime() !== fixtureOccurredAt(period).getTime()) {
    opFail('wallet_usage_fixture_ownership');
  }
}

// ── Period / keys / fingerprint ──────────────────────────────────────────────

function parsePeriodStrict(period: string, now: Date): PeriodParsed {
  if (!PERIOD_RE.test(period)) safetyFail('invalid_period');
  const [ys, ms] = period.split('-');
  const year = Number(ys);
  const month = Number(ms);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1) {
    safetyFail('invalid_period_calendar');
  }
  const graceEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (start.getTime() >= currentStart.getTime()) safetyFail('period_not_historical');
  if (now.getTime() < graceEnd.getTime()) safetyFail('period_in_grace_window');
  return { period, start, end };
}

function validateSeedInputs(args: CliArgs, now: Date): PeriodParsed[] {
  if (!args.userId || !UUID_RE.test(args.userId)) safetyFail('user_id_required');
  if (!args.fixtureId || !FIXTURE_ID_RE.test(args.fixtureId)) safetyFail('fixture_id_required');
  if (!args.periods.length) safetyFail('periods_required');
  if (!SELF_SERVICE_PLAN_CODES.has(args.planCode)) safetyFail('plan_code_invalid');
  const unique = [...new Set(args.periods)].sort();
  if (unique.length !== args.periods.length) safetyFail('periods_duplicate');
  return unique.map((p) => parsePeriodStrict(p, now));
}

function usageSourceKey(fixtureId: string, userId: string, period: string, n: number): string {
  return `fixture:${fixtureId}:${userId}:${period}:api:${n}`;
}

/** Exact canonical key only — rejects api:01 padding etc. */
function assertExactSourceKey(
  actual: string,
  fixtureId: string,
  userId: string,
  period: string,
  n: number,
): void {
  const expected = usageSourceKey(fixtureId, userId, period, n);
  if (actual !== expected) opFail('source_key_mismatch');
}

function fixtureUsageMetadata(fixtureId: string): Record<string, unknown> {
  return {
    fixture: true,
    fixtureId,
    fixtureSchema: MANIFEST_SCHEMA,
  };
}

function metadataExactEqual(actual: unknown, expected: Record<string, unknown>): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>;
  const ak = Object.keys(a).sort();
  const ek = Object.keys(expected).sort();
  if (ak.length !== ek.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== ek[i]) return false;
    if (a[ak[i]] !== expected[ek[i]]) return false;
  }
  return true;
}

function inputFingerprint(input: {
  fixtureId: string;
  userId: string;
  planCode: string;
  planVersionId: string;
  periods: string[];
  apiCalls: number;
}): string {
  return createHash('sha256')
    .update(
      [
        input.fixtureId,
        input.userId,
        input.planCode,
        input.planVersionId,
        input.periods.join(','),
        String(input.apiCalls),
      ].join('|'),
    )
    .digest('hex');
}

function defaultManifestPath(fixtureId: string, userId: string): string {
  return path.join('tmp', 'billing-fixtures', `${fixtureId}-${userId}.json`);
}

function formatMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function exactMonthBounds(period: string): { start: Date; end: Date } {
  const [ys, ms] = period.split('-');
  const y = Number(ys);
  const m = Number(ms);
  return {
    start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
  };
}

// ── Canonical JSON + HMAC ────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('bad_object');
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(',')}}`;
  }
  throw new TypeError('bad_value');
}

function signBody(body: Omit<FixtureManifest, 'signature'>, key: string): string {
  return createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
}

function verifySig(manifest: FixtureManifest, key: string): void {
  const { signature, ...rest } = manifest;
  if (typeof signature !== 'string' || !SHA256_HEX_RE.test(signature)) {
    safetyFail('manifest_signature_invalid');
  }
  const expected = signBody(rest, key);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) safetyFail('manifest_signature_mismatch');
}

// ── Strict manifest parse ────────────────────────────────────────────────────

function asObj(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) safetyFail(`manifest_${label}_type`);
  const p = Object.getPrototypeOf(v);
  if (p !== Object.prototype && p !== null) safetyFail(`manifest_${label}_type`);
  return v as Record<string, unknown>;
}
function asStr(v: unknown, label: string): string {
  if (typeof v !== 'string') safetyFail(`manifest_${label}_type`);
  return v;
}
function asBool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') safetyFail(`manifest_${label}_type`);
  return v;
}
function asInt(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) safetyFail(`manifest_${label}_type`);
  return v;
}

function parseAndValidateManifest(raw: unknown, key: string): FixtureManifest {
  const root = asObj(raw, 'root');
  for (const k of Object.keys(root)) {
    if (!MANIFEST_ROOT_KEYS.has(k)) safetyFail('manifest_unknown_field');
  }
  for (const req of MANIFEST_ROOT_KEYS) {
    if (!(req in root)) safetyFail('manifest_missing_field');
  }
  if (root.schema !== MANIFEST_SCHEMA) safetyFail('manifest_schema');
  if (root.version !== MANIFEST_VERSION) safetyFail('manifest_version');

  const fixtureId = asStr(root.fixtureId, 'fixtureId');
  if (!FIXTURE_ID_RE.test(fixtureId)) safetyFail('manifest_fixture_id');
  const userId = asStr(root.userId, 'userId');
  if (!UUID_RE.test(userId)) safetyFail('manifest_user_id');
  const billingAccountId = asStr(root.billingAccountId, 'billingAccountId');
  if (!UUID_RE.test(billingAccountId)) safetyFail('manifest_account_id');
  const planCode = asStr(root.planCode, 'planCode');
  if (!SELF_SERVICE_PLAN_CODES.has(planCode)) safetyFail('manifest_plan_code');
  const planVersionId = asStr(root.planVersionId, 'planVersionId');
  if (!UUID_RE.test(planVersionId)) safetyFail('manifest_plan_version_id');
  const planVersionCode = asStr(root.planVersionCode, 'planVersionCode');
  if (planVersionCode !== planCode) safetyFail('manifest_plan_code_mismatch');
  const planVersionNumber = asInt(root.planVersionNumber, 'planVersionNumber');
  if (planVersionNumber < 1) safetyFail('manifest_plan_version_number');
  const planTermsFingerprint = asStr(root.planTermsFingerprint, 'planTermsFingerprint');
  if (!SHA256_HEX_RE.test(planTermsFingerprint)) safetyFail('manifest_plan_terms_fp');
  const apiCallsPerPeriod = asInt(root.apiCallsPerPeriod, 'apiCallsPerPeriod');
  if (apiCallsPerPeriod < 0 || apiCallsPerPeriod > 1000) safetyFail('manifest_api_calls');
  const fingerprintField = asStr(root.inputFingerprint, 'inputFingerprint');
  if (!SHA256_HEX_RE.test(fingerprintField)) safetyFail('manifest_fingerprint');
  const createdAt = asStr(root.createdAt, 'createdAt');
  if (!ISO_INSTANT_RE.test(createdAt)) safetyFail('manifest_created_at');
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) safetyFail('manifest_created_at');
  const signature = asStr(root.signature, 'signature');

  if (!Array.isArray(root.periods) || root.periods.length === 0) safetyFail('manifest_periods');
  const periods: string[] = [];
  const periodSet = new Set<string>();
  for (const p of root.periods) {
    if (typeof p !== 'string' || !PERIOD_RE.test(p)) safetyFail('manifest_period_entry');
    if (periodSet.has(p)) safetyFail('manifest_period_dup');
    periodSet.add(p);
    periods.push(p);
  }
  if (periods.join(',') !== [...periods].sort().join(',')) safetyFail('manifest_periods_order');

  if (!Array.isArray(root.periodDetails)) safetyFail('manifest_period_details');
  if (root.periodDetails.length !== periods.length) safetyFail('manifest_period_details_len');

  const periodDetails: ManifestPeriod[] = [];
  const seenDetail = new Set<string>();
  const allKeys = new Set<string>();

  for (let di = 0; di < root.periodDetails.length; di++) {
    const d = asObj(root.periodDetails[di], 'periodDetail');
    for (const k of Object.keys(d)) {
      if (!MANIFEST_PERIOD_KEYS.has(k)) safetyFail('manifest_period_unknown_field');
    }
    for (const req of MANIFEST_PERIOD_KEYS) {
      if (!(req in d)) safetyFail('manifest_period_missing_field');
    }
    const period = asStr(d.period, 'period');
    if (!periodSet.has(period) || seenDetail.has(period)) safetyFail('manifest_period_set');
    seenDetail.add(period);
    if (period !== periods[di]) safetyFail('manifest_period_order');

    const bounds = exactMonthBounds(period);
    const periodStart = asStr(d.periodStart, 'periodStart');
    const periodEnd = asStr(d.periodEnd, 'periodEnd');
    if (!ISO_INSTANT_RE.test(periodStart) || !ISO_INSTANT_RE.test(periodEnd)) {
      safetyFail('manifest_period_bounds');
    }
    if (new Date(periodStart).getTime() !== bounds.start.getTime()) {
      safetyFail('manifest_period_start_ms');
    }
    if (new Date(periodEnd).getTime() !== bounds.end.getTime()) {
      safetyFail('manifest_period_end_ms');
    }

    const assignmentId = asStr(d.assignmentId, 'assignmentId');
    const invoiceId = asStr(d.invoiceId, 'invoiceId');
    if (!UUID_RE.test(assignmentId) || !UUID_RE.test(invoiceId)) safetyFail('manifest_ids');
    const assignmentOwnedByFixture = asBool(d.assignmentOwnedByFixture, 'assignmentOwned');
    const invoiceOwnedByFixture = asBool(d.invoiceOwnedByFixture, 'invoiceOwned');
    const snapshotHash = asStr(d.snapshotHash, 'snapshotHash');
    if (!SHA256_HEX_RE.test(snapshotHash)) safetyFail('manifest_snapshot_hash');
    const totalMicros = asStr(d.totalMicros, 'totalMicros');
    if (!BIGINT_STR_RE.test(totalMicros)) safetyFail('manifest_total_micros');
    const dPlan = asStr(d.planVersionId, 'dPlan');
    if (dPlan !== planVersionId) safetyFail('manifest_plan_version_drift');
    const apiCallCount = asInt(d.apiCallCount, 'apiCallCount');
    if (apiCallCount !== apiCallsPerPeriod) safetyFail('manifest_api_count_drift');
    const mode = asStr(d.mode, 'mode');
    if (mode !== 'created' && mode !== 'verified_readonly') safetyFail('manifest_mode');
    if (mode === 'verified_readonly' && (assignmentOwnedByFixture || invoiceOwnedByFixture)) {
      safetyFail('manifest_readonly_ownership');
    }
    // created mode: invoice ownership implies assignment may or may not be owned
    // but invoice-owned without created is invalid
    if (invoiceOwnedByFixture && mode !== 'created') safetyFail('manifest_owned_mode');
    const syntheticWalletUsageId = d.syntheticWalletUsageId;
    if (syntheticWalletUsageId !== undefined &&
        (typeof syntheticWalletUsageId !== 'string' || !UUID_RE.test(syntheticWalletUsageId))) {
      safetyFail('manifest_wallet_usage_id');
    }
    if (syntheticWalletUsageId !== undefined && mode !== 'created') {
      safetyFail('manifest_wallet_usage_ownership');
    }

    if (!Array.isArray(d.usageSourceKeys) || d.usageSourceKeys.length !== apiCallCount) {
      safetyFail('manifest_usage_keys');
    }
    const usageSourceKeys: string[] = [];
    for (let n = 1; n <= apiCallCount; n++) {
      const sk = d.usageSourceKeys[n - 1];
      if (typeof sk !== 'string') safetyFail('manifest_usage_key_type');
      assertExactSourceKey(sk, fixtureId, userId, period, n);
      if (allKeys.has(sk)) safetyFail('manifest_usage_key_dup');
      allKeys.add(sk);
      usageSourceKeys.push(sk);
    }

    periodDetails.push({
      period,
      periodStart: bounds.start.toISOString(),
      periodEnd: bounds.end.toISOString(),
      assignmentId,
      assignmentOwnedByFixture,
      invoiceId,
      invoiceOwnedByFixture,
      snapshotHash,
      totalMicros,
      planVersionId: dPlan,
      usageSourceKeys,
      apiCallCount,
      mode: mode as PeriodMode,
      ...(syntheticWalletUsageId === undefined ? {} : { syntheticWalletUsageId }),
    });
  }

  const expectedFp = inputFingerprint({
    fixtureId,
    userId,
    planCode,
    planVersionId,
    periods,
    apiCalls: apiCallsPerPeriod,
  });
  if (expectedFp !== fingerprintField) safetyFail('manifest_fingerprint_mismatch');

  const text = JSON.stringify(root);
  if (/sk_(live|test)_|whsec_|postgres(ql)?:\/\//i.test(text))
    safetyFail('manifest_secret_content');

  const manifest: FixtureManifest = {
    schema: MANIFEST_SCHEMA,
    version: MANIFEST_VERSION,
    fixtureId,
    userId,
    billingAccountId,
    planCode,
    planVersionId,
    planVersionCode,
    planVersionNumber,
    planTermsFingerprint,
    periods,
    apiCallsPerPeriod,
    inputFingerprint: fingerprintField,
    createdAt,
    periodDetails,
    signature,
  };
  verifySig(manifest, key);
  return manifest;
}

function readSignedManifest(filePath: string, key: string): FixtureManifest {
  if (!fs.existsSync(filePath)) opFail('manifest_not_found');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    opFail('manifest_json_invalid');
  }
  return parseAndValidateManifest(raw, key);
}

/**
 * Atomic exclusive publish: never clobber an existing target.
 * temp file (0600) → link(tmp, target) → unlink(tmp). EEXIST = fail closed.
 */
function writeSignedManifestExclusive(
  filePath: string,
  body: Omit<FixtureManifest, 'signature'>,
  key: string,
): void {
  const signature = signBody(body, key);
  const full: FixtureManifest = { ...body, signature };
  parseAndValidateManifest(JSON.parse(JSON.stringify(full)), key);

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const { decideManifestPublish } =
    require('../src/modules/billing/billing-fixture-usage-evidence') as {
      decideManifestPublish: (exists: boolean) => 'write_exclusive' | 'fail_exists';
    };
  if (decideManifestPublish(fs.existsSync(filePath)) === 'fail_exists') opFail('manifest_exists');

  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(full, null, 2)}\n`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(tmp, filePath);
    } catch (linkErr: unknown) {
      const code = (linkErr as NodeJS.ErrnoException)?.code;
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (code === 'EEXIST') opFail('manifest_exists');
      opFail('manifest_publish_failed');
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort tmp cleanup after successful link */
    }
  } catch (err: unknown) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (err instanceof FixtureError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') opFail('manifest_exists');
    opFail('manifest_write_failed');
  }
}

/** Digest of plan monetary/quota terms + ordered tier rows (read-only catalog integrity). */
function computePlanTermsFingerprint(pv: {
  id: string;
  code: string;
  version: number;
  name: string;
  monthlyFeeMicros: bigint | null;
  includedOutboundMicros: bigint | null;
  includedApiCalls: bigint | null;
  includedWallets: number | null;
  apiOverageRateMicros: bigint;
  walletOverageRateMicros: bigint;
  tiers: Array<{
    lowerBoundMicros: bigint;
    upperBoundMicros: bigint | null;
    ratePpm: number;
  }>;
}): string {
  const orderedTiers = [...pv.tiers].sort((a, b) =>
    a.lowerBoundMicros < b.lowerBoundMicros ? -1 : a.lowerBoundMicros > b.lowerBoundMicros ? 1 : 0,
  );
  const payload = {
    id: pv.id,
    code: pv.code,
    version: pv.version,
    name: pv.name,
    monthlyFeeMicros: pv.monthlyFeeMicros === null ? null : pv.monthlyFeeMicros.toString(),
    includedOutboundMicros:
      pv.includedOutboundMicros === null ? null : pv.includedOutboundMicros.toString(),
    includedApiCalls: pv.includedApiCalls === null ? null : pv.includedApiCalls.toString(),
    includedWallets: pv.includedWallets,
    apiOverageRateMicros: pv.apiOverageRateMicros.toString(),
    walletOverageRateMicros: pv.walletOverageRateMicros.toString(),
    tiers: orderedTiers.map((t) => ({
      lowerBoundMicros: t.lowerBoundMicros.toString(),
      upperBoundMicros: t.upperBoundMicros === null ? null : t.upperBoundMicros.toString(),
      ratePpm: t.ratePpm,
    })),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

async function loadPlanWithTiers(
  prisma: PrismaServiceType | Tx,
  planVersionId: string,
): Promise<{
  id: string;
  code: string;
  version: number;
  name: string;
  monthlyFeeMicros: bigint | null;
  includedOutboundMicros: bigint | null;
  includedApiCalls: bigint | null;
  includedWallets: number | null;
  apiOverageRateMicros: bigint;
  walletOverageRateMicros: bigint;
  tiers: Array<{
    lowerBoundMicros: bigint;
    upperBoundMicros: bigint | null;
    ratePpm: number;
  }>;
}> {
  const pv = await prisma.billingPlanVersion.findUnique({
    where: { id: planVersionId },
    include: { tiers: true },
  });
  if (!pv) opFail('plan_version_missing');
  return {
    id: pv.id,
    code: pv.code,
    version: pv.version,
    name: pv.name,
    monthlyFeeMicros: pv.monthlyFeeMicros,
    includedOutboundMicros: pv.includedOutboundMicros,
    includedApiCalls: pv.includedApiCalls,
    includedWallets: pv.includedWallets,
    apiOverageRateMicros: pv.apiOverageRateMicros,
    walletOverageRateMicros: pv.walletOverageRateMicros,
    tiers: pv.tiers.map((t) => ({
      lowerBoundMicros: t.lowerBoundMicros,
      upperBoundMicros: t.upperBoundMicros,
      ratePpm: t.ratePpm,
    })),
  };
}

// ── Prisma ───────────────────────────────────────────────────────────────────

async function openBilling(dbUrl: string): Promise<{
  prisma: PrismaServiceType;
  billing: BillingServiceType;
  close: () => Promise<void>;
}> {
  process.env.DATABASE_URL = dbUrl;
  const { PrismaService } = require('../src/core/database/prisma.service') as {
    PrismaService: new () => PrismaServiceType;
  };
  const { BillingService } = require('../src/modules/billing/billing.service') as {
    BillingService: new (prisma: PrismaServiceType) => BillingServiceType;
  };
  const prisma = new PrismaService();
  await prisma.$connect();
  return {
    prisma,
    billing: new BillingService(prisma),
    close: async () => {
      await prisma.$disconnect();
    },
  };
}

async function withPeriodTx<T>(
  prisma: PrismaServiceType,
  accountId: string,
  periodStart: Date,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { acquireBillingPeriodAdvisoryLock } =
    require('../src/modules/billing/billing-period-lock') as {
      acquireBillingPeriodAdvisoryLock: (tx: Tx, id: string, start: Date) => Promise<void>;
    };
  const { Prisma } = require('@prisma/client') as typeof import('@prisma/client');
  return prisma.$transaction(
    async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, accountId, periodStart);
      return work(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 30_000,
    },
  );
}

function hasPaymentEvidence(inv: {
  paidAt: Date | null;
  paidVia?: string | null;
  settlementAttemptId: string | null;
  stripeInvoiceId: string | null;
  allocatedMicros: bigint;
  paymentAttempts?: unknown[];
}): string | null {
  if (inv.paidAt) return 'paidAt';
  if (inv.paidVia) return 'paidVia';
  if (inv.settlementAttemptId) return 'settlementAttemptId';
  if (inv.stripeInvoiceId) return 'stripeInvoiceId';
  if (inv.allocatedMicros !== 0n) return 'allocatedMicros';
  if (inv.paymentAttempts && inv.paymentAttempts.length > 0) return 'paymentAttempts';
  return null;
}

/** Canonical fixture occurredAt: UTC 15th 12:00:00.000 of the period month. */
function fixtureOccurredAt(period: string): Date {
  const bounds = exactMonthBounds(period);
  return new Date(
    Date.UTC(bounds.start.getUTCFullYear(), bounds.start.getUTCMonth(), 15, 12, 0, 0, 0),
  );
}

async function assertUsageExact(
  row: Record<string, unknown> & {
    id?: string;
    billingAccountId: string;
    metric: string;
    entryType: string;
    sourceType: string;
    status: string;
    quantity: bigint;
    volumeUsdMicros: bigint;
    periodStart: Date;
    occurredAt?: Date;
    planVersionId: string | null;
    metadata: unknown;
    sourceKey: string;
  },
  exp: {
    accountId: string;
    fixtureId: string;
    userId: string;
    period: string;
    planVersionId: string;
    n: number;
  },
): Promise<void> {
  assertExactSourceKey(row.sourceKey, exp.fixtureId, exp.userId, exp.period, exp.n);
  if (row.billingAccountId !== exp.accountId) opFail('usage_account');
  if (row.metric !== 'api_call' || row.entryType !== 'usage' || row.sourceType !== 'api_request') {
    opFail('usage_type');
  }
  if (row.status !== 'posted') opFail('usage_status');
  if (row.quantity !== 1n || row.volumeUsdMicros !== 0n) opFail('usage_quantity');
  const bounds = exactMonthBounds(exp.period);
  if (row.periodStart.getTime() !== bounds.start.getTime()) opFail('usage_period_start');
  if (row.planVersionId !== exp.planVersionId) opFail('usage_plan');
  if (!metadataExactEqual(row.metadata, fixtureUsageMetadata(exp.fixtureId))) {
    opFail('usage_metadata');
  }
  const expectedOccurred = fixtureOccurredAt(exp.period);
  if (!row.occurredAt || !(row.occurredAt instanceof Date)) opFail('usage_occurred_at');
  if (row.occurredAt.getTime() !== expectedOccurred.getTime()) opFail('usage_occurred_at');

  const { assertUsageEvidenceAllNull } =
    require('../src/modules/billing/billing-fixture-usage-evidence') as {
      assertUsageEvidenceAllNull: (r: Record<string, unknown>) => { ok: boolean; field?: string };
    };
  const ev = assertUsageEvidenceAllNull(row);
  if (!ev.ok) opFail(`usage_evidence_${ev.field ?? 'unknown'}`);
}

/** Fail closed if other usage rows reverse/adjust this fixture row (SetNull on delete). */
async function assertUsageNoDependents(tx: Tx, usageId: string): Promise<void> {
  const deps = await tx.billingUsageEvent.count({
    where: {
      OR: [{ reversalOfId: usageId }, { adjustmentOfId: usageId }],
    },
  });
  if (deps > 0) opFail('usage_has_dependents');
}

/**
 * All usage rows for account+period must be exactly the expected fixture keys
 * (no foreign outbound/api/other fixture rows). apiCalls=0 ⇒ zero usage rows.
 */
async function assertPeriodUsageExclusive(
  tx: Tx,
  args: {
    accountId: string;
    fixtureId: string;
    userId: string;
    period: string;
    planVersionId: string;
    expectedKeys: string[];
  },
): Promise<void> {
  const bounds = exactMonthBounds(args.period);
  const all = await tx.billingUsageEvent.findMany({
    where: { billingAccountId: args.accountId, periodStart: bounds.start },
  });
  if (all.length !== args.expectedKeys.length) opFail('usage_period_count');
  const byKey = new Map(all.map((r) => [r.sourceKey, r]));
  for (let n = 1; n <= args.expectedKeys.length; n++) {
    const sk = args.expectedKeys[n - 1];
    const row = byKey.get(sk);
    if (!row) opFail('usage_period_missing_key');
    await assertUsageExact(row, {
      accountId: args.accountId,
      fixtureId: args.fixtureId,
      userId: args.userId,
      period: args.period,
      planVersionId: args.planVersionId,
      n,
    });
  }
}

function asSnapRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) opFail('invoice_snapshot');
  return v as Record<string, unknown>;
}

function asSnapNested(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) opFail(`invoice_snapshot_${label}`);
  return v as Record<string, unknown>;
}

function requireBigintField(inv: Record<string, unknown>, field: string): bigint {
  const v = inv[field];
  if (typeof v !== 'bigint') opFail(`invoice_field_type_${field}`);
  return v;
}

function requireNullableBigintField(inv: Record<string, unknown>, field: string): bigint | null {
  const v = inv[field];
  if (v === null) return null;
  if (typeof v !== 'bigint') opFail(`invoice_field_type_${field}`);
  return v;
}

function requireIntField(inv: Record<string, unknown>, field: string): number {
  const v = inv[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) opFail(`invoice_field_type_${field}`);
  return v;
}

async function assertInvoiceSnapshot(
  invIn: Record<string, unknown> & {
    status: string;
    currency: string;
    planVersionId: string;
    periodStart: Date;
    periodEnd: Date;
    snapshotHash: string;
    snapshotJson: unknown;
    lines: Array<Record<string, unknown>>;
    paidAt: Date | null;
    paidVia?: string | null;
    settlementAttemptId: string | null;
    stripeInvoiceId: string | null;
    paymentAttempts?: unknown[];
  },
  exp: {
    period: string;
    planVersionId: string;
    planCode: string;
    planName: string;
    planVersionNumber: number;
    apiCalls: number;
    /** Pinned plan terms — required non-null for self-service fixture plans. */
    planTerms: {
      monthlyFeeMicros: bigint;
      includedOutboundMicros: bigint;
      includedApiCalls: bigint;
      includedWallets: number;
      apiOverageRateMicros: bigint;
      walletOverageRateMicros: bigint;
    };
    totalMicros?: string;
    snapshotHash?: string;
  },
  canonicalBillingJson: (v: unknown) => string,
): Promise<void> {
  const { microsToDecimalUsd } = require('../src/modules/billing/billing.utils') as {
    microsToDecimalUsd: (m: bigint) => string;
  };
  const { calculateInvoiceTotals } = require('../src/modules/billing/billing-calculator') as {
    calculateInvoiceTotals: (input: unknown) => {
      monthlyFeeMicros: bigint;
      billableOutboundMicros: bigint;
      outboundOverageMicros: bigint;
      apiOverageMicros: bigint;
      walletOverageMicros: bigint;
      totalMicros: bigint;
      outboundTiers: Array<{
        upperBoundMicros: bigint | null;
        ratePpm: number;
        volumeMicros: bigint;
        feeMicros: bigint;
      }>;
    };
  };
  const { buildInvoiceLineSpecs, planVersionToConfig } =
    require('../src/modules/billing/billing.service') as {
      buildInvoiceLineSpecs: (args: unknown) => Array<{
        lineType: string;
        description: string;
        quantity: bigint;
        unitRatePpm: number | null;
        unitAmountMicros: bigint | null;
        amountMicros: bigint;
      }>;
      planVersionToConfig: (pv: unknown) => {
        id: string;
        name: string;
        monthlyFeeMicros: bigint | null;
        includedOutboundMicros: bigint | null;
        includedWallets: number | null;
        includedApiCallsPerMonth: number | null;
      };
    };
  const { compareLineMultisets } =
    require('../src/modules/billing/billing-fixture-line-multiset') as {
      compareLineMultisets: (
        actual: Array<Record<string, unknown>>,
        expected: Array<{
          lineType: string;
          description: string;
          quantity: bigint;
          unitRatePpm: number | null;
          unitAmountMicros: bigint | null;
          amountMicros: bigint;
        }>,
      ) => { ok: boolean; reason?: string };
    };

  const inv = invIn as Record<string, unknown> & typeof invIn;
  if (inv.status !== 'finalized') opFail('invoice_status');
  if (inv.currency !== 'USD') opFail('invoice_currency');
  if (inv.planVersionId !== exp.planVersionId) opFail('invoice_plan');
  const bounds = exactMonthBounds(exp.period);
  if (!(inv.periodStart instanceof Date) || inv.periodStart.getTime() !== bounds.start.getTime()) {
    opFail('invoice_period_start');
  }
  if (!(inv.periodEnd instanceof Date) || inv.periodEnd.getTime() !== bounds.end.getTime()) {
    opFail('invoice_period_end');
  }
  const pay = hasPaymentEvidence(inv as any);
  if (pay) opFail(`invoice_payment_${pay}`);

  const totalMicros = requireBigintField(inv, 'totalMicros');
  const apiCallsCol = requireBigintField(inv, 'apiCalls');
  const grossOutbound = requireBigintField(inv, 'grossOutboundMicros');
  const billableOutbound = requireBigintField(inv, 'billableOutboundMicros');
  const monthlyFee = requireBigintField(inv, 'monthlyFeeMicros');
  const outboundOverage = requireBigintField(inv, 'outboundOverageMicros');
  const apiOverage = requireBigintField(inv, 'apiOverageMicros');
  const walletOverage = requireBigintField(inv, 'walletOverageMicros');
  const allocated = requireBigintField(inv, 'allocatedMicros');
  // Self-service fixture plans: included* must be non-null and equal pinned plan.
  const includedOutbound = requireNullableBigintField(inv, 'includedOutboundMicros');
  const includedApi = requireNullableBigintField(inv, 'includedApiCalls');
  if (includedOutbound === null) opFail('invoice_included_outbound_null');
  if (includedApi === null) opFail('invoice_included_api_null');
  if (includedOutbound !== exp.planTerms.includedOutboundMicros) {
    opFail('invoice_included_outbound');
  }
  if (includedApi !== exp.planTerms.includedApiCalls) opFail('invoice_included_api');
  const includedWallets = inv.includedWallets;
  if (typeof includedWallets !== 'number' || !Number.isInteger(includedWallets)) {
    opFail('invoice_included_wallets_type');
  }
  if (includedWallets !== exp.planTerms.includedWallets) opFail('invoice_included_wallets');
  const activeWallets = requireIntField(inv, 'activeWallets');

  if (allocated !== 0n) opFail('invoice_allocated');
  // Fixture usage is api-only: outbound columns must be zero.
  if (grossOutbound !== 0n) opFail('invoice_gross_outbound');
  if (billableOutbound !== 0n) opFail('invoice_billable_outbound');
  if (outboundOverage !== 0n) opFail('invoice_outbound_overage');
  if (apiOverage !== 0n) opFail('invoice_api_overage');
  if (apiCallsCol !== BigInt(exp.apiCalls)) opFail('invoice_api_calls');
  if (monthlyFee !== exp.planTerms.monthlyFeeMicros) opFail('invoice_monthly_fee');
  if (exp.totalMicros !== undefined && totalMicros.toString() !== exp.totalMicros) {
    opFail('invoice_total');
  }

  // Recompute using **pinned DB terms** (planVersionToConfig), never static PLANS fees.
  const planConfig = planVersionToConfig({
    id: exp.planVersionId,
    code: exp.planCode,
    name: exp.planName,
    version: exp.planVersionNumber,
    monthlyFeeMicros: exp.planTerms.monthlyFeeMicros,
    includedOutboundMicros: exp.planTerms.includedOutboundMicros,
    includedApiCalls: exp.planTerms.includedApiCalls,
    includedWallets: exp.planTerms.includedWallets,
    apiOverageRateMicros: exp.planTerms.apiOverageRateMicros,
    walletOverageRateMicros: exp.planTerms.walletOverageRateMicros,
    description: null,
    includedTeamMembers: null,
    effectiveFrom: new Date(0),
    createdAt: new Date(0),
  });
  const totals = calculateInvoiceTotals({
    plan: planConfig,
    grossOutboundMicros: grossOutbound,
    activeWallets,
    apiCallsTotal: exp.apiCalls,
    apiOverageRateMicros: exp.planTerms.apiOverageRateMicros,
    walletOverageRateMicros: exp.planTerms.walletOverageRateMicros,
  });
  if (totals.totalMicros !== totalMicros) opFail('invoice_total_vs_calculator');
  if (totals.monthlyFeeMicros !== monthlyFee) opFail('invoice_fee_vs_calculator');
  if (totals.walletOverageMicros !== walletOverage) opFail('invoice_wallet_overage_vs_calculator');

  const expectedLines = buildInvoiceLineSpecs({
    planVersionName: exp.planName,
    plan: planConfig,
    apiCalls: exp.apiCalls,
    activeWallets,
    totals,
    apiOverageRateMicros: exp.planTerms.apiOverageRateMicros,
    walletOverageRateMicros: exp.planTerms.walletOverageRateMicros,
  });
  if (!Array.isArray(inv.lines)) opFail('invoice_lines_missing');
  // Order-independent multiset: duplicate counts matter; field drift / extras fail.
  const multi = compareLineMultisets(inv.lines, expectedLines);
  if (!multi.ok) opFail(`invoice_lines_${multi.reason ?? 'mismatch'}`);

  const recomputed = createHash('sha256')
    .update(canonicalBillingJson(inv.snapshotJson))
    .digest('hex');
  if (recomputed !== inv.snapshotHash) opFail('invoice_hash');
  if (exp.snapshotHash !== undefined && inv.snapshotHash !== exp.snapshotHash) {
    opFail('invoice_hash_manifest');
  }

  const snap = asSnapRecord(inv.snapshotJson);
  if (snap.version !== 1) opFail('invoice_snapshot_version');
  if (snap.period !== exp.period) opFail('invoice_snapshot_period');
  if (snap.planVersionId !== exp.planVersionId) opFail('invoice_snapshot_plan_id');

  const plan = asSnapNested(snap.plan, 'plan');
  if (plan.code !== exp.planCode) opFail('invoice_snapshot_plan_code');
  if (plan.name !== exp.planName) opFail('invoice_snapshot_plan_name');
  if (plan.version !== exp.planVersionNumber) opFail('invoice_snapshot_plan_version');
  if (plan.monthlyFeeMicros !== microsToDecimalUsd(exp.planTerms.monthlyFeeMicros)) {
    opFail('invoice_snapshot_plan_fee');
  }
  if (plan.includedOutboundMicros !== microsToDecimalUsd(exp.planTerms.includedOutboundMicros)) {
    opFail('invoice_snapshot_plan_included_out');
  }
  if (plan.includedApiCalls !== String(exp.planTerms.includedApiCalls)) {
    opFail('invoice_snapshot_plan_included_api');
  }
  if (plan.includedWallets !== exp.planTerms.includedWallets) {
    opFail('invoice_snapshot_plan_included_wallets');
  }
  if (plan.apiOverageRateMicros !== microsToDecimalUsd(exp.planTerms.apiOverageRateMicros)) {
    opFail('invoice_snapshot_plan_api_rate');
  }
  // Catalog terms are immutable input; the invoice snapshot records the
  // applied policy. Wallet overage is disabled for finalized invoices.
  if (plan.walletOverageRateMicros !== '0') opFail('invoice_snapshot_plan_wallet_rate');

  const usage = asSnapNested(snap.usage, 'usage');
  if (usage.apiCalls !== String(exp.apiCalls)) opFail('invoice_snapshot_api_calls');
  if (usage.outboundVolumeMicros !== '0') opFail('invoice_snapshot_outbound');
  if (usage.activeWallets !== activeWallets) opFail('invoice_snapshot_wallets');

  const amounts = asSnapNested(snap.amounts, 'amounts');
  if (typeof amounts.totalMicros !== 'string') opFail('invoice_snapshot_amounts_type');
  if (amounts.totalMicros !== microsToDecimalUsd(totalMicros)) opFail('invoice_snapshot_total');
  if (amounts.monthlyFeeMicros !== microsToDecimalUsd(monthlyFee)) opFail('invoice_snapshot_fee');
  if (amounts.billableOutboundMicros !== microsToDecimalUsd(billableOutbound)) {
    opFail('invoice_snapshot_billable');
  }
  if (amounts.outboundOverageMicros !== microsToDecimalUsd(outboundOverage)) {
    opFail('invoice_snapshot_out_overage');
  }
  if (amounts.apiOverageMicros !== microsToDecimalUsd(apiOverage)) {
    opFail('invoice_snapshot_api_overage');
  }
  if (amounts.walletOverageMicros !== microsToDecimalUsd(walletOverage)) {
    opFail('invoice_snapshot_wallet_overage');
  }

  // Snapshot tiers must match calculator outbound tier breakdown exactly.
  if (!Array.isArray(snap.tiers)) opFail('invoice_snapshot_tiers_type');
  const snapTiers = snap.tiers as Array<Record<string, unknown>>;
  if (snapTiers.length !== totals.outboundTiers.length) opFail('invoice_snapshot_tiers_count');
  for (let i = 0; i < totals.outboundTiers.length; i++) {
    const t = totals.outboundTiers[i];
    const st = snapTiers[i];
    const wantUpper = t.upperBoundMicros === null ? null : microsToDecimalUsd(t.upperBoundMicros);
    if (st.upperBoundMicros !== wantUpper) opFail('invoice_snapshot_tier_upper');
    if (st.ratePpm !== t.ratePpm) opFail('invoice_snapshot_tier_rate');
    if (st.volumeMicros !== microsToDecimalUsd(t.volumeMicros)) opFail('invoice_snapshot_tier_vol');
    if (st.feeMicros !== microsToDecimalUsd(t.feeMicros)) opFail('invoice_snapshot_tier_fee');
  }
}

/** Plan version identity must match manifest (id + code + version + name). */
function assertPlanVersionIdentity(
  pv: { id: string; code: string; version: number; name: string },
  exp: { planVersionId: string; planCode: string; planVersionNumber: number; planName?: string },
): void {
  if (pv.id !== exp.planVersionId) opFail('plan_version_id');
  if (pv.code !== exp.planCode) opFail('plan_version_code');
  if (pv.version !== exp.planVersionNumber) opFail('plan_version_number');
  if (exp.planName !== undefined && pv.name !== exp.planName) opFail('plan_version_name');
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function cmdSeed(args: CliArgs): Promise<void> {
  const now = new Date();
  const periods = validateSeedInputs(args, now);
  const fixtureId = args.fixtureId!;
  const userId = args.userId!;
  const planCode = args.planCode;
  const apiCalls = args.apiCalls;
  const manifestPath = args.manifestPath ?? defaultManifestPath(fixtureId, userId);

  const isDefaultManifest = !args.manifestPath;
  logInfo('=== billing-fixture seed ===');
  logInfo(`mode: ${args.apply ? 'APPLY' : 'dry-run'}`);
  logInfo(`fixtureId: ${safeIdTag('fixture', fixtureId)}`);
  logInfo(`userId: ${safeIdTag('user', userId)}`);
  logInfo(`planCode: ${SELF_SERVICE_PLAN_CODES.has(planCode) ? planCode : '<plan>'}`);
  logInfo(`apiCalls/period: ${apiCalls}`);
  logInfo(`periods: ${periods.map((p) => p.period).join(',')}`);
  logInfo(`manifest: ${safeManifestLabel(manifestPath, isDefaultManifest)}`);
  logInfo(
    `NODE_ENV: ${process.env.NODE_ENV && ALLOWED_NODE_ENV.has(process.env.NODE_ENV) ? 'allowed' : 'disallowed-or-unset'}`,
  );
  logInfo(`DB URL env: ${process.env[ENV_DB_URL]?.trim() ? 'set' : 'unset'}`);
  logInfo(`manifest key: ${process.env[ENV_MANIFEST_KEY] ? 'set' : 'unset'}`);

  if (!args.apply) {
    logInfo('Dry-run only (no DB, no manifest write). See --help for apply gates.');
    return;
  }

  const dbUrl = requireApplyGates();
  const manifestKey = requireManifestKey();
  const { prisma, billing, close } = await openBilling(dbUrl);
  const { canonicalBillingJson } = require('../src/modules/billing/billing-json') as {
    canonicalBillingJson: (v: unknown) => string;
  };

  try {
    await assertRunnerDatabaseIdentity(prisma);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) opFail('user_not_found');

    // Prior signed manifest: immutable — no writes until full lock-in baseline OK.
    let prior: FixtureManifest | null = null;
    if (fs.existsSync(manifestPath)) {
      prior = readSignedManifest(manifestPath, manifestKey);
      if (prior.fixtureId !== fixtureId || prior.userId !== userId) {
        safetyFail('prior_identity_mismatch');
      }
      if (prior.planCode !== planCode) safetyFail('prior_plan_code_mismatch');
      if (prior.apiCallsPerPeriod !== apiCalls) safetyFail('prior_api_calls_mismatch');
      if (prior.periods.join(',') !== periods.map((p) => p.period).join(',')) {
        safetyFail('prior_periods_mismatch');
      }
    }

    // Resolve plan version without catalog bootstrap; pin terms/tiers fingerprint.
    let planVersionId: string;
    if (prior) {
      planVersionId = prior.planVersionId;
    } else {
      const pv = await prisma.billingPlanVersion.findFirst({
        where: { code: planCode },
        orderBy: { version: 'desc' },
      });
      if (!pv) opFail('plan_version_missing');
      planVersionId = pv.id;
    }
    const planWithTiers = await loadPlanWithTiers(prisma, planVersionId);
    assertPlanVersionIdentity(planWithTiers, {
      planVersionId: prior ? prior.planVersionId : planWithTiers.id,
      planCode: prior ? prior.planCode : planCode,
      planVersionNumber: prior ? prior.planVersionNumber : planWithTiers.version,
    });
    if (planWithTiers.code !== planCode) opFail('plan_code_mismatch');
    if (
      planWithTiers.monthlyFeeMicros === null ||
      planWithTiers.includedApiCalls === null ||
      planWithTiers.includedWallets === null ||
      planWithTiers.includedOutboundMicros === null
    ) {
      opFail('plan_terms_null');
    }
    if (planWithTiers.tiers.length === 0) opFail('plan_tiers_missing');
    const planTermsFp = computePlanTermsFingerprint(planWithTiers);
    const planVersion = planWithTiers;

    const fingerprint = inputFingerprint({
      fixtureId,
      userId,
      planCode,
      planVersionId: planVersion.id,
      periods: periods.map((p) => p.period),
      apiCalls,
    });
    if (prior && prior.inputFingerprint !== fingerprint) safetyFail('prior_fingerprint_mismatch');
    if (prior && prior.planVersionId !== planVersion.id) safetyFail('prior_plan_version_id');
    if (prior && prior.planVersionNumber !== planVersion.version) {
      safetyFail('prior_plan_version_number');
    }
    if (prior && prior.planVersionCode !== planVersion.code) safetyFail('prior_plan_version_code');
    if (prior && prior.planTermsFingerprint !== planTermsFp) {
      safetyFail('prior_plan_terms_fingerprint');
    }

    logInfo(
      `planVersion: ${SELF_SERVICE_PLAN_CODES.has(planVersion.code) ? planVersion.code : '<plan>'}@v${planVersion.version}`,
    );
    logInfo('fingerprint: <sha256>');

    // Account: with prior, must already match — never create/overwrite.
    let account = await prisma.billingAccount.findUnique({ where: { userId } });
    if (prior) {
      if (!account || account.id !== prior.billingAccountId) opFail('prior_account_mismatch');
      if (account.currency !== 'USD') opFail('account_currency');
    } else {
      if (!account) {
        account = await prisma.billingAccount.create({ data: { userId, currency: 'USD' } });
      }
      if (account.currency !== 'USD') opFail('account_currency');
    }

    // PRIOR PATH: lock-in baseline only — never re-sign or rewrite the manifest file.
    if (prior) {
      for (const d of prior.periodDetails) {
        const bounds = exactMonthBounds(d.period);
        await withPeriodTx(prisma, account.id, bounds.start, async (tx) => {
          await assertPriorBaseline(tx, prior!, d, account!.id, planVersion, canonicalBillingJson);
        });
      }
      logInfo('Prior manifest verified against DB; file unchanged (no rewrite).');
      return;
    }

    // CREATE / VERIFY-ONLY without prior
    const periodDetails: ManifestPeriod[] = [];
    for (const p of periods) {
      const detail = await seedPeriodAtomic({
        prisma,
        billing,
        accountId: account.id,
        userId,
        fixtureId,
        planVersion,
        period: p,
        apiCalls,
        canonicalBillingJson,
      });
      periodDetails.push(detail);
    }

    // Target must not appear mid-run (no-clobber exclusive publish).
    if (fs.existsSync(manifestPath)) opFail('manifest_exists');

    const body: Omit<FixtureManifest, 'signature'> = {
      schema: MANIFEST_SCHEMA,
      version: MANIFEST_VERSION,
      fixtureId,
      userId,
      billingAccountId: account.id,
      planCode,
      planVersionId: planVersion.id,
      planVersionCode: planVersion.code,
      planVersionNumber: planVersion.version,
      planTermsFingerprint: planTermsFp,
      periods: periods.map((x) => x.period),
      apiCallsPerPeriod: apiCalls,
      inputFingerprint: fingerprint,
      createdAt: new Date().toISOString(),
      periodDetails,
    };
    writeSignedManifestExclusive(manifestPath, body, manifestKey);
    logInfo(`Seed complete: ${safeManifestLabel(manifestPath, isDefaultManifest)}`);
    for (const d of periodDetails) {
      logInfo(
        `  ${d.period} mode=${d.mode} invOwned=${d.invoiceOwnedByFixture} asgOwned=${d.assignmentOwnedByFixture}`,
      );
    }
  } finally {
    await close();
  }
}

async function assertPriorBaseline(
  tx: Tx,
  prior: FixtureManifest,
  d: ManifestPeriod,
  accountId: string,
  planVersion: { id: string; code: string; version: number; name: string },
  canonicalBillingJson: (v: unknown) => string,
): Promise<void> {
  const bounds = exactMonthBounds(d.period);

  assertPlanVersionIdentity(planVersion, {
    planVersionId: prior.planVersionId,
    planCode: prior.planCode,
    planVersionNumber: prior.planVersionNumber,
  });
  if (d.planVersionId !== prior.planVersionId) opFail('prior_detail_plan_drift');

  const inv = await tx.billingInvoice.findUnique({
    where: { id: d.invoiceId },
    include: { lines: true, paymentAttempts: true },
  });
  if (!inv) opFail('prior_invoice_missing');
  if (inv.billingAccountId !== accountId || inv.billingAccountId !== prior.billingAccountId) {
    opFail('prior_invoice_account');
  }
  const byPeriod = await tx.billingInvoice.findFirst({
    where: { billingAccountId: accountId, periodStart: bounds.start, purpose: 'usage_period' },
  });
  if (!byPeriod || byPeriod.id !== d.invoiceId) opFail('prior_invoice_id_drift');

  await assertInvoiceSnapshot(
    inv,
    {
      period: d.period,
      planVersionId: d.planVersionId,
      planCode: prior.planCode,
      planName: planVersion.name,
      planVersionNumber: prior.planVersionNumber,
      apiCalls: d.apiCallCount,
      planTerms: planTermsFromPinned(planVersion as any),
      totalMicros: d.totalMicros,
      snapshotHash: d.snapshotHash,
    },
    canonicalBillingJson,
  );

  const asg = await tx.billingPlanAssignment.findUnique({ where: { id: d.assignmentId } });
  if (!asg) opFail('prior_assignment_missing');
  if (asg.billingAccountId !== accountId) opFail('prior_assignment_account');
  if (asg.planVersionId !== d.planVersionId) opFail('prior_assignment_plan');
  if (asg.periodStart.getTime() !== bounds.start.getTime()) opFail('prior_assignment_period');

  await assertPeriodUsageExclusive(tx, {
    accountId,
    fixtureId: prior.fixtureId,
    userId: prior.userId,
    period: d.period,
    planVersionId: d.planVersionId,
    expectedKeys: d.usageSourceKeys,
  });
  await assertSyntheticWalletUsage(tx, d.syntheticWalletUsageId, accountId, d.period);
}

async function seedPeriodAtomic(args: {
  prisma: PrismaServiceType;
  billing: BillingServiceType;
  accountId: string;
  userId: string;
  fixtureId: string;
  planVersion: { id: string; code: string; version: number; name: string };
  period: PeriodParsed;
  apiCalls: number;
  canonicalBillingJson: (v: unknown) => string;
}): Promise<ManifestPeriod> {
  const {
    prisma,
    billing,
    accountId,
    userId,
    fixtureId,
    planVersion,
    period,
    apiCalls,
    canonicalBillingJson,
  } = args;
  const usageKeys = Array.from({ length: apiCalls }, (_, i) =>
    usageSourceKey(fixtureId, userId, period.period, i + 1),
  );
  const midMonth = fixtureOccurredAt(period.period);
  const meta = fixtureUsageMetadata(fixtureId);

  return withPeriodTx(prisma, accountId, period.start, async (tx) => {
    const existingInv = await tx.billingInvoice.findFirst({
      where: { billingAccountId: accountId, periodStart: period.start, purpose: 'usage_period' },
      include: { lines: true, paymentAttempts: true },
    });

    if (existingInv) {
      const pay = hasPaymentEvidence(existingInv);
      if (pay) opFail(`existing_invoice_payment_${pay}`);
      if (existingInv.status !== 'finalized') {
        // open / needs_review / void — never modify or claim
        opFail('existing_invoice_not_blank');
      }
      // Verify-only: snapshot + exclusive usage (no foreign rows in period).
      await assertInvoiceSnapshot(
        existingInv,
        {
          period: period.period,
          planVersionId: planVersion.id,
          planCode: planVersion.code,
          planName: planVersion.name,
          planVersionNumber: planVersion.version,
          apiCalls,
          planTerms: planTermsFromPinned(planVersion as any),
        },
        canonicalBillingJson,
      );
      const asg = await tx.billingPlanAssignment.findUnique({
        where: {
          billingAccountId_periodStart: {
            billingAccountId: accountId,
            periodStart: period.start,
          },
        },
      });
      if (!asg || asg.planVersionId !== planVersion.id) opFail('verify_assignment_required');
      await assertPeriodUsageExclusive(tx, {
        accountId,
        fixtureId,
        userId,
        period: period.period,
        planVersionId: planVersion.id,
        expectedKeys: usageKeys,
      });

      logInfo(`  ${period.period}: verified_readonly (no writes, no ownership)`);
      return {
        period: period.period,
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        assignmentId: asg.id,
        assignmentOwnedByFixture: false,
        invoiceId: existingInv.id,
        invoiceOwnedByFixture: false,
        snapshotHash: existingInv.snapshotHash,
        totalMicros: existingInv.totalMicros.toString(),
        planVersionId: planVersion.id,
        usageSourceKeys: usageKeys,
        apiCallCount: apiCalls,
        mode: 'verified_readonly' as const,
      };
    }

    // Blank period: refuse any pre-existing foreign usage before we write.
    const preUsage = await tx.billingUsageEvent.findMany({
      where: { billingAccountId: accountId, periodStart: period.start },
    });
    const expectedKeySet = new Set(usageKeys);
    for (const row of preUsage) {
      if (!expectedKeySet.has(row.sourceKey)) {
        // Foreign outbound/api/other fixture rows would be baked into the invoice.
        opFail('blank_foreign_usage');
      }
    }

    // Assignment: reuse same plan only (no ownership claim if pre-existing).
    let assignment = await tx.billingPlanAssignment.findUnique({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: accountId,
          periodStart: period.start,
        },
      },
    });
    let assignmentCreated = false;
    if (assignment) {
      if (assignment.planVersionId !== planVersion.id) opFail('assignment_plan_conflict');
    } else {
      try {
        assignment = await tx.billingPlanAssignment.create({
          data: {
            billingAccountId: accountId,
            planVersionId: planVersion.id,
            periodStart: period.start,
          },
        });
        assignmentCreated = true;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') opFail('assignment_race');
        throw err;
      }
    }

    // Usage: create missing expected keys; pre-existing must be exact fixture rows.
    for (let n = 1; n <= apiCalls; n++) {
      const sourceKey = usageKeys[n - 1];
      const existing = await tx.billingUsageEvent.findUnique({ where: { sourceKey } });
      if (existing) {
        await assertUsageExact(existing, {
          accountId,
          fixtureId,
          userId,
          period: period.period,
          planVersionId: planVersion.id,
          n,
        });
        continue;
      }
      try {
        await tx.billingUsageEvent.create({
          data: {
            billingAccountId: accountId,
            metric: 'api_call',
            entryType: 'usage',
            sourceType: 'api_request',
            status: 'posted',
            sourceKey,
            periodStart: period.start,
            occurredAt: midMonth,
            quantity: 1n,
            volumeUsdMicros: 0n,
            planVersionId: planVersion.id,
            metadata: meta as import('@prisma/client').Prisma.InputJsonValue,
          },
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') opFail('usage_race');
        throw err;
      }
    }

    // Period must contain exactly expected fixture keys (no foreign residue).
    await assertPeriodUsageExclusive(tx, {
      accountId,
      fixtureId,
      userId,
      period: period.period,
      planVersionId: planVersion.id,
      expectedKeys: usageKeys,
    });

    // Historical fixture periods are isolated synthetic periods. Finalization
    // requires explicit peak evidence; never import today's wallet count or
    // adopt/overwrite a row whose ownership this fixture cannot prove.
    const existingWalletUsage = await tx.billingWalletUsagePeriod.findUnique({
      where: {
        billingAccountId_periodStart: {
          billingAccountId: accountId,
          periodStart: period.start,
        },
      },
    });
    if (existingWalletUsage) opFail('blank_foreign_wallet_usage');
    const walletUsage = await tx.billingWalletUsagePeriod.create({
      data: {
        billingAccountId: accountId,
        periodStart: period.start,
        peakWalletCount: 0,
        observedAt: midMonth,
      },
    });

    // Create-only finalize — no catalog bootstrap; refuses if invoice appears.
    const { invoice, created } = await billing.createFinalizedInvoiceOnlyInTx(tx, {
      userId,
      billingAccountId: accountId,
      periodStart: period.start,
      periodEnd: period.end,
      period: period.period,
      planVersionId: planVersion.id,
    });
    if (!created) opFail('finalize_not_created');

    await assertInvoiceSnapshot(
      { ...invoice, paymentAttempts: [] },
      {
        period: period.period,
        planVersionId: planVersion.id,
        planCode: planVersion.code,
        planName: planVersion.name,
        planVersionNumber: planVersion.version,
        apiCalls,
        planTerms: planTermsFromPinned(planVersion as any),
      },
      canonicalBillingJson,
    );

    logInfo(`  ${period.period}: created invoice owned=true asgOwned=${assignmentCreated}`);
    return {
      period: period.period,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      assignmentId: assignment!.id,
      assignmentOwnedByFixture: assignmentCreated,
      invoiceId: invoice.id,
      invoiceOwnedByFixture: true, // only true because createFinalizedInvoiceOnlyInTx created it
      snapshotHash: invoice.snapshotHash,
      totalMicros: invoice.totalMicros.toString(),
      planVersionId: planVersion.id,
      usageSourceKeys: usageKeys,
      apiCallCount: apiCalls,
      mode: 'created' as const,
      syntheticWalletUsageId: walletUsage.id,
    };
  });
}

// ── Verify ───────────────────────────────────────────────────────────────────

async function cmdVerify(args: CliArgs): Promise<void> {
  if (!args.manifestPath) safetyFail('manifest_required');
  const key = requireManifestKey();
  const dbUrl = requireDbReadGates();
  const manifest = readSignedManifest(args.manifestPath, key);
  logInfo('=== billing-fixture verify ===');
  logInfo(`fixtureId: ${safeIdTag('fixture', manifest.fixtureId)}`);
  logInfo(`userId: ${safeIdTag('user', manifest.userId)}`);

  const { prisma, close } = await openBilling(dbUrl);
  const { canonicalBillingJson } = require('../src/modules/billing/billing-json') as {
    canonicalBillingJson: (v: unknown) => string;
  };
  try {
    const account = await prisma.billingAccount.findUnique({
      where: { id: manifest.billingAccountId },
    });
    if (!account || account.userId !== manifest.userId) opFail('account_mismatch');
    if (account.currency !== 'USD') opFail('account_currency');
    const planWithTiers = await loadPlanWithTiers(prisma, manifest.planVersionId);
    assertPlanVersionIdentity(planWithTiers, {
      planVersionId: manifest.planVersionId,
      planCode: manifest.planCode,
      planVersionNumber: manifest.planVersionNumber,
    });
    if (
      planWithTiers.monthlyFeeMicros === null ||
      planWithTiers.includedApiCalls === null ||
      planWithTiers.includedWallets === null ||
      planWithTiers.includedOutboundMicros === null
    ) {
      opFail('plan_terms_null');
    }
    if (planWithTiers.tiers.length === 0) opFail('plan_tiers_missing');
    if (computePlanTermsFingerprint(planWithTiers) !== manifest.planTermsFingerprint) {
      opFail('plan_terms_fingerprint');
    }

    for (const d of manifest.periodDetails) {
      await withPeriodTx(prisma, account.id, exactMonthBounds(d.period).start, async (tx) => {
        await assertPriorBaseline(tx, manifest, d, account.id, planWithTiers, canonicalBillingJson);
      });
      logInfo(`  OK ${d.period} mode=${d.mode}`);
    }
    logInfo('Verify passed.');
  } finally {
    await close();
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cmdCleanup(args: CliArgs): Promise<void> {
  if (!args.manifestPath) safetyFail('manifest_required');
  const key = requireManifestKey();
  logInfo('=== billing-fixture cleanup ===');
  logInfo(`mode: ${args.apply ? 'APPLY' : 'dry-run'}`);

  if (!args.apply) {
    const manifest = readSignedManifest(args.manifestPath, key);
    for (const d of manifest.periodDetails) {
      logInfo(
        `  ${d.period}: mode=${d.mode} invOwned=${d.invoiceOwnedByFixture} asgOwned=${d.assignmentOwnedByFixture} (deletes only if invOwned)`,
      );
    }
    logInfo('Dry-run only. Apply requires disposable gate for invoice/assignment deletes.');
    return;
  }

  const dbUrl = requireApplyGates();
  const manifest = readSignedManifest(args.manifestPath, key);
  const needsDestructive = manifest.periodDetails.some((d) => d.invoiceOwnedByFixture);
  if (needsDestructive) requireDisposable();

  const { prisma, close } = await openBilling(dbUrl);
  const { acquireBillingPeriodAdvisoryLock } =
    require('../src/modules/billing/billing-period-lock') as {
      acquireBillingPeriodAdvisoryLock: (tx: Tx, id: string, start: Date) => Promise<void>;
    };
  const { Prisma } = require('@prisma/client') as typeof import('@prisma/client');
  const { canonicalBillingJson } = require('../src/modules/billing/billing-json') as {
    canonicalBillingJson: (v: unknown) => string;
  };

  try {
    await assertRunnerDatabaseIdentity(prisma);
    const report = await prisma.$transaction(
      async (tx) => {
        const deleted = { usage: 0, invoices: 0, assignments: 0, absent: 0, skipped: 0 };

        // Full plan+tiers + fingerprint inside the destructive transaction.
        const planPinned = await loadPlanWithTiers(tx, manifest.planVersionId);
        assertPlanVersionIdentity(planPinned, {
          planVersionId: manifest.planVersionId,
          planCode: manifest.planCode,
          planVersionNumber: manifest.planVersionNumber,
        });
        if (
          planPinned.monthlyFeeMicros === null ||
          planPinned.includedApiCalls === null ||
          planPinned.includedWallets === null ||
          planPinned.includedOutboundMicros === null
        ) {
          opFail('plan_terms_null');
        }
        if (planPinned.tiers.length === 0) opFail('plan_tiers_missing');
        if (computePlanTermsFingerprint(planPinned) !== manifest.planTermsFingerprint) {
          opFail('cleanup_plan_terms_fingerprint');
        }
        const planVersion = planPinned;
        const planTerms = planTermsFromPinned(planPinned);

        const account = await tx.billingAccount.findUnique({
          where: { id: manifest.billingAccountId },
        });
        if (!account || account.userId !== manifest.userId) opFail('account_mismatch');

        const sorted = [...manifest.periodDetails].sort((a, b) => a.period.localeCompare(b.period));
        for (const d of sorted) {
          const bounds = exactMonthBounds(d.period);
          await acquireBillingPeriodAdvisoryLock(tx, account.id, bounds.start);

          // Non-owned / readonly: skip entire period (no usage/asg/inv deletes).
          if (!d.invoiceOwnedByFixture || d.mode !== 'created') {
            deleted.skipped += 1;
            continue;
          }
          if (!d.assignmentOwnedByFixture) opFail('cleanup_assignment_not_owned');

          const current = await tx.billingInvoice.findFirst({
            where: { billingAccountId: account.id, periodStart: bounds.start, purpose: 'usage_period' },
            include: { lines: true, paymentAttempts: true },
          });

          if (current && current.id !== d.invoiceId) opFail('cleanup_invoice_id_replaced');

          const asg = await tx.billingPlanAssignment.findUnique({ where: { id: d.assignmentId } });
          const usageRows: Array<{ id: string; sourceKey: string } & Record<string, unknown>> = [];
          for (let n = 1; n <= d.apiCallCount; n++) {
            const sk = d.usageSourceKeys[n - 1];
            assertExactSourceKey(sk, manifest.fixtureId, manifest.userId, d.period, n);
            const row = await tx.billingUsageEvent.findUnique({ where: { sourceKey: sk } });
            if (row) usageRows.push(row as any);
          }

          // Invoice missing: only idempotent success when period is fully empty
          // and the manifest invoice id does not exist anywhere. Any residue,
          // alternate invoice, or foreign placement → fail closed (no deletes).
          if (!current) {
            const invoiceAnywhere = await tx.billingInvoice.findUnique({
              where: { id: d.invoiceId },
            });
            const periodUsageCount = await tx.billingUsageEvent.count({
              where: { billingAccountId: account.id, periodStart: bounds.start },
            });
            const periodAsg = await tx.billingPlanAssignment.findUnique({
              where: {
                billingAccountId_periodStart: {
                  billingAccountId: account.id,
                  periodStart: bounds.start,
                },
              },
            });
            const asgAnywhere = asg
              ? asg
              : await tx.billingPlanAssignment.findUnique({ where: { id: d.assignmentId } });

            const { decideCleanupMissingInvoice } =
              require('../src/modules/billing/billing-fixture-usage-evidence') as {
                decideCleanupMissingInvoice: (a: {
                  invoiceAnywhere: boolean;
                  periodUsageCount: number;
                  periodAssignmentExists: boolean;
                  assignmentAnywhere: boolean;
                }) => 'absent_ok' | 'fail_elsewhere' | 'fail_residue';
              };
            const decision = decideCleanupMissingInvoice({
              invoiceAnywhere: !!invoiceAnywhere,
              periodUsageCount,
              periodAssignmentExists: !!periodAsg,
              assignmentAnywhere: !!asgAnywhere,
            });
            if (decision === 'absent_ok') {
              if (d.syntheticWalletUsageId) {
                await assertSyntheticWalletUsage(tx, d.syntheticWalletUsageId, account.id, d.period);
                await tx.billingWalletUsagePeriod.delete({ where: { id: d.syntheticWalletUsageId } });
              }
              deleted.absent += 1;
              continue;
            }
            if (decision === 'fail_elsewhere') opFail('cleanup_invoice_elsewhere');
            opFail('cleanup_invoice_missing_with_residue');
          }

          // Invoice present — lock + full proof then delete.
          await tx.$queryRawUnsafe(
            `SELECT id FROM billing_invoices WHERE id = $1::uuid FOR UPDATE`,
            d.invoiceId,
          );
          const inv = await tx.billingInvoice.findUnique({
            where: { id: d.invoiceId },
            include: { lines: true, paymentAttempts: true },
          });
          if (!inv) opFail('cleanup_invoice_vanished');
          if (inv.billingAccountId !== account.id) opFail('cleanup_invoice_account');
          const pay = hasPaymentEvidence(inv);
          if (pay) opFail(`cleanup_payment_${pay}`);

          await assertInvoiceSnapshot(
            inv,
            {
              period: d.period,
              planVersionId: d.planVersionId,
              planCode: manifest.planCode,
              planName: planVersion.name,
              planVersionNumber: manifest.planVersionNumber,
              apiCalls: d.apiCallCount,
              planTerms,
              totalMicros: d.totalMicros,
              snapshotHash: d.snapshotHash,
            },
            canonicalBillingJson,
          );

          // Exclusive period usage proof before deletes.
          await assertPeriodUsageExclusive(tx, {
            accountId: account.id,
            fixtureId: manifest.fixtureId,
            userId: manifest.userId,
            period: d.period,
            planVersionId: d.planVersionId,
            expectedKeys: d.usageSourceKeys,
          });
          if (d.syntheticWalletUsageId) {
            await assertSyntheticWalletUsage(tx, d.syntheticWalletUsageId, account.id, d.period);
          }

          if (!asg) opFail('cleanup_assignment_missing');
          if (asg.billingAccountId !== account.id) opFail('cleanup_assignment_account');
          if (asg.planVersionId !== d.planVersionId) opFail('cleanup_assignment_plan');
          if (asg.periodStart.getTime() !== bounds.start.getTime()) {
            opFail('cleanup_assignment_period');
          }

          await tx.billingInvoiceLine.deleteMany({ where: { invoiceId: inv.id } });
          await tx.billingInvoice.delete({ where: { id: inv.id } });
          deleted.invoices += 1;

          // Wallet usage has an account FK and no invoice FK; delete only the
          // exact signed-manifest-owned row, after invoice/line removal.
          if (d.syntheticWalletUsageId) {
            await tx.billingWalletUsagePeriod.delete({ where: { id: d.syntheticWalletUsageId } });
          }

          for (let n = 1; n <= d.apiCallCount; n++) {
            const sk = d.usageSourceKeys[n - 1];
            const row = await tx.billingUsageEvent.findUnique({ where: { sourceKey: sk } });
            if (!row) opFail('cleanup_usage_missing');
            await assertUsageExact(row as any, {
              accountId: account.id,
              fixtureId: manifest.fixtureId,
              userId: manifest.userId,
              period: d.period,
              planVersionId: d.planVersionId,
              n,
            });
            await assertUsageNoDependents(tx, row.id);
            await tx.billingUsageEvent.delete({ where: { id: row.id } });
            deleted.usage += 1;
          }

          await tx.billingPlanAssignment.delete({ where: { id: d.assignmentId } });
          deleted.assignments += 1;
        }
        return deleted;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 },
    );

    logInfo(
      `Cleanup done: invoices=${report.invoices} usage=${report.usage} assignments=${report.assignments} skipped_nonowned=${report.skipped} absent=${report.absent}`,
    );
  } finally {
    await close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logErr(`ERROR: ${publicErrorMessage(err)}`);
    process.exit(err instanceof FixtureError ? err.exitCode : EXIT_SAFETY);
  }

  if (args.help || (!args.command && argv.length === 0)) {
    logInfoRaw(usage());
    process.exit(EXIT_OK);
  }
  if (!args.command) {
    logErr('ERROR: missing_command');
    process.exit(EXIT_SAFETY);
  }

  try {
    if (args.command === 'seed') await cmdSeed(args);
    else if (args.command === 'verify') await cmdVerify(args);
    else if (args.command === 'cleanup') await cmdCleanup(args);
    process.exit(EXIT_OK);
  } catch (err) {
    logErr(`ERROR: ${publicErrorMessage(err)}`);
    process.exit(err instanceof FixtureError ? err.exitCode : EXIT_FAIL);
  }
}

// Jest-importable: no side effects when required as a module.
if (require.main === module) {
  void main();
}

// Minimal test surface for pure gates used by the CLI (no Nest bootstrap).
export const __test__ = {
  // Re-export paths resolved at runtime by unit tests that import the .ts via ts-jest
  // are preferred via billing-fixture-*- modules above.
};

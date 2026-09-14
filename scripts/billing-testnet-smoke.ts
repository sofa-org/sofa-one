/**
 * Billing testnet smoke checks (ops / local validation only).
 *
 * Default mode is dry-run / config inspection — no network calls.
 * Health and optional dashboard GETs require explicit flags + env.
 *
 * Safety:
 * - Never uses API keys (dashboard routes are IAM + FrontendOnly only).
 * - Never automates payments (no checkout / USDC quote-claim / webhooks).
 * - Never logs tokens, secrets, wallet addresses, Stripe IDs, or full bodies.
 * - No hardcoded base URLs, tokens, or treasury addresses.
 *
 * Run via: npm run billing:testnet-smoke -- [flags]
 */

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

type SmokeConfig = {
  baseUrl: string;
  origin: string | undefined;
  iamTokenPresent: boolean;
  iamToken: string | undefined;
  period: string;
  timeoutMs: number;
};

const ENV = {
  baseUrl: 'BILLING_SMOKE_BASE_URL',
  iamToken: 'BILLING_SMOKE_IAM_TOKEN',
  origin: 'BILLING_SMOKE_ORIGIN',
  period: 'BILLING_SMOKE_PERIOD',
  timeoutMs: 'BILLING_SMOKE_TIMEOUT_MS',
} as const;

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';
const DEFAULT_TIMEOUT_MS = 10_000;

function usage(): string {
  return `
Billing testnet smoke (safe, read-only by design)

Usage:
  npm run billing:testnet-smoke -- [options]

Options:
  (default)           Dry-run: print resolved config and planned checks; no HTTP.
  --health            GET /health/live and /health/ready
  --dashboard         GET /v1/billing/plans, /summary, /invoices
                      (requires BILLING_SMOKE_IAM_TOKEN + BILLING_SMOKE_ORIGIN)
  --help, -h          Show this help

Environment (all optional unless noted):
  ${ENV.baseUrl}       API base URL (default ${DEFAULT_BASE_URL})
  ${ENV.iamToken}      Openfort IAM bearer token (required for --dashboard)
  ${ENV.origin}        Origin/Referer value matching CORS_ORIGIN (required for --dashboard)
  ${ENV.period}        Summary period YYYY-MM (default: current UTC month)
  ${ENV.timeoutMs}     Per-request timeout ms (default ${DEFAULT_TIMEOUT_MS})

Examples:
  # Config check only (safe default)
  npm run billing:testnet-smoke

  # Liveness + readiness against a local API
  BILLING_SMOKE_BASE_URL=http://127.0.0.1:3100 npm run billing:testnet-smoke -- --health

  # Dashboard reads (token never printed)
  BILLING_SMOKE_BASE_URL=http://127.0.0.1:3100 \\
  BILLING_SMOKE_ORIGIN=http://localhost:3000 \\
  BILLING_SMOKE_IAM_TOKEN="<paste IAM token>" \\
  npm run billing:testnet-smoke -- --health --dashboard

Does not call checkout, subscription-checkout, USDC quote/claim, reconcile, or webhooks.
`.trim();
}

function parseArgs(argv: string[]): {
  help: boolean;
  health: boolean;
  dashboard: boolean;
} {
  let help = false;
  let health = false;
  let dashboard = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--health') health = true;
    else if (arg === '--dashboard') dashboard = true;
    else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}. Use --help for usage.`);
    }
  }
  return { help, health, dashboard };
}

function currentUtcPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function isValidPeriod(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function loadConfig(): SmokeConfig {
  const baseRaw = (process.env[ENV.baseUrl] ?? DEFAULT_BASE_URL).trim();
  const originRaw = process.env[ENV.origin]?.trim();
  const tokenRaw = process.env[ENV.iamToken]?.trim();
  const periodRaw = process.env[ENV.period]?.trim() || currentUtcPeriod();
  const timeoutRaw = process.env[ENV.timeoutMs]?.trim();

  let baseUrl: string;
  try {
    const u = new URL(baseRaw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('base URL must be http or https');
    }
    // Strip trailing slash for join consistency; keep path prefix if any.
    baseUrl = `${u.origin}${u.pathname.replace(/\/$/, '')}` || u.origin;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${ENV.baseUrl}="${baseRaw}": ${msg}`);
  }

  if (originRaw) {
    try {
      const o = new URL(originRaw);
      if (o.protocol !== 'http:' && o.protocol !== 'https:') {
        throw new Error('origin must be http or https');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid ${ENV.origin}="${originRaw}": ${msg}`);
    }
  }

  if (!isValidPeriod(periodRaw)) {
    throw new Error(`Invalid ${ENV.period}="${periodRaw}"; expected YYYY-MM (UTC billing month).`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isFinite(n) || n < 1000 || n > 120_000) {
      throw new Error(`Invalid ${ENV.timeoutMs}="${timeoutRaw}"; expected 1000–120000.`);
    }
    timeoutMs = Math.floor(n);
  }

  return {
    baseUrl,
    origin: originRaw || undefined,
    iamTokenPresent: Boolean(tokenRaw),
    iamToken: tokenRaw || undefined,
    period: periodRaw,
    timeoutMs,
  };
}

function printConfig(cfg: SmokeConfig, mode: { health: boolean; dashboard: boolean }): void {
  console.log('=== billing testnet smoke — config ===');
  console.log(
    `mode:              ${mode.health || mode.dashboard ? 'execute' : 'dry-run (default)'}`,
  );
  console.log(`planned checks:    ${describePlan(mode)}`);
  console.log(`${ENV.baseUrl}: ${cfg.baseUrl}`);
  console.log(
    `${ENV.origin}:    ${cfg.origin ? cfg.origin : '(unset — required for --dashboard)'}`,
  );
  console.log(
    `${ENV.iamToken}: ${cfg.iamTokenPresent ? '[set, redacted]' : '(unset — required for --dashboard)'}`,
  );
  console.log(`${ENV.period}:  ${cfg.period}`);
  console.log(`timeoutMs:         ${cfg.timeoutMs}`);
  console.log('notes:             no API keys; no payment automation; no secrets logged');
}

function describePlan(mode: { health: boolean; dashboard: boolean }): string {
  const parts: string[] = [];
  if (!mode.health && !mode.dashboard) {
    return 'config only (pass --health and/or --dashboard to call the API)';
  }
  if (mode.health) parts.push('GET /health/live', 'GET /health/ready');
  if (mode.dashboard) {
    parts.push('GET /v1/billing/plans', 'GET /v1/billing/summary', 'GET /v1/billing/invoices');
  }
  return parts.join(', ');
}

function assertDashboardConfig(cfg: SmokeConfig): void {
  const missing: string[] = [];
  if (!cfg.iamTokenPresent) missing.push(ENV.iamToken);
  if (!cfg.origin) missing.push(ENV.origin);
  if (missing.length) {
    throw new Error(
      `--dashboard requires ${missing.join(' and ')}. ` +
        'Dashboard billing routes need an Openfort IAM bearer token plus Origin/Referer matching CORS_ORIGIN. ' +
        'Do not use an API key.',
    );
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; json: unknown | null; textSnippet: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json: unknown | null = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      json,
      textSnippet: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeLive(body: unknown): string {
  if (!isRecord(body)) return 'unexpected body shape';
  const status = body.status;
  const ts = body.timestamp;
  return `status=${String(status)}${typeof ts === 'string' ? ` timestamp=${ts}` : ''}`;
}

function summarizeReady(body: unknown): string {
  if (!isRecord(body)) return 'unexpected body shape';
  const status = body.status;
  const checks = isRecord(body.checks) ? body.checks : undefined;
  const database = checks ? String(checks.database ?? '?') : '?';
  const bw = checks && isRecord(checks.billingWorker) ? checks.billingWorker : undefined;
  if (!bw) {
    return `status=${String(status)} database=${database}`;
  }
  const parts = [
    `status=${String(status)}`,
    `database=${database}`,
    `worker.enabled=${String(bw.enabled)}`,
    `worker.status=${String(bw.status)}`,
    `worker.consecutiveFailures=${String(bw.consecutiveFailures ?? 0)}`,
    `worker.needsReviewCount=${String(bw.needsReviewCount ?? 0)}`,
  ];
  // Timestamps are non-sensitive public probe fields; include only presence.
  if (bw.lastHeartbeatAt != null) parts.push('worker.lastHeartbeatAt=set');
  if (bw.lastSuccessAt != null) parts.push('worker.lastSuccessAt=set');
  if (bw.lastFailureAt != null) parts.push('worker.lastFailureAt=set');
  return parts.join(' ');
}

/** Safe dashboard summaries — shape/status only, no PII or payment URLs. */
function summarizePlans(body: unknown): string {
  if (!isRecord(body)) return 'unexpected body shape';
  const keys = Object.keys(body).sort();
  const planish =
    body.currentPlan != null || body.plan != null || body.plans != null || body.catalog != null;
  return `keys=[${keys.join(',')}] hasPlanFields=${planish}`;
}

function summarizeSummary(body: unknown): string {
  if (!isRecord(body)) return 'unexpected body shape';
  const period =
    typeof body.period === 'string'
      ? body.period
      : typeof body.billingPeriod === 'string'
        ? body.billingPeriod
        : undefined;
  const keys = Object.keys(body).sort();
  return `keys=[${keys.join(',')}]${period ? ` period=${period}` : ''}`;
}

function summarizeInvoices(body: unknown): string {
  if (!isRecord(body)) return 'unexpected body shape';
  const items = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.invoices)
      ? body.invoices
      : Array.isArray(body.data)
        ? body.data
        : null;
  const total =
    typeof body.total === 'number'
      ? body.total
      : typeof body.totalCount === 'number'
        ? body.totalCount
        : undefined;
  const page = typeof body.page === 'number' ? body.page : undefined;
  const parts = [`keys=[${Object.keys(body).sort().join(',')}]`];
  if (items) parts.push(`items=${items.length}`);
  if (total !== undefined) parts.push(`total=${total}`);
  if (page !== undefined) parts.push(`page=${page}`);
  return parts.join(' ');
}

async function checkHealth(cfg: SmokeConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const liveUrl = `${cfg.baseUrl}/health/live`;
  const readyUrl = `${cfg.baseUrl}/health/ready`;

  try {
    const live = await fetchJson(liveUrl, { method: 'GET' }, cfg.timeoutMs);
    const ok = live.ok && live.status === 200;
    results.push({
      name: 'GET /health/live',
      ok,
      detail: ok
        ? summarizeLive(live.json)
        : `HTTP ${live.status}${live.json ? ` ${summarizeLive(live.json)}` : ''}`,
    });
  } catch (err) {
    results.push({
      name: 'GET /health/live',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const ready = await fetchJson(readyUrl, { method: 'GET' }, cfg.timeoutMs);
    // 200 = ready; 503 = intentionally not ready (still a successful probe of the endpoint).
    const reachable = ready.status === 200 || ready.status === 503;
    const detail =
      ready.json != null
        ? summarizeReady(ready.json)
        : `HTTP ${ready.status} non-json: ${ready.textSnippet}`;
    results.push({
      name: 'GET /health/ready',
      ok: reachable,
      detail: `HTTP ${ready.status} ${detail}`,
    });
  } catch (err) {
    results.push({
      name: 'GET /health/ready',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

function dashboardHeaders(cfg: SmokeConfig): HeadersInit {
  // Token and origin validated by assertDashboardConfig before call.
  const origin = cfg.origin as string;
  const token = cfg.iamToken as string;
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: origin,
    Referer: `${origin}/`,
  };
}

async function checkDashboard(cfg: SmokeConfig): Promise<CheckResult[]> {
  assertDashboardConfig(cfg);
  const headers = dashboardHeaders(cfg);
  const results: CheckResult[] = [];

  const endpoints: Array<{
    name: string;
    path: string;
    summarize: (body: unknown) => string;
  }> = [
    {
      name: 'GET /v1/billing/plans',
      path: '/v1/billing/plans',
      summarize: summarizePlans,
    },
    {
      name: 'GET /v1/billing/summary',
      path: `/v1/billing/summary?period=${encodeURIComponent(cfg.period)}`,
      summarize: summarizeSummary,
    },
    {
      name: 'GET /v1/billing/invoices',
      path: '/v1/billing/invoices?page=1&limit=5',
      summarize: summarizeInvoices,
    },
  ];

  for (const ep of endpoints) {
    const url = `${cfg.baseUrl}${ep.path}`;
    try {
      const res = await fetchJson(url, { method: 'GET', headers }, cfg.timeoutMs);
      if (res.ok) {
        results.push({
          name: ep.name,
          ok: true,
          detail: `HTTP ${res.status} ${ep.summarize(res.json)}`,
        });
      } else {
        // Do not dump error bodies (may include request paths / messages).
        const code =
          isRecord(res.json) && typeof res.json.code === 'string' ? ` code=${res.json.code}` : '';
        const statusCode =
          isRecord(res.json) && typeof res.json.statusCode === 'number'
            ? ` statusCode=${res.json.statusCode}`
            : '';
        results.push({
          name: ep.name,
          ok: false,
          detail: `HTTP ${res.status}${statusCode}${code}`,
        });
      }
    } catch (err) {
      results.push({
        name: ep.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function printResults(results: CheckResult[]): boolean {
  console.log('=== results ===');
  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.name} — ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  console.log(
    allOk ? '=== smoke: all checks passed ===' : '=== smoke: one or more checks failed ===',
  );
  return allOk;
}

async function main(): Promise<number> {
  let flags: ReturnType<typeof parseArgs>;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (flags.help) {
    console.log(usage());
    return 0;
  }

  let cfg: SmokeConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  printConfig(cfg, flags);

  // Dry-run: validate dashboard env if that mode was requested without executing.
  if (!flags.health && !flags.dashboard) {
    console.log('=== dry-run complete (no HTTP) ===');
    console.log('Tip: add --health to probe liveness/readiness; add --dashboard for IAM reads.');
    return 0;
  }

  if (flags.dashboard) {
    try {
      assertDashboardConfig(cfg);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }

  const results: CheckResult[] = [];
  if (flags.health) {
    results.push(...(await checkHealth(cfg)));
  }
  if (flags.dashboard) {
    results.push(...(await checkDashboard(cfg)));
  }

  return printResults(results) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error('Unhandled error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });

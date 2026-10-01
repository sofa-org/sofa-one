# Deployment

## 1. Runtime components

- NestJS backend from repository root.
- Static Vite/React frontend from `frontend/dist`.
- PostgreSQL 16.
- Redis 7 is present for planned queue/cache work; do not assume queue behavior unless implemented.
- Openfort account/API credentials.

## 2. Backend environment variables

| Variable                                                             | Required               | Notes                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENFORT_API_KEY`                                                   | Yes                    | Openfort backend secret; never expose to browser                                                                                                                                                                                                                                                                                     |
| `OPENFORT_WALLET_SECRET`                                             | Yes                    | TEE wallet signing secret; never log                                                                                                                                                                                                                                                                                                 |
| `DATABASE_URL`                                                       | Yes                    | PostgreSQL connection string                                                                                                                                                                                                                                                                                                         |
| `OPENFORT_PUBLISHABLE_KEY`                                           | No                     | Used by backend RPC/bundler integrations when needed                                                                                                                                                                                                                                                                                 |
| `OPENFORT_TIMEOUT_MS`                                                | No                     | SDK timeout; max validated value is `120000`                                                                                                                                                                                                                                                                                         |
| `REDIS_URL`                                                          | No                     | Redis connection string for future queue/cache use                                                                                                                                                                                                                                                                                   |
| `DEFAULT_CHAIN_ID`                                                   | No                     | Defaults to `84532`; must be supported                                                                                                                                                                                                                                                                                               |
| `PORT`                                                               | No                     | Code default `3001`; `.env.example` uses `3100`                                                                                                                                                                                                                                                                                      |
| `NODE_ENV`                                                           | No                     | `development`, `production`, or `test`                                                                                                                                                                                                                                                                                               |
| `CORS_ORIGIN`                                                        | Production yes         | Comma-separated allowed frontend origins                                                                                                                                                                                                                                                                                             |
| `TRUST_PROXY`                                                        | Production yes         | Explicit trusted proxy IP/CIDR values; not `true`/`1`                                                                                                                                                                                                                                                                                |
| `BILLING_WORKER_ENABLED`                                             | Production yes         | Defaults `false`; must be the literal `true` in production (startup validation). Runs the in-process billing worker (reconciliation, finalization, USDC claim recovery, Stripe renewal retry, checkout recovery) and persists its heartbeat for `/health/ready`; apply the additive worker-heartbeat migration first (see section 8) |
| `STRIPE_SECRET_KEY`                                                  | No                     | Stripe rail; when unset all Stripe calls fail closed 503                                                                                                                                                                                                                                                                             |
| `STRIPE_WEBHOOK_SECRET`                                              | When Stripe configured | Verifies `POST /v1/billing/webhooks/stripe` signatures from `req.rawBody`                                                                                                                                                                                                                                                            |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL`                           | When Stripe configured | Server-authoritative redirect URLs (valid https, never client-supplied); must point at the SPA billing page — the backend appends a `success=1`/`canceled=1` marker preserving existing query/fragment                                                                                                                               |
| `BILLING_USDC_ENABLED`                                               | No                     | Defaults `false`; when `true` all treasury and RPC vars below are required                                                                                                                                                                                                                                                           |
| `BILLING_USDC_TREASURY_ADDRESS_1` / `_11155111` / `_8453` / `_84532` | When USDC enabled      | Static treasury addresses for Ethereum / Ethereum Sepolia / Base / Base Sepolia; never the zero address                                                                                                                                                                                                                              |
| `BILLING_USDC_RPC_URL_1` / `_11155111` / `_8453` / `_84532`          | When USDC enabled      | HTTPS RPC URLs (may embed an API key — only a sha256 digest is persisted)                                                                                                                                                                                                                                                            |
| `BILLING_USDC_REQUIRED_CONFIRMATIONS`                                | No                     | Default `5`; validated 5–100                                                                                                                                                                                                                                                                                                         |
| `BILLING_USDC_QUOTE_TTL_SECONDS`                                     | No                     | Default `86400`; validated 1–604800                                                                                                                                                                                                                                                                                                  |

## 3. Frontend environment variables

Browser-safe only:

| Variable                               | Notes                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `VITE_OPENFORT_PUBLISHABLE_KEY`        | Openfort frontend publishable key                                                |
| `VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY` | Openfort Shield publishable key                                                  |
| `VITE_OPENFORT_FEE_SPONSORSHIP_ID`     | Optional sponsorship policy                                                      |
| `VITE_API_URL`                         | Backend URL in deployed environments; leave unset in local dev to use Vite proxy |
| `VITE_*_RPC_URL`                       | Optional public RPC overrides                                                    |

Never place backend secrets in `VITE_*` variables.

## 4. Local infrastructure

`docker-compose.yml` starts PostgreSQL and Redis bound to localhost ports:

- PostgreSQL: `127.0.0.1:5432`
- Redis: `127.0.0.1:6379`

The compose network is marked internal. Use host port bindings for local app access.

## 5. Build commands

Backend:

```bash
npm install
npm run prisma:generate
npm run build
npm run start:prod
```

Frontend:

```bash
cd frontend
npm install
npm run build
```

## 6. Production checklist

- Set `NODE_ENV=production`.
- Set non-empty `CORS_ORIGIN` to exact frontend origin(s).
- Set `TRUST_PROXY` to trusted proxy IP/CIDR values.
- Use strong PostgreSQL/Redis credentials.
- Run `npm run prisma:migrate:deploy` before starting new backend code.
- Confirm `OPENFORT_API_KEY` and `OPENFORT_WALLET_SECRET` are present only in backend secret storage.
- Set `BILLING_WORKER_ENABLED=true` (required in production) when automatic billing reconciliation/finalization, USDC claim recovery, Stripe renewal retry, and pending-Checkout recovery are required; apply the additive worker-heartbeat migration first (see section 8).
- If Stripe is configured, point the Stripe dashboard at `POST /v1/billing/webhooks/stripe` and set `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` (see section 9); both URLs must target the billing page because the backend appends the `success=1`/`canceled=1` return markers there.
- If USDC billing is used, set `BILLING_USDC_ENABLED=true` plus per-chain treasury/RPC variables (see section 9).
- Point liveness probes at `GET /health/live` and readiness probes at `GET /health/ready`. In production `/health/ready` reports 503 while the billing worker is disabled, failed, or stale (see section 8).
- Build frontend with the intended `VITE_API_URL`.
- Ensure SPA hosting falls back to `index.html` for client-side routing.
- Confirm logs redact authorization headers, raw API keys, and Openfort secrets.

## 7. Static frontend hosting

The frontend is a static SPA. Common hosting options:

- S3 + CloudFront: upload `frontend/dist`, configure SPA fallback.
- Vercel/Netlify: configure fallback/redirects for React Router.
- Nginx: use `try_files $uri /index.html;`.

Backend CORS must allow the deployed frontend origin.

## 8. Billing worker (optional, default off)

The billing worker (`BillingWorkerService`) is an **in-process** 5-minute scheduler
registered via `ScheduleModule.forRoot()` in `BillingModule`. It is **disabled by
default** and only acts when `BILLING_WORKER_ENABLED=true` — there is **no separate
worker process binary**; the worker runs inside the same long-running NestJS API
instance. Production must set the flag on at least one resident instance (a single
instance suffices; multiple instances are safe because cross-instance correctness relies
on the PostgreSQL billing-period advisory lock and DB-backed run/retry leases, never
in-memory state or Redis).

When enabled, each tick performs (all bounded, all via the existing evidence-backed
services):

- **Reconcile + finalize**: walks billing accounts (keyset-paginated, 50/page) and drains
  each eligible period's receipt-reconciliation backlog (bounded pages per account),
  then finalizes any open period past its end + 24h UTC grace that is free of unresolved
  risk (quarantined usage or risky reconciliation runs block closure). Recurring
  (fixed-fee) accounts are advanced to their next UTC period once the previous one closes.
- **Resume USDC claims**: re-verifies due `pending`/`confirming` USDC claims (bounded
  batch of 100/tick) using the persisted canonical `submittedTxHash` through the existing
  claim path — it never fabricates or re-derives hashes.
- **Retry deferred Stripe renewals**: re-fetches unmatched renewal events
  (`customer.subscription.*`, `invoice.*`) from Stripe by id and re-applies them through
  the signature/idempotent webhook pipeline under a DB-backed retry lease; bounded to 5
  retries with capped backoff, then `needs_review`.
- **Recover pending Checkouts**: re-verifies interrupted pending Stripe Checkout sessions
  via `stripe.checkout.sessions.retrieve` (expanded subscription) and persists only
  proven provider ids, with bounded backoff and lease columns before `needs_review`.

**Why default off**: the worker mutates billing state automatically (invoice finalization
and settlement-adjacent transitions, retries, recovery). Operators opt in explicitly so a
rollout can never accidentally finalize invoices or retry payments before the deployment
is validated.

**Monitoring**:

- Confirm the startup log line: "Billing worker enabled (workerId=…, interval=300000ms)"
  when on, or "Billing worker is disabled (set BILLING_WORKER_ENABLED=true to enable)"
  when off.
- Watch for `needs_review` rows that block finalization until resolved:
  `stripe_webhook_events` (deferred-retry exhausted, preflight rejected),
  `billing_payment_attempts` (`duplicate_unallocated`, `fixed_fee_partial_balance`,
  `checkout_recovery_exhausted`), and quarantined `billing_usage_events`.
- Worker failures are logged and isolated per account/event (sanitized); a failed tick
  never rolls back committed settlement, and an audit/SIEM failure never blocks a billing
  transition.

**Heartbeat and readiness** (requires the additive `BillingWorkerHeartbeat` migration):

- Every enabled in-process worker persists one heartbeat row keyed by its runtime
  `workerId`: status (`starting` | `running` | `healthy` | `failed`), `lastHeartbeatAt`,
  and nullable `lastStartedAt` / `lastSuccessAt` / `lastFailureAt` /
  `consecutiveFailures`. The row never stores error text, account/user data, secrets, or
  provider identifiers.
- Lifecycle: module initialization upserts `starting`; before a tick's work the worker
  upserts `running` and refreshes `lastHeartbeatAt`/`lastStartedAt`; only after every
  bounded stage of a tick succeeds it upserts `healthy`, refreshes `lastSuccessAt`, and
  resets `consecutiveFailures`; the top-level tick catch upserts `failed`, refreshes
  `lastFailureAt`, and increments `consecutiveFailures`. Heartbeat-write errors are
  sanitized/logged and never mask the tick result or abort unrelated work.
- Freshness is 15 minutes (three 5-minute intervals): an enabled worker with no fresh
  heartbeat in that window is stale (stopped or stuck scheduler). Readiness aggregates
  across worker rows without exposing worker IDs — a fresh `healthy` row reports healthy,
  otherwise a fresh `running` row reports active, then `failed`, then `starting`, and
  otherwise stale. A missing heartbeat table/query fails closed to stale/unavailable,
  never silently healthy.
- `GET /health/live` reports process liveness only. `GET /health/ready` is public and
  adds a database probe plus non-sensitive billing-worker state: `enabled`, the
  aggregated activity status, `lastHeartbeatAt`/`lastSuccessAt`/`lastFailureAt`,
  `consecutiveFailures`, and an aggregate `needsReviewCount` (billing invoices and
  payment attempts in `needs_review`, Stripe webhook events in `needs_review`/`failed`,
  and quarantined usage events). The count is informational and never fails readiness by
  itself. In production `/health/ready` is unavailable (503) while the worker is
  disabled, failed, or stale; `starting`/`running` are allowed during bounded
  startup/active-tick windows. Development/test keep the existing disabled-worker
  allowance, and the response never contains secrets or user data.
- Operational response for a failed/stale/missing heartbeat or new `needs_review` rows
  uses the existing surfaces only: sanitized worker logs, `SecurityEvent` rows (with the
  optional SIEM export), and the review tables above. A missing heartbeat table for an
  enabled worker usually means the heartbeat migration was not applied. There is no
  Slack/PagerDuty/email/vendor paging.

## 9. Stripe webhook and USDC configuration

Stripe rail (optional; when `STRIPE_SECRET_KEY` is unset the app runs normally and all
Stripe callers fail closed with 503):

- Configure Stripe to POST to `POST /v1/billing/webhooks/stripe`. The endpoint verifies
  the signature from `req.rawBody` (never re-parsed) and is exempt from throttling so
  Stripe retries are never rate-limited.
- `STRIPE_WEBHOOK_SECRET` must match the webhook endpoint's signing secret.
- `STRIPE_SUCCESS_URL`/`STRIPE_CANCEL_URL` are required (valid https) whenever Stripe is
  configured; they are server-side only and never accepted from the client.
- Success/cancel URLs are server-authoritative. When Stripe redirects the customer back,
  the backend uses the configured URL as-is except that a frontend-compatible marker is
  appended as a query parameter — `success=1` after a completed Checkout or `canceled=1`
  after an abandoned one — while preserving any existing query string and fragment. Both
  URLs must therefore point at the SPA billing page, which maps the marker to a notice
  and performs bounded invoice-status polling after return. The redirect is UX only: an
  invoice is settled exclusively by the signature-verified webhook (plus the worker's
  recovery paths), never by the return URL.
- Renewal events (`customer.subscription.*`, `invoice.*`) are processed idempotently;
  unmatched renewal events are deferred and retried by the billing worker — enable
  `BILLING_WORKER_ENABLED` for automatic retry and pending-Checkout recovery.

USDC rail (optional; `BILLING_USDC_ENABLED` defaults `false`):

- When enabled, all four supported chains — Ethereum (1), Ethereum Sepolia (11155111), Base
  (8453), and Base Sepolia (84532) — require a static treasury address (EVM format, never the
  zero address) and an HTTPS RPC URL.
- Token addresses are derived from the `SUPPORTED_CHAINS` registry at runtime, not
  configured.
- `BILLING_USDC_REQUIRED_CONFIRMATIONS` (default 5) and `BILLING_USDC_QUOTE_TTL_SECONDS`
  (default 86400) are bounded and validated at startup.
- Interrupted pending/confirming claims are automatically recovered only when
  `BILLING_WORKER_ENABLED=true`; otherwise the user must re-claim manually.

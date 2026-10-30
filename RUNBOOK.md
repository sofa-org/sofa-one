# Runbook

## 1. First-time setup

```bash
npm install
cd frontend && npm install && cd ..

cp .env.example .env
cp frontend/.env.example frontend/.env
```

Fill backend Openfort, database, and CORS settings. Fill only browser-safe values in `frontend/.env`.

## 2. Start local services

```bash
docker compose up -d
npm run prisma:migrate:dev
npm run start:dev
```

Start frontend separately:

```bash
cd frontend
npm run dev
```

## 3. Routine checks

Backend:

```bash
npm run build
npm run lint
npm run test
npm run test:e2e
```

Frontend:

```bash
cd frontend
npm run build
npm run lint
```

Prisma:

```bash
npm run prisma:generate
npm run prisma:migrate:dev
npm run prisma:studio
```

## 4. Health checks

Both endpoints are public. They never expose secrets, account/user data, or provider identifiers.

- `GET /health/live`: process liveness — returns `{ status: 'ok', timestamp }` without touching dependencies. Use it for liveness probes (is the process up?).
- `GET /health/ready`: readiness — probes the database and reports non-sensitive billing-worker and rate-limit state. Use its HTTP status for traffic routing; HTTP 200 may report `status: 'degraded'` while Redis is recovering.
  - `checks.database`: `ok`, or `unavailable` (readiness fails).
  - `checks.billingWorker`: `enabled`, an aggregated activity status (`starting` | `running` | `healthy` | `failed`, otherwise stale), `lastHeartbeatAt`, `lastSuccessAt`, `lastFailureAt`, `consecutiveFailures`, and an aggregate `needsReviewCount` (billing invoices/payment attempts in `needs_review`, Stripe webhook events in `needs_review`/`failed`, and quarantined usage events). The count is informational and never fails readiness by itself.
  - Worker status comes from the persisted in-process heartbeat rows (`BillingWorkerHeartbeat`), one per enabled worker, refreshed each 5-minute tick. Freshness is 15 minutes (three intervals); an enabled worker without a fresh heartbeat is stale. A missing heartbeat table/query fails closed to stale/unavailable, never silently healthy.
  - Production: 503 while the worker is disabled, failed, or stale. `starting`/`running` are allowed during bounded startup/active-tick windows. Development/test may run with the worker disabled and stay ready.
  - `checks.rateLimit`: `status: ok|degraded`, `mode: distributed|memory`, and `reason: null|not_configured|redis_unavailable|shutting_down`. No connection URL, host, credentials, or raw Redis errors are included. Configured Redis being unreachable changes overall status to `degraded` but does not alone return 503; database/billing failures still return 503 unchanged. With no `REDIS_URL`, intentional memory-only mode reports `ok`, `memory`, `not_configured`.

Redis throttling recovery:

- Reconnect continues for the lifetime of the process, with delay increasing from 100ms to a maximum of 3 seconds; there is no retry-attempt exhaustion cutoff. Once Redis is ready, the same storage returns to distributed limiting. A Redis command failure uses local limiting and reports degraded until a successful Redis increment or reconnect.
- Memory fallback enforces **per-instance** limits only. It is degraded protection, not globally fail-closed: replicas have independent buckets, and switching between Redis and memory does not migrate counters. Account for this reduced protection when investigating abuse; do not remove all API replicas from readiness solely because their shared Redis is down.
- Application close immediately disconnects the lifecycle-owned Redis client and cancels reconnects; it does not wait for an unreachable Redis to process `QUIT`. Bootstrap enables Nest shutdown hooks so termination signals also invoke resource cleanup.

### Isolated PostgreSQL security regression gate

- The existing CI billing E2E job calls `npm run test:e2e:billing`. Its default runner now includes session/MFA, auth provisioning, wallet provisioning recovery, multi-wallet execution and USDC quote races, wallet peak billing/fixture lifecycle, DeFi policy, Polymarket signing budgets, and pUSD acceptance concurrency, in addition to the existing billing/payment suites. No unrelated no-database suites are added to the PG phase.
- The no-DB identity-gate tests run first. For **each** PG suite, the runner creates a fresh database and dedicated role, checks database/user/session/owner/application identity, applies migrations, checks identity again, then runs only that exact suite in-band and drops its database/role in `finally`. Suites do not share seeds or destructive cleanup; failures stop the run after teardown. The admin URL never reaches Jest/Prisma.
- Set `BILLING_E2E_ADMIN_DATABASE_URL` only to an explicitly designated test maintenance database; never point this destructive runner at a production database. CI supplies its job-local service. Local execution may use the runner's existing verified loopback Docker container fallback; do not assume an arbitrary local database is disposable.
- For a targeted session/MFA run: `npm run test:e2e:billing -- --app-session-only`. Existing `--auth-provisioning-only`, `--multi-wallet-execution-only`, `--multi-wallet-quote-only`, `--recovery-only`, `--wallet-peak-only`, `--fixture-wallet-peak-only`, `--defi-policy-only`, `--polymarket-signing-budget-only`, and `--pusd-only` retain the same runner-owned isolation.

## 5. Common troubleshooting

### Backend fails on env validation

- Check `OPENFORT_API_KEY`, `OPENFORT_WALLET_SECRET`, and `DATABASE_URL` are present.
- In production, ensure `CORS_ORIGIN` and `TRUST_PROXY` are set.
- Ensure `DEFAULT_CHAIN_ID` is one of the supported chain IDs.

### API key is rejected

- Confirm the client sends `X-API-Key`, not `Authorization`.
- Confirm the key is not revoked or expired.
- Check IP allowlist against `request.ip` with trust-proxy configured correctly.
- Remember raw API keys are shown only once; regenerate if lost.
- Generic contract-call sends may also fail with `DEFI_*` errors when the call is
  unlisted, the key lacks a grant, the capability is paused, or policy state is unavailable.
  Review the capability catalog and key grants in the dashboard; do not retry using an
  unrestricted legacy key.
- Generic API-key message/typed-data signing is denied except the exact Polymarket CLOB
  ClobAuth bootstrap, CLOB V2 order, and DepositWallet Batch policies. They require `canSign`,
  `canUseEoaExecution`, and either `all` capability mode or custom mode explicitly containing
  the matching signing capability; independent EOA/destination/risk controls still apply.
  Other denials can have different policy error codes; destination protection may deny
  earlier. Dashboard withdrawals/payments are separate.
- `canUseEoaExecution` and `EOA_EXECUTION_ENABLED` apply only to these restricted
  signing lanes. Preserve the global flag, short key TTL, IP allowlist, independent
  rate limits and audit controls; they cannot enable direct signer EOA sends.

### Transaction request uses an old or unknown execution mode

- `POST /v1/transactions` accepts only `executionMode: "session_key"` or omission
  (the same default), submitting a Calibur UserOperation from the authorized user wallet.
- Explicit `"eoa"` or unknown modes return HTTP 400 (`VALIDATION_ERROR`); there is no
  automatic conversion or direct signer EOA send. Clients must deliberately submit a
  session-key request only when that user-wallet execution is intended and authorized.
- Do not disable signing controls or remove API-key permissions as a workaround.
  Approved Polymarket signing remains separate and keeps its EOA request mode.
- Historical EOA transactions remain queryable and eligible for billing reconciliation.
  Their recorded `walletAddress` may be the signer; do not backfill it to the user wallet.

### Shared backend RPC configuration migration

- Rename every `SIMULATION_RPC_URLS__<chainId>` deployment variable to
  `RPC_URLS__<chainId>`, preserving its URL, and restart/redeploy all backend instances.
  The old variables are no longer read; there is no compatibility alias.
- Simulation and Polymarket Order/Batch verification share `rpc.urls.<chainId>`.
  Every supported chain defaults to its registry's first HTTPS RPC. Explicit
  `RPC_URLS__<chainId>` overrides take precedence; invalid/empty overrides fail startup.
  Provider errors still fail closed, with no runtime failover. Bundler, USDC receipt-provider,
  and browser RPC configuration are unchanged.

### Polymarket order signing returns deposit wallet verification unavailable

- `503` with `Polymarket deposit wallet verification unavailable` is a pre-signing
  verification failure, before Openfort signing. It can mean the backend Polygon RPC is
  missing, the RPC call failed, `eth_chainId` is not `0x89` (137), or `eth_getCode` for
  the DepositWallet returned no runtime code. The response alone does not distinguish them.
- Optionally override the default with `RPC_URLS__137` in the **backend process environment**, using a reachable
  Polygon mainnet HTTPS RPC. For local development, an explicit public endpoint example is
  `RPC_URLS__137=https://polygon-bor-rpc.publicnode.com`; use a reliable provider
  for production. The backend reads `rpc.urls.137`; `VITE_POLYGON_RPC_URL`,
  `DEFAULT_CHAIN_ID`, and frontend RPC configuration do not supply this value.
- Restart/redeploy the backend after changing the environment. From that same runtime,
  check `eth_chainId` and `eth_getCode` for the request's `message.verifyingContract`.
  A successful read from a developer machine does not establish deployment connectivity.
  Default selection does not bypass verification; failed RPC calls still reject signing.
- Generate a fresh order before retrying: order `timestamp` is in milliseconds and must
  be within five minutes of server time. Replaying an old diagnostic payload can instead
  fail typed-data validation with a 400.
- Passing this preflight proves only reachable Polygon runtime code. Signing still checks
  recovered signer, unchanged code, and ERC-1271; failures in that later stage return
  `POLYMARKET_SIGNING_FAILED`. A successful preflight is not successful CLOB order placement.

### Capability mode or grant confusion

- Inspect the key's configured `capabilityMode` and `allowedCapabilityIds` in dashboard
  metadata; these are configuration, not an expanded effective-ID list.
- `all` dynamically follows active, unpaused reviewed catalog capabilities. `custom` allows
  only exact IDs, and `[]` denies all catalog capabilities. Neither mode overrides API-key
  permissions or independent authorization and safety checks.
- Capability create/edit/rotation routes are application-session/frontend-only; PATCH requires step-up and
  replaces the complete configuration. These routes are intentionally absent from
  `openapi.yaml`.

### Dashboard route fails with frontend-only error

- Confirm a live SOFA session cookie is sent with `credentials: 'include'`; IAM bearer tokens do not authenticate ordinary dashboard routes.
- Check `GET /auth/session`: pending MFA cannot access business routes (`MFA_REQUIRED`); complete TOTP or recovery verification.
- Unsafe requests need the current snapshot's `X-CSRF-Token` and an allowed Origin. Safe GET/HEAD may use an allowed Referer when Origin is absent.
- Confirm SPA/API are same-site, production is HTTPS, and proxies preserve cookies/headers. Cross-site cookie hosting is unsupported.
- A provider-only `AUTH_PROVIDER_INVALID` 401 requires wallet identity reconnection, not SOFA logout; `AUTH_PROVIDER_UNAVAILABLE` 502 requires retry, not repeated sign-in.
- Local sessions expire absolutely after one hour; upstream IAM revocation is not instantaneous locally. Current/all-device logout and account freeze take effect at subsequent auth/proof checks.
- Do not call frontend-only routes from API-key clients.

### Transaction status lacks calldata/request details

This is intentional. Public status responses are safe by design and must not expose calldata, `requestHash`, or `interactionsHash`.

### Database connection fails locally

- Ensure `docker compose up -d` is running.
- Ensure `.env` `DATABASE_URL` matches compose credentials.
- PostgreSQL is bound to `127.0.0.1:5432`.

### Billing invoices are never finalized / USDC claims stall

- The billing worker is disabled by default. Set `BILLING_WORKER_ENABLED=true` and confirm
  the startup log line "Billing worker enabled (workerId=…, interval=300000ms)".
- The worker runs inside the long-running NestJS API process (no separate binary); it must
  be enabled on a resident instance.
- Check `needs_review` rows that block finalization (`stripe_webhook_events`,
  `billing_payment_attempts`, quarantined `billing_usage_events`); see `DEPLOYMENT.md`
  section 8 for the full run/monitor guide.

### User returns from Stripe Checkout but the invoice looks stale

- Return URLs are server-authoritative. Stripe redirects to the configured
  `STRIPE_SUCCESS_URL`/`STRIPE_CANCEL_URL` plus a `success=1`/`canceled=1` marker (any
  existing query string and fragment are preserved). The billing page maps the marker to
  a notice and performs bounded invoice-status polling after return.
- The redirect never marks an invoice paid. Only a signature-verified Stripe webhook (or
  the billing worker's recovery paths) settles an invoice. If the invoice is unpaid after
  return, confirm the webhook was delivered and inspect the payment attempt's status or
  `needs_review` before retrying payment.

### Pricing effective date and quarantined receipts

- The current pricing policy is effective from `2026-08-01T00:00:00.000Z`, inclusive. There is no separate activation flag or migration for this date.
- Receipt observations before that instant are intentionally quarantined as `stale_price`; observations at or after it can be priced normally. Do not manually bypass the quarantine.
- Before enabling production reconciliation, verify that the deployed build contains this policy constant and that the billing migrations are applied. Changing the effective date is a pricing-policy decision and requires coordinated test/documentation updates.

### Billing worker heartbeat failed/stale or `/health/ready` is 503

- Production readiness requires an enabled worker with a fresh heartbeat: `starting`/
  `running` are allowed during startup/active ticks; a disabled, failed, or stale worker
  returns 503. Development/test allow a disabled worker.
- A `failed`/stale heartbeat or new `needs_review` rows surface only through the existing
  operational surfaces — sanitized worker logs, `SecurityEvent` rows, and the optional
  SIEM export. There is no Slack/PagerDuty/email alert.
- A missing heartbeat table for an enabled worker usually means the additive migration was
  not applied: run `npm run prisma:migrate:deploy` before enabling the worker in
  production.

## 6. Operational safety

- Revoke or rotate API keys through dashboard-only endpoints.
- Rotate Openfort secrets through deployment secret storage and restart backend instances.
- Run migrations before deploying code that expects schema changes; this includes the
  additive `BillingWorkerHeartbeat` migration before enabling the billing worker in
  production.
- Capability-mode rollout is a coordinated application/database migration: schedule a
  controlled maintenance window with all API writers stopped, apply the new migration, then
  start only the new application version. Do not run mixed old/new writers; old versions do
  not maintain the new mode invariant. The one-time migration maps existing empty grant lists
  to `all` and nonempty lists to `custom` without changing IDs. This deliberately treats old
  empty lists as approval of `all`; there is no recurring repair/backfill. Follow the actual
  migration's deployment instructions and do not apply it ad hoc.
- Update documentation alongside behavior changes.
- Treat `BILLING_WORKER_ENABLED=true` as an explicit production opt-in; verify its startup
  log line after each deployment that changes billing behavior.
- Treat a production `/health/ready` 503 caused by a disabled, failed, or stale billing
  worker as a deployment blocker. Investigate failed/stale heartbeats and `needs_review`
  rows through existing logs, `SecurityEvent` records, and the optional SIEM export; do
  not expect Slack/PagerDuty/email notifications.

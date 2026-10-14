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
- `GET /health/ready`: readiness — probes the database and reports non-sensitive billing-worker state. Use it for readiness probes (should traffic be routed here?).
  - `checks.database`: `ok`, or `unavailable` (readiness fails).
  - `checks.billingWorker`: `enabled`, an aggregated activity status (`starting` | `running` | `healthy` | `failed`, otherwise stale), `lastHeartbeatAt`, `lastSuccessAt`, `lastFailureAt`, `consecutiveFailures`, and an aggregate `needsReviewCount` (billing invoices/payment attempts in `needs_review`, Stripe webhook events in `needs_review`/`failed`, and quarantined usage events). The count is informational and never fails readiness by itself.
  - Worker status comes from the persisted in-process heartbeat rows (`BillingWorkerHeartbeat`), one per enabled worker, refreshed each 5-minute tick. Freshness is 15 minutes (three intervals); an enabled worker without a fresh heartbeat is stale. A missing heartbeat table/query fails closed to stale/unavailable, never silently healthy.
  - Production: 503 while the worker is disabled, failed, or stale. `starting`/`running` are allowed during bounded startup/active-tick windows. Development/test may run with the worker disabled and stay ready.

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
  ClobAuth bootstrap. It requires `canSign`, `canUseEoaExecution`, and either `all` capability
  mode or custom mode explicitly containing `polymarket:137:clob-auth:v1`; independent
  EOA/destination/risk controls still apply. Other denials can have different policy error
  codes; destination protection may deny earlier. Dashboard withdrawals/payments are separate.

### Capability mode or grant confusion

- Inspect the key's configured `capabilityMode` and `allowedCapabilityIds` in dashboard
  metadata; these are configuration, not an expanded effective-ID list.
- `all` dynamically follows active, unpaused reviewed catalog capabilities. `custom` allows
  only exact IDs, and `[]` denies all catalog capabilities. Neither mode overrides API-key
  permissions or independent authorization and safety checks.
- Capability create/edit/rotation routes are IAM/frontend-only; PATCH requires step-up and
  replaces the complete configuration. These routes are intentionally absent from
  `openapi.yaml`.

### Dashboard route fails with frontend-only error

- Confirm the request includes Openfort IAM bearer token.
- Confirm `Origin`/`Referer` matches configured `CORS_ORIGIN`.
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

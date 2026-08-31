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

- `GET /health/live`: process liveness.
- `GET /health/ready`: readiness for dependencies/configuration.

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

## 6. Operational safety

- Revoke or rotate API keys through dashboard-only endpoints.
- Rotate Openfort secrets through deployment secret storage and restart backend instances.
- Run migrations before deploying code that expects schema changes.
- Update documentation alongside behavior changes.
- Treat `BILLING_WORKER_ENABLED=true` as an explicit production opt-in; verify its startup
  log line after each deployment that changes billing behavior.

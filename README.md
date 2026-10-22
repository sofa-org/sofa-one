# SOFA ONE

SOFA ONE is a NestJS API plus Vite/React SPA for server-side automated blockchain signing. Users sign in with Openfort IAM email OTP, complete TOTP into a local SOFA session, authorize a backend agent signer on-chain, and create API keys for programmatic transaction submission.

## Documentation

This repository keeps detailed guidance in focused top-level documents:

| Document | Purpose |
| --- | --- |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | Product scope, functional requirements, non-functional requirements, constraints, and current exclusions |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System boundaries, modules, data flow, trust model, and extension points |
| [SECURITY.md](./SECURITY.md) | Key custody, auth model, API-key handling, logging, proxy/CORS, and incident rules |
| [API.md](./API.md) | Human-readable API guide; `openapi.yaml` remains the public API-key spec |
| [DATABASE.md](./DATABASE.md) | Prisma model overview, invariants, and migration workflow |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Environment variables, local infrastructure, production checklist, and runtime commands |
| [RUNBOOK.md](./RUNBOOK.md) | Local development, common operations, checks, and troubleshooting |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Coding standards, module boundaries, testing, and documentation rules |
| [PRICING.md](./PRICING.md) | Chinese pricing plan with free tier, outbound volume allowances, decreasing overage tiers, and plan-level service differences |
| [SOFA_ONE.md](./SOFA_ONE.md) | Chinese external project introduction, positioning, supported chains, and value |
| [SOFA_ONE_EN.md](./SOFA_ONE_EN.md) | English external project introduction, positioning, supported chains, and value |
| [codemap.md](./codemap.md) | Generated repository atlas for code navigation |

Historical design notes are archived under [`docs/archive/`](./docs/archive/) and are not current implementation guidance.

## Quick start

```bash
npm install
cd frontend && npm install && cd ..

cp .env.example .env
cp frontend/.env.example frontend/.env

docker compose up -d
npm run prisma:migrate:dev
npm run start:dev
```

In another terminal:

```bash
cd frontend
npm run dev
```

Default local ports:

- Backend: `PORT` from `.env` (`3100` in `.env.example`; `3001` code default when unset)
- Frontend: Vite on `3000`
- Vite proxy: `/api` → `http://localhost:3100` with `/api` stripped

## Core commands

Backend, from repo root:

```bash
npm run build
npm run lint
npm run test
npm run test:e2e
npm run prisma:generate
npm run prisma:migrate:dev
```

Frontend, from `frontend/`:

```bash
npm run build
npm run lint
```

## API boundary summary

Public API-key endpoints:

- `POST /v1/wallets/sign`
- `POST /v1/transactions`
- `GET /v1/transactions/:id`
- `GET /v1/permissions`
- `GET /v1/capabilities?ids=id1,id2`
- `GET /v1/wallets` (only the authenticated key's bound wallet)

Frontend-only endpoints require a live, MFA-verified SOFA HttpOnly session cookie plus `FrontendOnlyGuard` origin/referer checks. Unsafe requests also require `X-CSRF-Token`. Openfort bearer tokens are used only for login exchange and fresh embedded-wallet identity proof; they do not authenticate ordinary dashboard requests.

- `GET /wallets/balances`
- `GET /wallets/deposits`
- `POST /wallets/withdrawals`
- `GET/POST/DELETE /api-keys/*`
- selected `/auth/*` dashboard operations

See [API.md](./API.md) and [openapi.yaml](./openapi.yaml).

Application sessions expire absolutely after one hour; pending MFA expires after 15 minutes. Current/all-device logout revokes session-bound step-up proofs. Deploy the SPA/API same-site over HTTPS and coordinate the `20261022000000_application_sessions` migration with both packages; see [DEPLOYMENT.md](./DEPLOYMENT.md) and [API.md](./API.md).

## Non-negotiable security rules

- Private keys must never be stored, logged, returned, or derived outside Openfort TEE-managed custody.
- Public signing and transaction routes are API-key-only; do not accept frontend IAM tokens there.
- API-key management is frontend-dashboard-only; API keys must not manage API keys.
- API keys are Argon2id hashes in storage; raw secrets are returned only once.
- `UserWallet.openfortAccountId` is the stable Openfort foreign key; do not replace it with wallet address.
- Public transaction status responses must not expose calldata, request hashes, or interaction hashes.

## License

UNLICENSED — Private project.

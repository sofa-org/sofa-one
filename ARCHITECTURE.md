# Architecture

## 1. System overview

SOFA ONE is split into two packages:

- **Backend**: NestJS API in the repository root (`src/`, `prisma/`, `test/`).
- **Frontend**: Vite/React SPA in `frontend/` with its own `package.json` and lockfile.

The backend is responsible for identity synchronization, API-key lifecycle, Openfort wallet operations, transaction submission, audit persistence, validation, throttling, and security boundaries. The frontend is a static dashboard for user onboarding, wallet status, deposits/withdrawals, API-key management, and documentation/examples.

```text
Browser SPA
  ├─ Openfort IAM / embedded wallet auth
  └─ HTTPS to NestJS API
        ├─ AuthModule              session sync + embedded wallet authorization
        ├─ ApiKeyModule            dashboard-only key lifecycle
        ├─ WalletModule            balances, deposits, withdrawals, signing
        ├─ TransactionsModule      public API-key transaction send/status
        ├─ HealthModule            liveness/readiness
        ├─ PrismaModule            PostgreSQL access
        └─ OpenfortModule          Openfort SDK / TEE wallet calls
              ├─ Openfort TEE custody
              └─ EVM chains / Calibur agent registration
```

## 2. Entry points

| Area | File | Responsibility |
| --- | --- | --- |
| Backend bootstrap | `src/main.ts` | Nest bootstrap, helmet, body limits, CORS, trust proxy, validation pipe, exception filter |
| Backend module graph | `src/app.module.ts` | Module wiring, config validation, throttling, request context/middleware |
| Data model | `prisma/schema.prisma` | Canonical PostgreSQL schema |
| Public API spec | `openapi.yaml` | Public API-key endpoints only |
| Frontend bootstrap | `frontend/src/main.tsx` | React SPA entrypoint and providers |
| Frontend API client | `frontend/src/lib/api.ts` | Dashboard IAM fetches and public API-key fetch helpers |
| Repo atlas | `codemap.md` | Generated navigation map; read before deep work |

## 3. Backend module boundaries

### `AuthModule`

- Synchronizes Openfort IAM users into local `User` rows.
- Returns wallet/authorization state for dashboard sessions.
- Handles embedded-wallet authorization and Calibur agent-key registration lifecycle.
- Provides compatibility alias `POST /auth/social` for older frontend builds.

### `ApiKeyModule`

- Creates, lists, revokes, and refreshes API keys for dashboard users.
- Stores only Argon2id hashes and lookup prefixes.
- Enforces active-key limits, unique active names, expiry/IP constraints, and audit events.
- Must remain dashboard-only; API keys cannot manage API keys.

### `WalletModule`

- Frontend-only wallet data/actions: balances, deposit info, withdrawals.
- Public API-key signing: `POST /v1/wallets/sign`.
- Signing uses Openfort-managed keys and records signing audits.

### `TransactionsModule`

- Owns public transaction send/status APIs.
- Validates API-key-only access.
- Persists transaction status, request hashes, idempotency, and API-key attribution snapshots.
- Must not be folded into `WalletModule`.

### `Core` and `Common`

- `src/core/database`: Prisma service lifecycle.
- `src/core/openfort`: Openfort SDK wrapper and TEE wallet interactions.
- `src/common/guards`: Openfort/API-key/frontend-only/auth split enforcement.
- `src/common/filters`: stable error response formatting.
- `src/common/middleware` and `src/common/request-context`: request IDs and request-scoped metadata.

## 4. Access-control model

There are two intentionally separate API surfaces.

### Public API-key surface

These routes require `X-API-Key` and must reject dashboard IAM-only access:

- `POST /v1/wallets/sign`
- `POST /v1/transactions/send`
- `GET /v1/transactions/:id`

### Dashboard/frontend surface

These routes require Openfort IAM bearer auth and frontend-origin/referer checks where marked frontend-only:

- `GET /v1/wallets/balances`
- `POST /v1/wallets/deposit-info`
- `POST /v1/wallets/withdraw`
- `GET /v1/api-keys`
- `POST /v1/api-keys`
- `DELETE /v1/api-keys/:id`
- selected `/auth/*` dashboard operations such as API-key refresh

Do not add `FrontendOnlyGuard` to public API-key endpoints. Do not allow API-key auth on API-key management endpoints.

## 5. Core flows

### 5.1 Session synchronization

```text
Browser obtains Openfort IAM token
  → POST /auth/session
  → OpenfortAuthGuard verifies token
  → AuthService find-or-create local User
  → return wallet and authorization state
```

### 5.2 Embedded wallet and agent authorization

```text
Dashboard user authorizes embedded wallet
  → POST /auth/embedded-wallet/authorize
  → AuthService verifies embedded EOA belongs to IAM session
  → local UserWallet is bound to Openfort account/address
  → backend agent registration details returned
  → dashboard submits/records Calibur registerKey transaction
  → WalletChainAuthorization stores per-chain status
```

### 5.3 API-key creation

```text
Dashboard user
  → POST /v1/api-keys
  → OpenfortUserGuard + FrontendOnlyGuard
  → ApiKeyService validates limits/name/expiry/IP allowlist
  → generate raw secret
  → store Argon2id hash + keyPrefix only
  → audit ApiKeyEvent
  → return raw secret once
```

### 5.4 Public signing

```text
API client
  → POST /v1/wallets/sign with X-API-Key
  → EitherAuthGuard resolves API-key user
  → ApiKeyOnlyGuard rejects non-API-key access
  → WalletService validates request and user wallet
  → SigningRequest audit row created
  → Openfort signs inside TEE custody
  → return signature metadata; never private keys
```

### 5.5 Public transaction submission

```text
API client
  → POST /v1/transactions/send with X-API-Key
  → request DTO validates chain/interactions/idempotency
  → TransactionsService loads UserWallet + authorization context
  → Openfort submits transaction/UserOperation
  → Transaction row stores status, tx hash, request hash, API-key snapshot
  → return transaction ID/hash/status
```

### 5.6 Safe transaction status

```text
API client
  → GET /v1/transactions/:id with X-API-Key
  → ownership and API-key user verified
  → return safe public fields only
  → do not return calldata, requestHash, or interactionsHash
```

## 6. Data architecture

Canonical data model lives in `prisma/schema.prisma`:

- `User`: local Openfort IAM user mapping.
- `UserWallet`: one wallet record per user; stores Openfort account IDs and agent metadata.
- `WalletChainAuthorization`: per-chain Calibur agent-key registration state.
- `ApiKey`: hashed API-key records with prefixes, expiry/IP metadata, and revocation state.
- `ApiKeyEvent`: immutable API-key lifecycle audit events.
- `Transaction`: transaction submission status and API-key attribution snapshot.
- `SigningRequest`: signing audit status and request digest metadata.

See [DATABASE.md](./DATABASE.md) for invariants and migration workflow.

## 7. Runtime/security middleware

- Helmet is enabled with restrictive default CSP for API responses.
- Request body size is limited to `100kb` for JSON and URL-encoded payloads.
- CORS defaults to local frontend origins in development and requires explicit `CORS_ORIGIN` in production.
- `TRUST_PROXY` is false by default in development and must be explicit IP/CIDR values in production.
- Global `ValidationPipe` uses `whitelist`, `forbidNonWhitelisted`, and `transform`.
- Global throttling is configured for 20 requests/10s and 100 requests/60s, with stricter route-level throttles on sensitive endpoints.
- A global exception filter returns stable error objects with request IDs.

## 8. Frontend architecture

- Vite 6 + React 19 + React Router 7 + Tailwind CSS 4.
- Dashboard routes are protected by frontend auth checks and backed by Openfort IAM calls.
- `frontend/src/lib/api.ts` centralizes API calls:
  - dashboard routes use bearer-token authenticated fetches;
  - public examples use API-key fetches only for public API-key endpoints.
- Local dev can leave `VITE_API_URL` unset to use the Vite `/api` proxy.

## 9. Extension rules

- Add new public endpoints to `openapi.yaml` only if they are intended for third-party API-key clients.
- Keep dashboard-only endpoints out of `openapi.yaml`.
- Add new modules when a feature has a distinct responsibility; do not create speculative abstractions.
- Prefer small DTOs and service methods with explicit validation over generic request handlers.
- Update requirements, architecture, API docs, and security docs in the same change that alters their source-of-truth behavior.

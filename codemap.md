# Repository Atlas: sofa-agent-wallet (SOFA ONE)

## Project Responsibility
Server-side automated blockchain signing service. Users authenticate via Openfort IAM (email OTP / embedded wallet), receive a TEE-managed wallet (Openfort), and an API key for programmatic transaction submission. NestJS backend + Vite/React 19 SPA.

## System Entry Points
- `src/main.ts` — NestJS bootstrap, global middleware, Swagger, port 3100
- `src/app.module.ts` — Root module composition
- `frontend/src/main.tsx` — React SPA entry, Openfort + Router providers
- `prisma/schema.prisma` — Data model definition
- `openapi.yaml` — REST API specification

## Key Architecture Constraints
- Private keys never leave TEE (Openfort). Never store, log, or return them.
- Public signing and transaction submission require `X-API-Key`; Openfort IAM tokens are not accepted for these public API routes, and API-key permissions are enforced before service code runs.
- Frontend-only routes additionally require `FrontendOnlyGuard`, which checks `Origin`/`Referer` against `CORS_ORIGIN` allowlist.
- API keys are stored as Argon2 hashes; new `keyPrefix` values are 27 chars and all lookup candidates are Argon2-verified to tolerate collisions and legacy 11-char prefixes.
- API-key management is dashboard-only (Openfort IAM) with lifecycle limits: maximum 10 active keys, unique non-empty active names, supported chains only, bounded future expiry, freeze metadata, and audited create/revoke/rotate events.
- `UserWallet.openfortAccountId` is the FK into Openfort — never overwrite or orphan.

## Directory Map (Aggregated)

### Backend (`src/`)

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Application bootstrap, global module composition, NestJS entry point | [View Map](src/codemap.md) |
| `src/config/` | Environment variable loading and validation via class-validator | [View Map](src/config/codemap.md) |
| `src/common/` | Shared utilities container (decorators, filters, guards) | [View Map](src/common/codemap.md) |
| `src/common/decorators/` | Custom parameter decorators: `@CurrentUser()`, `@Public()` | [View Map](src/common/decorators/codemap.md) |
| `src/common/filters/` | Global HTTP exception filter for standardized error responses | [View Map](src/common/filters/codemap.md) |
| `src/common/guards/` | Auth guards: Openfort IAM verification + API key validation | [View Map](src/common/guards/codemap.md) |
| `src/core/` | Infrastructure layer: database + Openfort client, globally exported | [View Map](src/core/codemap.md) |
| `src/core/database/` | Prisma ORM service with lifecycle hooks (onModuleInit/onModuleDestroy) | [View Map](src/core/database/codemap.md) |
| `src/core/openfort/` | Openfort SDK wrapper for TEE wallet creation and transaction intents | [View Map](src/core/openfort/codemap.md) |
| `src/modules/` | Feature modules container | [View Map](src/modules/codemap.md) |
| `src/modules/auth/` | Social OAuth via Openfort, user sync, and wallet provisioning | [View Map](src/modules/auth/codemap.md) |
| `src/modules/api-key/` | API key lifecycle: create (Argon2 hash), list metadata, revoke | [View Map](src/modules/api-key/codemap.md) |
| `src/modules/api-key/dto/` | Input DTOs for API key creation with class-validator decorators | [View Map](src/modules/api-key/dto/codemap.md) |
| `src/modules/wallet/` | Wallet operations: deposit info, message/typed-data signing, USDC withdrawal | [View Map](src/modules/wallet/codemap.md) |
| `src/modules/wallet/dto/` | Input DTOs for signing and withdrawal requests with Ethereum address validation | [View Map](src/modules/wallet/dto/codemap.md) |
| `src/modules/transactions/` | Public transaction submission service and controller for Openfort-backed sends | [View Map](src/modules/transactions/codemap.md) |
| `src/modules/transactions/dto/` | Transaction request validation DTOs for interactions and idempotency | [View Map](src/modules/transactions/dto/codemap.md) |
| `src/modules/security-events/` | Unified security-event write service for audit, risk, and alerting workflows | [View Map](src/modules/security-events/codemap.md) |

### Data Layer

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `prisma/` | Postgres data model for users, wallets, API keys, transactions, and signing audit; migration history | [View Map](prisma/codemap.md) |

#### `prisma/` Responsibility
- Defines the canonical database schema for auth, wallet provisioning, API key management, transaction tracking, and signing audit.
- Encodes field types, constraints, defaults, unique keys, and table mappings for PostgreSQL.

#### `prisma/` Design / Patterns
- Prisma code-first schema using explicit `@@map` / `@map` naming to keep snake_case DB tables/columns while exposing camelCase model fields.
- UUID primary keys across models; relations are modeled with foreign keys and one-to-one / one-to-many constraints.
- Sensitive lookup fields use normalized storage patterns (`keyPrefix` lookup hint plus hashed API keys, unique wallet identifiers).

#### `prisma/` Flow
- User authenticates via Openfort IAM → `User` row is created or reused.
- Wallet provisioning creates `UserWallet` tied 1:1 to `User` with `openfortAccountId`, `walletAddress`, `chainId`, and `status`.
- API key issuance stores only `apiKeyHash`, extended `keyPrefix`, optional metadata, IP allowlist, and optional freeze state in `ApiKey`; lifecycle events are recorded in `ApiKeyEvent`.
- Cross-cutting security telemetry is recorded in `SecurityEvent` with user/API-key/wallet attribution, risk level, request context, and safe metadata.
- Transaction submission appends `Transaction` records with intent/hash/status/details for audit and reconciliation.
- Agent execution authority is anchored by the Calibur on-chain key registry; no off-chain strategy ownership table is used.

#### `prisma/` Integration
- Consumed by NestJS services through the generated Prisma Client in `src/core/database` and feature modules.
- Backed by PostgreSQL via `DATABASE_URL`; migrations live in `prisma/migrations`.
- Supports Openfort wallet lifecycle, API key verification, and transaction auditing used by auth, wallet, and API-key modules.

### Frontend (`frontend/`)

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `frontend/` | Vite build config, Tailwind CSS 4, path aliasing, dev proxy to port 3100 | [View Map](frontend/codemap.md) |
| `frontend/src/` | App entry point, React Router routes, Openfort provider composition | [View Map](frontend/src/codemap.md) |
| `frontend/src/components/` | Shared UI: `ProtectedRoute` HOC for auth-gated navigation | [View Map](frontend/src/components/codemap.md) |
| `frontend/src/lib/` | API abstraction layer: `authFetch` (JWT) and `apiFetch` (API key) helpers | [View Map](frontend/src/lib/codemap.md) |
| `frontend/src/pages/` | Public pages: landing, sign-in via Openfort email OTP | [View Map](frontend/src/pages/codemap.md) |
| `frontend/src/pages/dashboard/` | Authenticated dashboard: wallet info, API key management, docs | [View Map](frontend/src/pages/dashboard/codemap.md) |

## Data Flow (High Level)
```
Browser → Openfort IAM → POST /v1/auth/social
  → AuthService: find-or-create User + pending Wallet record
  → Returns { userId, wallet }

Client → POST /v1/wallets/sign (X-API-Key only)
  → ApiKeyAuthGuard resolves API key user, rejects frozen keys, and freezes suspicious high-risk/repeated context changes; ApiKeyPermissionGuard requires canSign
  → WalletService hashes message/typedData input as needed; raw hash signing is disabled
  → SigningRequest audit row records API-key attribution snapshot
  → OpenfortService.signData signs with TEE-managed backend wallet
  → Returns { signature, walletAddress, type }

Client → POST /v1/transactions/send (X-API-Key only)
  → ApiKeyAuthGuard resolves API key user, rejects frozen keys, and freezes suspicious high-risk/repeated context changes; ApiKeyPermissionGuard requires canSendTransaction
  → TransactionsService loads UserWallet chain/account data
  → OpenfortService.sendTransaction submits interactions
  → Transaction row persists request/interactions hashes and API-key attribution snapshot for audit/idempotency
  → Returns { transactionId, transactionHash, status }

Client → GET /v1/transactions/:id (X-API-Key only)
  → ApiKeyPermissionGuard requires canReadTransactionStatus before service ownership checks
  → Returns the locally stored sendTransaction result/status
  → Returns safe status fields only; never returns calldata, requestHash, or interactionsHash
```

# Repository Atlas: sofa-agent-wallet (SOFA ONE)

## Project Responsibility
Server-side automated blockchain signing service. Users authenticate via Openfort IAM (email OTP / embedded wallet), receive a TEE-managed wallet (Openfort), and an API key for programmatic transaction submission. The repository also owns usage-based billing with Stripe and native USDC settlement. NestJS backend + Vite/React 19 SPA.

## System Entry Points
- `src/main.ts` — NestJS bootstrap, global middleware, Swagger, and env-selected port (default 3001; local `.env` uses 3100)
- `src/app.module.ts` — Root module composition
- `frontend/src/main.tsx` — React SPA entry, Openfort + Router providers
- `prisma/schema.prisma` — Data model definition
- `openapi.yaml` — REST API specification
- `package.json` — backend scripts, dependencies, and Jest configuration
- `frontend/package.json` — independent SPA scripts and dependencies
- `docker-compose.yml` — local Postgres 16 and Redis 7 services

## Key Architecture Constraints
- Private keys never leave TEE (Openfort). Never store, log, or return them.
- Public signing and transaction submission require `X-API-Key`; Openfort IAM tokens are not accepted for these public API routes, and API-key permissions are enforced before service code runs.
- Frontend-only routes additionally require `FrontendOnlyGuard`, which checks `Origin`/`Referer` against `CORS_ORIGIN` allowlist.
- API keys are stored as Argon2 hashes; new `keyPrefix` values are 27 chars and all lookup candidates are Argon2-verified to tolerate collisions and legacy 11-char prefixes.
- API-key management is dashboard-only (Openfort IAM) with lifecycle limits: maximum 10 active keys, unique non-empty active names, supported chains only, bounded future expiry, freeze metadata, and unified `SecurityEvent` audit for create/revoke/rotate/first-use/suspicious-use/freeze events.
- API keys grant DeFi capabilities only through exact `allowedCapabilityIds` (omission defaults to `[]`, which denies all). The versioned package/catalog default remains the accepted v9 snapshot: 673 definitions (650 actions, 23 independent approvals), 16 scopes, and 69 profiles / 399 IDs. The generated production registry has 747 definitions (724 actions, 23 approvals), with the same 16 scopes and 69 profiles / 399 IDs, including the Vesper vaETH and vUSDC admissions, YieldNest ynETH payable deposit, dForce iUSDC/iUSDT/iDAI mint/redeem, and Origin WOETH/WOUSD ERC4626 deposit/mint/withdraw/redeem admissions. Exact plan-bound admissions add no profile, scope, grant, delegation, financial-argument limits, or approval pairing. Dated qualification/catalog inclusion proves neither current runtime identity nor funding, liquidity, complete workflows, PostgreSQL concurrency, or financial safety. See the [Origin WOUSD update](docs/defi-research/origin-wousd-update.md), [Origin WOETH update](docs/defi-research/origin-woeth-update.md), [dForce iUSDT/iDAI update](docs/defi-research/dforce-iusdt-idai-update.md), [dForce iUSDC update](docs/defi-research/dforce-iusdc-update.md), [YieldNest ynETH deposit update](docs/defi-research/yieldnest-yneth-deposit-update.md), [Vesper production vUSDC update](docs/defi-research/vesper-vusdc-prod-update.md), [Vesper vaETH update](docs/defi-research/vesper-vaeth-deposit-update.md), [Maple Pool V2 update](docs/defi-research/maple-pool-v2-update.md), [syrupUSDG update](docs/defi-research/maple-usdg-pool-v2-update.md), [Spark spUSDC update](docs/defi-research/spark-spusdc-v2-update.md), [Spark spUSDT/spPYUSD update](docs/defi-research/spark-spusdt-sppyusd-v2-update.md), [Spark spETH update](docs/defi-research/spark-speth-v2-update.md), [Dinero AutoPxEth update](docs/defi-research/dinero-apxeth-update.md), [Stader ETHx update](docs/defi-research/stader-ethx-update.md), [Ankr ETH staking update](docs/defi-research/ankr-eth-staking-update.md), [Mantle mETH staking update](docs/defi-research/mantle-meth-staking-update.md), and [Liquid Collective River deposit update](docs/defi-research/liquid-collective-deposit-update.md).
- User, API-key, and wallet freeze state is modeled explicitly; frozen users are rejected by dashboard and API-key auth, frozen API keys are rejected by `ApiKeyAuthGuard`, and frozen wallets cannot sign, send, withdraw, expose deposit info, or fetch balances.
- User-facing security alerts are derived from selected `SecurityEvent` rows into dashboard-only `SecurityNotification` records; an optional SIEM webhook exports every persisted security event as a redacted JSON payload.
- Dashboard withdrawals are checked by a dedicated withdrawal policy service before balance checks or Openfort submission; policy denies, high-value withdrawal requests, and withdrawal-address changes are written to `SecurityEvent`.
- `UserWallet.openfortAccountId` is the FK into Openfort — never overwrite or orphan.

## Directory Map (Aggregated)

### Backend (`src/`)

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Application bootstrap, global module composition, NestJS entry point | [View Map](src/codemap.md) |
| `src/config/` | Environment variable loading and validation via class-validator | [View Map](src/config/codemap.md) |
| `src/common/` | Shared cross-cutting layer: auth/permission guards, request plumbing, registries, throttling, and pure security utilities | [View Map](src/common/codemap.md) |
| `src/common/agent/` | Agent-registration status vocabulary and lifecycle type derivation | [View Map](src/common/agent/codemap.md) |
| `src/common/api-key/` | API-key prefix and lookup-prefix derivation | [View Map](src/common/api-key/codemap.md) |
| `src/common/calibur/` | Calibur EIP-7702 ABI, key hashing, settings, and viem account helpers | [View Map](src/common/calibur/codemap.md) |
| `src/common/chains/` | Supported-chain registry and chain classification helpers | [View Map](src/common/chains/codemap.md) |
| `src/common/decorators/` | Custom parameter decorators: `@CurrentUser()`, `@Public()` | [View Map](src/common/decorators/codemap.md) |
| `src/common/errors/` | Stable machine-readable API error-code vocabulary | [View Map](src/common/errors/codemap.md) |
| `src/common/filters/` | Global HTTP exception filter for standardized error responses | [View Map](src/common/filters/codemap.md) |
| `src/common/guards/` | Auth guards: Openfort IAM verification + API key validation | [View Map](src/common/guards/codemap.md) |
| `src/common/middleware/` | Request-ID resolution and AsyncLocalStorage context seeding | [View Map](src/common/middleware/codemap.md) |
| `src/common/request-context/` | Request-scoped correlation context backed by AsyncLocalStorage | [View Map](src/common/request-context/codemap.md) |
| `src/common/throttler/` | Redis-backed throttling with in-memory fallback | [View Map](src/common/throttler/codemap.md) |
| `src/common/utils/` | Pure IP/CIDR, request-hash, and sanitization helpers | [View Map](src/common/utils/codemap.md) |
| `src/core/` | Infrastructure layer: database + Openfort client, globally exported | [View Map](src/core/codemap.md) |
| `src/core/database/` | Prisma ORM service with lifecycle hooks (onModuleInit/onModuleDestroy) | [View Map](src/core/database/codemap.md) |
| `src/core/openfort/` | Openfort SDK wrapper for TEE wallet creation and transaction intents | [View Map](src/core/openfort/codemap.md) |
| `src/types/` | Express request ambient type augmentation for middleware and guards | [View Map](src/types/codemap.md) |
| `src/modules/` | Feature modules container | [View Map](src/modules/codemap.md) |
| `src/modules/auth/` | Social OAuth via Openfort, user sync, and wallet provisioning | [View Map](src/modules/auth/codemap.md) |
| `src/modules/auth/dto/` | Embedded-wallet authorization and agent-registration request DTOs | [View Map](src/modules/auth/dto/codemap.md) |
| `src/modules/api-key/` | API key lifecycle: create (Argon2 hash), list metadata, revoke | [View Map](src/modules/api-key/codemap.md) |
| `src/modules/api-key/dto/` | Input DTOs for API key creation with class-validator decorators | [View Map](src/modules/api-key/dto/codemap.md) |
| `src/modules/billing/` | Plans, usage metering, quotas, invoices, Stripe/USDC payment rails, and reconciliation | [View Map](src/modules/billing/codemap.md) |
| `src/modules/billing/dto/` | Validated request bodies and queries for dashboard billing operations | [View Map](src/modules/billing/dto/codemap.md) |
| `src/modules/billing/stripe/` | Stripe Checkout client and signature-verified webhook processing | [View Map](src/modules/billing/stripe/codemap.md) |
| `src/modules/billing/onchain/` | Native USDC quote/claim flow and strict receipt verification | [View Map](src/modules/billing/onchain/codemap.md) |
| `src/modules/billing/onchain/dto/` | Validated USDC quote and claim request DTOs | [View Map](src/modules/billing/onchain/dto/codemap.md) |
| `src/modules/wallet/` | Wallet operations: deposit info, message/typed-data signing, USDC withdrawal | [View Map](src/modules/wallet/codemap.md) |
| `src/modules/wallet-provisioning-recovery/` | Operator-only support for binding an already-created provider account to its matching provisioning intent; no HTTP route or automatic create retry/reset | [View Map](src/modules/wallet-provisioning-recovery/codemap.md) |
| `src/modules/wallet/dto/` | Input DTOs for signing and withdrawal requests with Ethereum address validation | [View Map](src/modules/wallet/dto/codemap.md) |
| `src/modules/transactions/` | Public transaction submission service and controller for Openfort-backed sends | [View Map](src/modules/transactions/codemap.md) |
| `src/modules/defi/` | Exact function-level DeFi catalog, explicit grants, pause overlay, finite scoped execution, offline compiler and versioned profiles; accepted v9 snapshot has 673 definitions, while current production has 743 definitions (720 actions, 23 approvals), 16 scopes, and 69 profiles / 399 IDs | [View Map](src/modules/defi/codemap.md) |
| `src/modules/transactions/dto/` | Transaction request validation DTOs for interactions and idempotency | [View Map](src/modules/transactions/dto/codemap.md) |
| `src/modules/security-events/` | Unified security-event write service for audit, risk, and alerting workflows | [View Map](src/modules/security-events/codemap.md) |
| `src/modules/security-notifications/` | Dashboard security notifications generated from user-attributed security events | [View Map](src/modules/security-notifications/codemap.md) |
| `src/modules/eoa-execution/` | Runtime isolation policy for high-privilege backend EOA execution | [View Map](src/modules/eoa-execution/codemap.md) |
| `src/modules/session-key/` | On-chain Calibur session-key policy gate for delegated execution | [View Map](src/modules/session-key/codemap.md) |
| `src/modules/step-up/` | Short-lived TOTP step-up proof issuance and validation | [View Map](src/modules/step-up/codemap.md) |
| `src/modules/mfa/` | TOTP setup, verification, recovery codes, and proof issuance | [View Map](src/modules/mfa/codemap.md) |
| `src/modules/mfa/dto/` | Validated TOTP and recovery-code request shapes | [View Map](src/modules/mfa/dto/codemap.md) |
| `src/modules/health/` | Public liveness and readiness probes | [View Map](src/modules/health/codemap.md) |

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
- Wallet provisioning creates one of a user's `UserWallet` rows with `openfortAccountId`, `walletAddress`, `chainId`, and `status`; `User.wallets` is one-to-many and a persisted default supports compatibility projection only.
- API key issuance stores only `apiKeyHash`, extended `keyPrefix`, optional metadata, IP allowlist, and optional freeze state in `ApiKey`; lifecycle events are recorded in `ApiKeyEvent`.
- Cross-cutting security telemetry is recorded in `SecurityEvent` with user/API-key/wallet attribution, rule-based risk scoring, request context, safe metadata, optional dashboard notifications, and optional redacted SIEM webhook export.
- User-facing dashboard alerts are stored in `SecurityNotification` when selected security events require user attention.
- Transaction submission appends `Transaction` records with request/hash/status/details for audit, idempotency, and reconciliation.
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
| `frontend/src/components/` | Openfort/provider composition, route guards, MFA step-up gate, and shared UI/diagnostics | [View Map](frontend/src/components/codemap.md) |
| `frontend/src/lib/` | Typed bearer/API-key HTTP transports, chain metadata, and Calibur encoders | [View Map](frontend/src/lib/codemap.md) |
| `frontend/src/pages/` | Public landing/sign-in routes and authenticated dashboard boundary | [View Map](frontend/src/pages/codemap.md) |
| `frontend/src/pages/dashboard/` | Authenticated wallet, API-key, transaction, billing, notification, and docs screens | [View Map](frontend/src/pages/dashboard/codemap.md) |

## Root Assets and Documentation

| Asset | Purpose |
|-------|---------|
| `package.json` / `package-lock.json` | Backend NestJS, Prisma, Jest, lint, and formatting scripts plus locked dependencies |
| `frontend/package.json` / `frontend/package-lock.json` | Independent Vite/React package scripts and locked dependencies |
| `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `.eslintrc.js` | Backend TypeScript, Nest CLI, and lint/build configuration |
| `prisma/schema.prisma`, `prisma/migrations/` | Canonical PostgreSQL schema and versioned migration history; see [`prisma/codemap.md`](prisma/codemap.md) |
| `openapi.yaml` | Public API-key contract only: signing and transaction send/status; dashboard routes are intentionally excluded |
| `docker-compose.yml` | Local Postgres 16 and Redis 7 services with loopback port bindings and health checks |
| `.env.example` and runtime env files | Backend configuration template; secrets and local values are not part of the codemap |
| `test/` and `src/**/*.spec.ts` | E2E/unit tests; excluded from generated codemap analysis, but validate the mapped production code |
| `README.md`, `API.md`, `ARCHITECTURE.md`, `PRICING.md`, `SECURITY.md`, `DATABASE.md`, `DEPLOYMENT.md`, `RUNBOOK.md`, `REQUIREMENTS.md`, `docs/` | Product, API, architecture, pricing, security, operations, and design documentation |
| `src/modules/wallet-provisioning-recovery/README.md` | Operator procedure and safety requirements for binding a known existing provider account; not an API capability |

The generated hierarchy is tracked by `.slim/codemap.json`. This root file is the master
entry point; each linked child map records the implementation-specific responsibility,
patterns, flow, and integration points for its directory.

## Data Flow (High Level)
```
Browser → Openfort IAM → POST /auth/session
  → AuthService: find-or-create User + pending Wallet record
  → Returns { userId, wallet }

Client → POST /v1/wallets/sign (X-API-Key only)
  → ApiKeyAuthGuard + ApiKeyPermissionGuard require canSign
   → Only exact Polymarket CLOB ClobAuth typed-data bootstrap on Polygon (137), EOA mode, with explicit polymarket:137:clob-auth:v1 grant is eligible; all other message/typed-data signing remains denied
   → EOA isolation, destination allowlist/protection, risk/signing-policy and frozen-state checks remain enforced; grant, pause, live-key and bound-digest acceptance are rechecked at atomic SigningRequest creation before Openfort

Client → POST /v1/transactions/send (X-API-Key only)
  → ApiKeyAuthGuard resolves API key user, rejects frozen users/keys, and freezes suspicious high-risk/repeated context changes; ApiKeyPermissionGuard requires canSendTransaction
  → EOA execution requests pass through the same EOA isolation policy before wallet loading or Openfort submission
   → TransactionPolicyService enforces generic limits independently; DefiPolicyService checks catalog function/grant and canonical ABI
  → TransactionsService loads UserWallet chain/account data and rejects frozen wallets before idempotency or Openfort submission
  → After outer idempotency miss, DeFi authorization runs before destination protection, billing, simulation, Transaction creation, and Openfort
  → In the final create transaction, destination → pause SHARE → API-key UPDATE locks recheck live state at READ COMMITTED
  → TransactionSimulationService performs minimal provider `eth_call` preflight for each interaction; simulation allow/deny is recorded as `SecurityEvent` with safe metadata only
  → OpenfortService.sendUserOperation/sendBackendTransaction submits interactions
  → Transaction row persists request/interactions hashes and API-key attribution snapshot for audit/idempotency
  → Returns { transactionId, transactionHash, status }

  Grants are exact `allowedCapabilityIds`; omitted create grants and rotation use `[]`, PATCH replaces the full set, and removal has no backfill. Pause is an overlay that grants cannot override. Dedicated withdrawal and billing-payment flows remain independent of generic-send authorization.

Dashboard → POST /v1/wallets/withdraw (Openfort IAM + FrontendOnly + step-up)
  → WithdrawalPolicyService enforces single/daily USDC limits and optional address allowlist cooldown, recording policy denies and high-value requests in `SecurityEvent`
  → WalletService rejects frozen wallets, then checks idempotency and balance before submitting a Calibur agent user operation through Openfort
  → Transaction row persists withdrawal request hash/details for audit/idempotency

Dashboard → POST /v1/wallets/withdrawal-addresses (Openfort IAM + FrontendOnly + step-up)
  → WithdrawalPolicyService enables address allowlist policy, normalizes the EVM address, records a 24h/default cooldown window, and writes allowlist lifecycle `SecurityEvent` rows
  → Later withdrawals to that address are blocked until `availableAt`

Dashboard → GET /v1/security-notifications (Openfort IAM + FrontendOnly)
  → SecurityNotificationService returns recent user-facing security alerts derived from `SecurityEvent` rows
  → Dashboard can mark individual notifications or all unread notifications as read

Dashboard → `/v1/billing/*` (Openfort IAM + FrontendOnly)
  → Billing summary/invoice endpoints expose plan, usage, invoice, and payment state
  → API-key guards meter API calls; `BillingWalletLifecycleService` serializes wallet reservations and activation quota/peak accounting
  → BillingReconciliationService matches receipt-confirmed outbound usage to transactions
  → BillingService prepares wallet evidence in a separate account-row-locked transaction, then computes/finalizes from the persisted UTC-period concurrent-eligible-wallet peak; missing historical evidence fails closed
  → Wallet activation is subject to a hard included-wallet cap; wallet overage is always zero and no wallet overage line is added
  → Finalized invoice snapshots remain immutable
  → Stripe Checkout or native USDC quote/claim creates payment evidence; InvoiceSettlementService performs atomic first-rail-wins settlement
  → BillingWorkerService (registered in `BillingModule` via `ScheduleModule.forRoot()`, 5-minute `@Interval`) also drives receipt-reconciliation drain, invoice finalization catch-up, recurring-period materialization, USDC claim recovery, deferred Stripe renewal retry, and pending-checkout recovery — but only when `BILLING_WORKER_ENABLED=true` (default safely off). It runs inside the long-running API/worker instance, not a separate process binary

Backend → SecurityEventService
  → Authentication, API-key lifecycle, policy decisions, withdrawals, billing, and on-chain payment decisions persist safe telemetry
  → SecurityNotificationService projects selected user-facing alerts and an optional SIEM exporter sends redacted payloads

Client → GET /v1/transactions/:id (X-API-Key only)
  → ApiKeyPermissionGuard requires canReadTransactionStatus before service ownership checks
  → Returns the locally stored sendTransaction result/status
  → Returns safe status fields only; never returns calldata, requestHash, or interactionsHash
```

## Integration and Runtime Boundaries

- **Backend composition:** `src/app.module.ts` imports validated global configuration,
  request context, throttling, Prisma/Openfort infrastructure, and every feature module.
  `src/main.ts` adds trust-proxy handling, Helmet/CSP, raw-body capture for Stripe, CORS,
  strict global validation, request correlation, and the sanitized exception filter.
- **Persistence:** feature services use the global `PrismaService` against PostgreSQL;
  `prisma/schema.prisma` contains identity, wallet, API-key, transaction, security, MFA,
  and billing models. Interactive transactions and row locks protect idempotency, quota,
  withdrawal, usage-ledger, and invoice-settlement races.
- **Execution:** `OpenfortService` is the only wallet/signing facade. It routes chain
  execution through Openfort or Pimlico/viem as appropriate; Calibur session-key and the
  explicitly isolated backend-EOA mode are policy-gated before submission.
- **Frontend:** `frontend/` is a separate Vite package. Dashboard calls use IAM bearer
  helpers; only the public signing/transaction examples use API-key helpers. In development
  Vite proxies `/api` to the backend and strips the prefix.
- **Public contract:** `openapi.yaml` intentionally documents only `X-API-Key` public
  signing and transaction routes. Dashboard, billing, auth, health, and webhook routes are
  internal/frontend-only or independently authenticated and are not added to that spec.

## Operational Constraints

- Private keys never enter this repository's persistence, logs, responses, or local signing
  code; Openfort TEE owns key management and signing.
- Public API-key routes and frontend-only IAM routes remain separate. Never add
  `FrontendOnlyGuard` to public routes or expose API-key management to API keys.
- API keys are Argon2id hashes; prefix matches are only lookup hints and every candidate must
  be verified. `request.ip` after Express trust-proxy handling is the source for IP allowlists.
- Production configuration fails closed: required secrets, explicit CORS origin, explicit
  trust-proxy values, supported chains, HTTPS optional-integration URLs, and enabled Stripe/
  USDC prerequisites are validated at startup.
- Public status/error/billing responses are sanitized: no private keys, API keys, calldata,
  request/interactions hashes, raw receipts, RPC details, Openfort IDs, or secrets.
- Redis is used for throttling when available, with an in-memory fallback that still limits;
  billing metering and high-risk policy checks fail closed rather than bypassing enforcement.
- Schema changes require `npm run prisma:generate`; use migration deploy for production and
  preserve migration-only partial indexes/check constraints.

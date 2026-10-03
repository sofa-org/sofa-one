# Code Map for /src

## Responsibility

Backend root for SOFA ONE: a NestJS API that bootstraps the HTTP server, composes global
infrastructure, and wires every feature module. It is the single entry point that turns
validated environment configuration into a running application exposing two distinct API
surfaces:

- **Public API-key surface** (documented in `openapi.yaml`): `POST /v1/wallets/sign`,
  `POST /v1/transactions/send`, `GET /v1/transactions/:id` — programmatic, authenticated
  by `X-API-Key`.
- **Frontend-only dashboard surface** (intentionally omitted from `openapi.yaml`): wallet
  balances/deposit/withdraw, API-key management, billing, MFA, security notifications,
  auth/onboarding — authenticated by Openfort IAM bearer token plus origin/referer checks.

The root owns no business logic itself; it composes the layers below (`config`, `common`,
`core`, `modules`, `types`) and enforces cross-cutting concerns (validation, error
formatting, throttling, request correlation) globally.

## Directory Map

| Path | Responsibility |
| --- | --- |
| `main.ts` | HTTP bootstrap: trust-proxy, helmet/CSP, body limits + raw-body capture, CORS, global validation pipe + exception filter, listen. |
| `app.module.ts` | Root module: env config, throttling, request context, core + all feature modules; global `ApiKeyThrottlerGuard`; `RequestIdMiddleware` for all routes. |
| `main.spec.ts` | Unit tests for `parseTrustProxy` (production fail-closed behavior). |
| `config/` | Single source of truth for env vars: `configuration.ts` factory + `env.validation.ts` fail-fast class-validator schema. |
| `common/` | Shared cross-cutting building blocks: guards, decorators, filters, middleware, throttler, request-context, utils, errors, chains, calibur, api-key, agent. |
| `core/` | Infrastructure layer: `database/` (Prisma global module) and `openfort/` (Openfort SDK + viem/ERC-4337 facade). |
| `modules/` | Feature modules: auth, api-key, wallet, transactions, health, step-up, mfa, security-events, security-notifications, billing, eoa-execution, session-key. |
| `types/` | Global ambient Express type augmentation (`express.d.ts`) for request-scoped fields. |
| `scripts/recover-wallet-provisioning.ts` | Operator-only recovery utility for binding an existing provider account to its provisioning intent; outside NestJS and not an HTTP endpoint. |

## System Entry Points

- **`src/main.ts`** — `bootstrap()` creates the `NestExpressApplication` (`rawBody: true`),
  sets `trust proxy` via `parseTrustProxy` (production requires explicit IP/CIDR; `true`/`1`
  rejected), applies helmet (CSP `default-src 'none'`), `express.json`/`urlencoded` with
  `100kb` limits (JSON `verify` captures `rawBody` for Stripe webhook signature checks),
  enables CORS (production requires non-empty `CORS_ORIGIN`; dev defaults to
  `localhost:3000`/`3100`), installs the global `ValidationPipe`
  (`whitelist`/`forbidNonWhitelisted`/`transform`) and `HttpExceptionFilter`, then listens on
  `PORT` (default `3001`; `.env` uses `3100`).
- **`src/app.module.ts`** — `ConfigModule.forRoot({ isGlobal, load: [configuration], validate })`
  (fail-fast env validation), `AppThrottlerModule` (global rate limiting), `RequestContextModule`
  (AsyncLocalStorage), `PrismaModule` + `OpenfortModule` (global core), then every feature
  module. Registers `ApiKeyThrottlerGuard` as the global `APP_GUARD` and applies
  `RequestIdMiddleware` to `'*'`.

## Design/Patterns

- **NestJS module composition with global infrastructure.** `PrismaModule`, `OpenfortModule`,
  `RequestContextModule`, and `ConfigModule` are `@Global()` so their services are injectable
  app-wide without per-module re-imports.
- **Fail-fast, schema-validated config.** `config/env.validation.ts` uses class-validator +
  `validateSync`; any invalid/missing required env aborts startup. Optional integrations
  (Stripe, USDC billing, SIEM/step-up webhooks) are validated whenever present but required
  only when their feature flag is enabled (fail-closed, never silently disabled).
- **Three distinct auth models** (in `common/guards`): `OpenfortUserGuard` (dashboard, IAM
  bearer only), `ApiKeyAuthGuard` (public, `X-API-Key` only, with Argon2id prefix-candidate
  verification, freeze/IP-allowlist/suspicious-use checks, and durable billing metering),
  and `EitherAuthGuard` (legacy dual-auth, currently unused in production controllers).
  Public routes never accept IAM tokens; dashboard routes never accept API keys.
- **Metadata-driven access control.** Thin decorators (`@Public()`, `@FrontendOnly()`,
  `@RequireStepUp()`, `@RequireApiKeyPermission()`, `@CurrentUser()`) stamp metadata that
  guards read via `Reflector`; enforcement lives in guards/services, not decorators.
- **Defense in depth.** Guards enforce permissions while services re-assert them; policy
  services (`SigningPolicyService`, `WithdrawalPolicyService`, `TransactionPolicyService`,
  `EoaExecutionPolicyService`, `SessionKeyPolicyService`) isolate high-risk rules and record
  `SecurityEvent` telemetry; `@Optional()` injection lets optional security/billing services
  degrade gracefully (never fail-open).
- **DeFi catalog (offline data, unchanged runtime path).** Production loads a generated static
  catalog of 315 exact functions (292 actions, 23 independent approvals), preserving the
  202-definition v1 catalog and appending 113 source-qualified functions through explicit
  SHA-256/ABI admission bindings. Existing API-key grants are not copied or broadened. M1 is
  committed; parent full build/unit validation and v2 catalog CLI checks passed. Focused R1
  validation passed (4 suites, 41 tests, 6.377 seconds). M2 Oracle Gate 2 passed on attempt 2/3
  after resolving R1, with no new material risks. Parent M2 local commit is authorized and
  upcoming; M3 follows that commit. The reconciled coverage report retains all 8,476
  rows, 8,472 unresolved proxies, seven unmatched IDs, 3 observed-active DEX identities, 4 mapped
  canonical identities including Compound V2 identity-only, one additional partial mapping, and
  144 workflows/59 exact bindings. Compound V2 activity remains unresolved. The M2 coverage report
  retains unresolved identity/workflow rows and does not establish the 90% objective; see
  [`majority-m2-delivery.md`](../docs/defi-research/majority-m2-delivery.md).
- **Unified security telemetry.** `security-events` is the single write path for
  `security_events` rows, with deterministic rule-based risk scoring (`SecurityRiskService`),
  multi-factor risk evaluation + enforcement (`RiskEvaluationService`), dashboard alert
  fanout (`security-notifications`), and optional redacted SIEM export.
- **Request correlation.** `RequestIdMiddleware` + `RequestContextService` (AsyncLocalStorage)
  propagate `requestId`/`clientIp` through the whole async chain; `HttpExceptionFilter`
  returns a standardized `{ statusCode, code, message, requestId, timestamp, path }` envelope
  with sanitized messages (no hashes/URLs/paths/stacks leak).
- **Resilient throttling.** `ResilientThrottlerStorage` uses Redis when available and
  fail-closed to in-memory otherwise; `ApiKeyThrottlerGuard` buckets by API-key prefix (or IP
  for JWT auth); named `short` (20/10s) and `medium` (100/60s) throttlers with route-level
  overrides.

## Flow

1. **Bootstrap.** `main.ts` builds the app with security/CORS/body/validation/filter
   defaults; `app.module.ts` validates env, registers global guards/middleware, and imports
   all modules.
2. **Request lifecycle.** `RequestIdMiddleware` (all routes) resolves/echoes `requestId` and
   seeds the ALS context → global `ApiKeyThrottlerGuard` rate-limits (key-prefix or IP bucket)
   → route guards authenticate (IAM or API-key) and enforce origin/step-up/permission gates →
   controller delegates to service → service runs domain logic + policy + risk + persistence
   + Openfort calls → `HttpExceptionFilter` normalizes any error.
3. **Public API-key path** (`sign`/`send`/`status`): `ApiKeyAuthGuard` (Argon2 verify every
   prefix candidate, reject frozen, IP allowlist, suspicious-use freeze, billing metering) →
   `ApiKeyPermissionGuard` (`canSign`/`canSendTransaction`/`canReadTransactionStatus`) →
   service re-asserts permission → execution-mode strategy (`session_key` via Calibur agent
   UserOp, or `eoa` via backend EOA gated by `EoaExecutionPolicyService`) → policy checks →
   risk evaluation → wallet/chain-authorization readiness → idempotency → optional simulation
   → Openfort submission → safe response shaping.
4. **Dashboard path** (wallets, transactions history, billing, MFA, API-key mgmt, security
   notifications, auth): `OpenfortUserGuard` + `FrontendOnlyGuard`; sensitive routes
   (withdraw, withdrawal-addresses, API-key create/revoke, refresh-api-key, step-up) add
   `StepUpGuard` (TOTP proof via `X-Step-Up-Token`).
5. **Cross-domain data flow.** Auth provisions `User`/`UserWallet`/`WalletChainAuthorization`
   (agent-key registration state machine `registration_required → pending_registration →
   registered|registration_failed`); wallet/transactions gate on `AgentStatus.Registered`;
   API-key lifecycle and every policy/risk decision write `SecurityEvent` rows that fan out to
   dashboard notifications and optional SIEM; billing meters API calls (in `ApiKeyAuthGuard`),
   wallet activation quota (in auth), and receipt-confirmed outbound volume (reconciliation).

## Integration

- **Entry points:** `src/main.ts`, `src/app.module.ts`.
- **Core services consumed app-wide:** `PrismaService` (`core/database`, `@Global()`),
  `OpenfortService` (`core/openfort`, `@Global()` facade over Openfort SDK + viem/ERC-4337),
  `ConfigService` (`@nestjs/config`), `RequestContextService` (`common/request-context`).
- **Shared common layer:** guards/decorators/filters/middleware (`common/`), throttler
  (`common/throttler`), pure helpers (`common/utils`: IP-CIDR, request-hash, sanitize;
  `common/errors`: API error codes; `common/chains`: supported-chain registry; `common/api-key`:
  prefix derivation; `common/agent`: agent-status vocabulary; `common/calibur`: EIP-7702
  Calibur ABI/on-chain helpers).
- **Feature modules** are imported by `AppModule` and cross-import each other (e.g. wallet/
  transactions import `EoaExecutionModule`, `SessionKeyModule`, `SecurityEventModule`,
  `BillingModule`; auth imports `ApiKeyModule`, `SecurityEventModule`, `StepUpModule`,
  `BillingModule`; security-events imports `SecurityNotificationModule`).
- **External dependencies:** `@nestjs/*`, `@prisma/client` + `@prisma/adapter-pg` (Postgres),
  `@openfort/openfort-node` (Openfort API), `viem`/`viem/account-abstraction` (chains,
  bundler, paymaster, ERC-4337), `ioredis` + `@nest-lab/throttler-storage-redis` (rate-limit
  storage), `argon2` (API-key/recovery-code hashing), `otplib` (TOTP), `helmet`, `stripe`
  SDK, Node `crypto`/`net`/`async_hooks`. External services: Postgres, Redis (optional),
  Openfort API, Pimlico RPC (Monad), chain RPCs, Stripe, optional SIEM webhook.

## Operational Constraints

- **Private keys never stored/logged/returned/derived outside Openfort.** All signing is
  delegated to the Openfort TEE; the backend only holds agent-key hashes and Calibur key
  hashes.
- **Access-control split is enforced.** Public API-key routes are the only ones in
  `openapi.yaml`; frontend-only routes require IAM bearer + `FrontendOnlyGuard` origin/referer
  checks; API-key management is never callable by API keys; `FrontendOnlyGuard` is never added
  to public routes.
- **Fail-closed everywhere.** Env validation aborts startup; trust-proxy/CORS required in
  production; throttling falls back to in-memory (never bypassed); on-chain session-key and
  EOA policy checks deny on RPC/policy unavailability; billing metering blocks (503) if it
  cannot persist and surfaces quota as 429.
- **Safe responses and telemetry.** Public transaction status never exposes calldata,
  `requestHash`, or `interactionsHash`; error messages are sanitized; security-event metadata
  and SIEM payloads never contain raw keys, secrets, full calldata/typed data, or signatures.
- **API keys are Argon2id hashes** (never plaintext); lookup verifies every prefix candidate
  (27-char modern + 11-char legacy) to avoid prefix-collision and legacy false negatives.
- **IP allowlists** compare against `request.ip` after Express trust-proxy handling, never raw
  `X-Forwarded-For`.
- **`UserWallet.openfortAccountId`** is the stable Openfort FK for SDK calls; never replaced
  by wallet address or orphaned.
- **`TransactionsModule`** is intentionally separate from `WalletModule`; do not fold
  transaction send/status into it.
- **Schema/config coupling.** Prisma schema lives in `prisma/schema.prisma` (regenerate via
  `npm run prisma:generate`); `openapi.yaml` stays limited to public API-key endpoints.

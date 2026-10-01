# Code Map for /src/common

## Responsibility

`src/common` is the shared, cross-cutting building-block layer of the SOFA ONE NestJS backend. It holds no business/domain logic of its own; instead it provides the reusable infrastructure that every module (`auth`, `wallet`, `transactions`, `api-key`, `billing`, `session-key`, `security-events`, `mfa`, `step-up`) and the core Openfort integration depend on. Its concerns fall into four groups:

1. **Request access control** — authentication (Openfort IAM vs. API-key), authorization (permissions, step-up, frontend-only origin checks), and rate limiting.
2. **Request lifecycle plumbing** — request-ID propagation via `AsyncLocalStorage`, per-request context, and global error formatting.
3. **Domain constants/registries** — the canonical chain registry, agent-registration statuses, API-key prefix derivation, and machine-readable error codes.
4. **Pure utilities & leaf libraries** — IP/CIDR matching, request hashing, message sanitization, and the Calibur smart-contract helper library.

The directory is deliberately **dependency-light at the leaf level** (many submodules are pure, framework-agnostic, and side-effect-free) while the guard/filter layer is the main integration point that pulls in services from `src/core` and `src/modules`.

## Directory Map

| Subdirectory | Role | Dependency profile |
| --- | --- | --- |
| `agent/` | Canonical `AgentStatus` constants + derived type for `WalletChainAuthorization` lifecycle | Pure, no deps |
| `api-key/` | API-key prefix/lookup-prefix derivation (`getApiKeyPrefix`, `getApiKeyLookupPrefixes`) | Pure, no deps |
| `calibur/` | Calibur (EIP-7702) smart-account ABI encoding, key hashing/settings, on-chain readers, viem session-account factory | Pure leaf (viem only) |
| `chains/` | Static `SUPPORTED_CHAINS` registry + `getSupportedChain`/`isMonadChain` helpers | Pure (viem + NestJS exception) |
| `decorators/` | Route/param metadata markers (`Public`, `FrontendOnly`, `RequireApiKeyPermission`, `RequireStepUp`, `CurrentUser`) | Pure (NestJS metadata) |
| `errors/` | `API_ERROR_CODES` vocabulary + `resolveApiErrorCode` resolver | Pure (NestJS `HttpStatus`) |
| `filters/` | Global `HttpExceptionFilter` — standardized error envelope, sanitization, 5xx logging | NestJS + errors + utils |
| `guards/` | All auth/permission/step-up/frontend-only guards + `IpAllowlistService` | Heaviest; pulls in core/modules services |
| `middleware/` | `RequestIdMiddleware` — request-ID resolution + ALS seeding | NestJS + request-context |
| `request-context/` | `RequestContextService` (AsyncLocalStorage) + `@Global()` module | Pure (node:async_hooks) |
| `throttler/` | `AppThrottlerModule` + `ResilientThrottlerStorage` (Redis↔memory fallback) | NestJS throttler, ioredis |
| `utils/` | `ip-cidr`, `request-hash`, `sanitize` pure helpers | Pure (node built-ins) |

## Design/Patterns

- **Metadata-driven access control.** Decorators only stamp metadata (`SetMetadata(KEY, value)`); guards read it at request time via `Reflector.getAllAndOverride(KEY, [handler, class])`. Enforcement is always delegated to guards/services — decorators carry no business logic. Metadata keys are exported constants to avoid string duplication.
- **Three distinct auth models kept separate.** `OpenfortUserGuard` (dashboard, IAM-bearer only), `ApiKeyAuthGuard` (public API-key routes, `X-API-Key` only), and `EitherAuthGuard` (legacy dual-auth, currently unused in production controllers). Public routes must never accept IAM tokens; dashboard routes must never accept API keys.
- **Prefix-candidate + Argon2 verification.** API keys are stored as Argon2id hashes; lookup uses the 27-char (and legacy 11-char) prefix as a *non-unique hint*, then verifies **every** candidate hash to avoid prefix collisions and legacy false negatives.
- **Defense in depth.** Permissions are enforced at the guard layer *and* re-checked in services; step-up state is marked on the request (`request.stepUpVerified`) so downstream services can enforce per-user policy; error messages are sanitized at multiple boundaries.
- **Fail-closed everywhere.** Unknown chains throw `BadRequestException`; unparseable IPs/CIDRs return `false`; Redis throttling falls back to in-memory (never fail-open); billing metering blocks the request (503) if it cannot persist.
- **Pure leaf modules.** `agent`, `api-key`, `chains`, `errors`, `utils`, and `calibur` are static/pure and side-effect-free, so they can be imported anywhere without DI or I/O. `request-context` is a thin `AsyncLocalStorage` wrapper.
- **Single source of truth via derivation.** `AgentStatusValue` derives from the `as const` object; `SUPPORTED_CHAIN_IDS` derives from the registry keys; `ApiErrorCode` derives from `API_ERROR_CODES` — types can never drift from runtime values.
- **Resilient infrastructure.** `ResilientThrottlerStorage` lazily connects Redis and transparently degrades to in-memory; `RequestIdMiddleware` + `RequestContextService` propagate `requestId`/`clientIp` across async boundaries without threading parameters.

## Flow

1. **Request entry.** `RequestIdMiddleware` (all routes) resolves the request ID (inbound `x-request-id` or UUID), sets `request.requestId` + `X-Request-Id` header, and seeds the `AsyncLocalStorage` context via `RequestContextService.run({ requestId, clientIp }, next)`.
2. **Global rate limiting.** `ApiKeyThrottlerGuard` (APP_GUARD) buckets by API-key prefix when present, else by client IP, using `ResilientThrottlerStorage` (`short` 20/10s, `medium` 100/60s).
3. **Authentication + authorization.** Guards run per-route:
   - Public API-key routes (`sign`, `send`, `getStatus`): `ApiKeyAuthGuard` (prefix lookup → Argon2 verify → frozen key/user rejection → IP allowlist → suspicious-usage freeze → durable billing metering) then `ApiKeyPermissionGuard` (`canSign`/`canSendTransaction`/`canReadTransactionStatus`).
   - Dashboard routes: `OpenfortUserGuard` + `FrontendOnlyGuard` (origin/referer allowlist); sensitive routes add `StepUpGuard` (`X-Step-Up-Token` proof, purpose `totp_mfa`).
   - Auth routes: `OpenfortAuthGuard` (session verification only); `@Public()` bypasses auth on health/Stripe webhook.
4. **Domain resolution.** Services resolve chains via `getSupportedChain`/`isMonadChain`, gate agent operations on `AgentStatus.Registered`, derive API-key prefixes, and use Calibur helpers for session-key signing/verification.
5. **Error handling.** Any thrown exception reaches the global `HttpExceptionFilter`, which derives status, resolves a stable `code` (`resolveApiErrorCode` fallback), sanitizes the message, logs 5xx with request context, and returns the standardized envelope `{ statusCode, code, message, details?, requestId, timestamp, path }`.

## Integration

- **Global registration (AppModule/main.ts):** `RequestContextModule` (imported), `RequestIdMiddleware` (applied to `'*'`), `AppThrottlerModule` + `ApiKeyThrottlerGuard` (APP_GUARD), and `HttpExceptionFilter` (`useGlobalFilters` in `main.ts`).
- **Guard consumers** (via `@UseGuards()`): `wallet.controller`, `transactions.controller`, `auth.controller`, `billing.controller`, `usdc-payment.controller`, `security-notification.controller`, `mfa.controller`, `api-key.controller`.
- **Upstream service dependencies (guards/filter):** `OpenfortService` (`src/core/openfort`), `PrismaService` (`src/core/database`), `SecurityEventService` (`src/modules/security-events`), `BillingService` (`src/modules/billing`), `StepUpService` (`src/modules/step-up`), `ConfigService`.
- **Leaf-module consumers:** `chains` → openfort/wallet/transactions/session-key/billing/config; `agent` → auth/wallet/transactions services; `api-key` → api-key service + auth guards; `calibur` → openfort/session-key/wallet/transactions; `errors` → `HttpExceptionFilter` + openfort service; `utils` → guards, filters, wallet/transactions, security-events, billing.
- **Public wire contract:** the `code` string emitted by the filter is consumed by the SPA in `frontend/src/lib/api.ts` (`ApiError.code`, `hasApiErrorCode`); `requestId` is surfaced for user support.
- **Access-control split:** public API-key routes are documented in `openapi.yaml`; frontend-only routes are intentionally omitted and require IAM bearer + origin/referer checks. API-key management is never callable by API keys.

## Constraints

- **No private-key handling.** Nothing here stores, logs, returns, or derives private keys; Calibur signing delegates entirely to the Openfort signer.
- **IP allowlist** compares against `request.ip` after Express trust-proxy handling — never raw `X-Forwarded-For`.
- **Public transaction status responses** must stay safe: no calldata, `requestHash`, or `interactionsHash`.
- **High-blast-radius registries.** Adding a chain to `chains/` immediately makes it valid for env/DTO validation and all downstream services — changes must be reviewed against every consumer.
- **Do not add `FrontendOnlyGuard` to public API routes**, and do not make API-key management callable by API keys.
- **Leaf modules must stay pure** — introducing DI/I/O into `agent`, `api-key`, `chains`, `errors`, `utils`, or `calibur` would break their import-anywhere property.
- **`EitherAuthGuard` and `ApiKeyOnlyGuard` are currently unused in production controllers** (referenced only by specs); retained for compatibility.

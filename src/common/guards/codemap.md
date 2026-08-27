# Code Map for /src/common/guards

## Responsibility
Centralized request access control for the SOFA ONE API. Guards here enforce three distinct auth models:
1. **Openfort IAM (dashboard/human routes)** — Bearer JWT verified against Openfort, full `User` row resolved onto `request.user`.
2. **API-key (public programmatic routes)** — `X-API-Key` verified via Argon2id against prefix candidates, with frozen-key/user rejection, IP allowlist enforcement, suspicious-usage freezing, and durable billing metering.
3. **Frontend-only / step-up / permission gates** — origin/referer allowlist checks, step-up proof validation, and API-key permission enforcement layered on top of auth.

Also hosts `IpAllowlistService`, the shared IP allowlist enforcement + audit service used by multiple guards and services.

## Files

### `api-key-auth.guard.ts` — `ApiKeyAuthGuard`
- **Role**: Authenticates public API routes with `X-API-Key` only. Intentionally does **not** accept Bearer tokens (dashboard routes use `OpenfortUserGuard`; public routes use this guard directly instead of `EitherAuthGuard` + `ApiKeyOnlyGuard`).
- **Key symbols**: `ApiKeyAuthGuard` (class), `ApiKeyAuthRecord` (type), constants `MAX_USER_AGENT_LENGTH = 255`, `SUSPICIOUS_USE_LOOKBACK_MS = 24h`.
- **Inputs**: `X-API-Key` header; `request.ip` (trust-proxy processed — never raw `X-Forwarded-For`); `user-agent` header (truncated to 255 chars).
- **Outputs**: On success sets `request.user` (Prisma `User`) and `request.apiKeyRecord` (Prisma `ApiKey` incl. `user`), returns `true`. Throws `UnauthorizedException` (missing/invalid key), `ForbiddenException` (frozen key/user, IP not allowed, suspicious-usage freeze), `ServiceUnavailableException` (billing unavailable/metering write failure), or re-throws `BillingQuotaExceededException` (→ HTTP 429).
- **Flow**: `@Public()` bypass → key presence check → `getApiKeyLookupPrefixes()` (27-char + legacy 11-char candidates) → `prisma.apiKey.findMany` (active, non-revoked, non-expired, `include: { user }`) → Argon2-verify **every** prefix candidate (prefixes are lookup hints, not unique) → frozen key/user rejection (records `api_key_frozen_rejected` / `api_key_user_frozen_rejected`) → `IpAllowlistService.assertIpAllowed` → usage-anomaly detection (IP/UA change; high-risk keys `canSign`/`canSendTransaction`/`canUseEoaExecution` freeze immediately, others freeze on repeated suspicious use within 24h; records `api_key_suspicious_use`, `api_key_frozen`) → `api_key.first_used` event on first use → attach request context → fire-and-forget `lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent` update → **durable billing metering** via `BillingService.assertAndRecordApiCall` (server-generated `sourceKey`/`requestId`, safe metadata only; must persist before handler runs).
- **Dependencies**: `Reflector`, `PrismaService`, `SecurityEventService`, `IpAllowlistService`, `@Optional() BillingService`, `argon2`, `getApiKeyLookupPrefixes` (`../api-key/api-key-prefix`), `IS_PUBLIC_KEY` (`../decorators/public.decorator`), `BillingQuotaExceededException`.

### `either-auth.guard.ts` — `EitherAuthGuard`
- **Role**: Accepts either Openfort IAM Bearer JWT (priority) or `X-API-Key` fallback; resolves the full user record so `@CurrentUser()` works uniformly.
- **Key symbols**: `EitherAuthGuard` (class), `ApiKeyAuthRecord` (type), constants `SUSPICIOUS_USE_LOOKBACK_MS`, `MAX_USER_AGENT_LENGTH`.
- **Inputs**: `Authorization: Bearer <token>` or `X-API-Key` header; `request.ip`; `user-agent`.
- **Outputs**: JWT path sets `request.user`, `request.openfortUserId`, `request.openfortSession`, `request.openfortEmail`. API-key path sets `request.user` and `request.apiKeyRecord`. Throws `UnauthorizedException` (no credentials, invalid token, user not found, invalid key) or `ForbiddenException` (frozen key/user, IP not allowed, suspicious-usage freeze).
- **Flow**: `@Public()` bypass → Bearer token? JWT path (`openfort.verifyIamSession` → `prisma.user.findUnique({ socialId })`) → else API-key path (same prefix-candidate + Argon2 + allowlist + freeze + anomaly logic as `ApiKeyAuthGuard`, **minus billing metering** — no `BillingService` dependency).
- **Dependencies**: `Reflector`, `PrismaService`, `OpenfortService`, `IpAllowlistService`, `SecurityEventService`, `argon2`, `getApiKeyLookupPrefixes`, `IS_PUBLIC_KEY`.
- **Note**: Currently referenced only by spec files; no production controller imports it (public routes use `ApiKeyAuthGuard` directly). Retained for compatibility.

### `api-key-only.guard.ts` — `ApiKeyOnlyGuard`
- **Role**: Requires a successfully authenticated API key on routes that also use `EitherAuthGuard` (i.e. `request.apiKeyRecord` must be present).
- **Key symbols**: `ApiKeyOnlyGuard` (class).
- **Inputs**: `request.apiKeyRecord`.
- **Outputs**: `true`, or `UnauthorizedException('API key is required')`.
- **Dependencies**: none (no constructor).
- **Note**: Currently referenced only by its spec file; no production controller imports it.

### `api-key-permission.guard.ts` — `ApiKeyPermissionGuard`
- **Role**: Enforces `@RequireApiKeyPermission()` metadata on API-key routes before service code runs (services keep duplicate checks as defense in depth).
- **Key symbols**: `ApiKeyPermissionGuard` (class).
- **Inputs**: `API_KEY_PERMISSION_KEY` metadata (`canSign` | `canSendTransaction` | `canReadTransactionStatus` | `canUseEoaExecution`); `request.apiKeyRecord`.
- **Outputs**: `true` if no permission metadata or `apiKeyRecord[permission] === true`; `ForbiddenException` if key missing or permission not granted.
- **Dependencies**: `Reflector`, `API_KEY_PERMISSION_KEY`/`ApiKeyPermission` (`../decorators/api-key-permission.decorator`).

### `api-key-throttler.guard.ts` — `ApiKeyThrottlerGuard`
- **Role**: Global rate-limiter. Buckets by API-key prefix when `X-API-Key` auth is used (each key gets its own quota), falling back to client IP for JWT-authenticated requests.
- **Key symbols**: `ApiKeyThrottlerGuard` (class, extends `ThrottlerGuard`), overridden `getTracker(req)`.
- **Inputs**: `req.apiKeyRecord?.keyPrefix`.
- **Outputs**: tracker string (key prefix or `super.getTracker(req)` → IP).
- **Dependencies**: `@nestjs/throttler` `ThrottlerGuard`. Registered as global `APP_GUARD` in `src/app.module.ts`; storage configured in `src/common/throttler/throttler.module.ts` (`ResilientThrottlerStorage`, Redis with in-memory fallback).

### `frontend-only.guard.ts` — `FrontendOnlyGuard`
- **Role**: Restricts `@FrontendOnly()` routes to requests originating from the configured `CORS_ORIGIN` allowlist.
- **Key symbols**: `FrontendOnlyGuard` (class); fields `allowedOrigins`, `isProduction`.
- **Inputs**: `IS_FRONTEND_ONLY_KEY` metadata; `Origin` header (primary), `Referer` header (fallback, **non-production only**); `CORS_ORIGIN` and `NODE_ENV` from `ConfigService`.
- **Outputs**: `true` if origin allowed; `ForbiddenException` otherwise. Origins normalized via `new URL(value).origin`. Dev default allowlist: `http://localhost:3000`, `http://localhost:3100`.
- **Dependencies**: `Reflector`, `ConfigService`, `IS_FRONTEND_ONLY_KEY` (`../decorators/frontend-only.decorator`).

### `ip-allowlist.service.ts` — `IpAllowlistService`
- **Role**: Centralized IP allowlist enforcement with `SecurityEvent` audit trail; replaces duplicated checks in `ApiKeyAuthGuard`, `EitherAuthGuard`, and `EoaExecutionPolicyService`.
- **Key symbols**: `IpAllowlistService` (class), `IpAllowlistContext` (type: `actorType`, `apiKeyId?`, `apiKeyPrefix?`, `userId?`, `clientIp`, `userAgent?`, `allowedIpCount?`).
- **Inputs**: `clientIp`, `allowedIps` (CIDR or exact IP entries), context.
- **Outputs**: `assertIpAllowed` — no-op if allowlist empty; `true` if `isIpAllowed`; otherwise records `api_key.ip_rejected` SecurityEvent (risk `high`, result `denied`) and throws `ForbiddenException('IP address not allowed for this API key')`. `isIpAllowed` — non-throwing boolean check, no event recording.
- **Dependencies**: `@Optional() SecurityEventService`, `isIpAllowed` (`../utils/ip-cidr` — IPv4/IPv6 + CIDR matching). Provided/exported by `SecurityEventModule`.

### `openfort-auth.guard.ts` — `OpenfortAuthGuard`
- **Role**: Verifies Openfort IAM access token from `Authorization: Bearer`; attaches Openfort session context. Does **not** resolve the DB user row.
- **Key symbols**: `OpenfortAuthGuard` (class).
- **Inputs**: `Authorization: Bearer <token>`; `IS_PUBLIC_KEY` metadata.
- **Outputs**: Sets `request.openfortUserId`, `request.openfortAccessToken`, `request.openfortSession`, `request.openfortEmail`; `true`. Throws `UnauthorizedException` (missing/invalid token).
- **Dependencies**: `Reflector`, `OpenfortService`, `IS_PUBLIC_KEY`. Used at controller level in `AuthController`.

### `openfort-user.guard.ts` — `OpenfortUserGuard`
- **Role**: Openfort-only guard for dashboard/frontend routes. Never accepts API keys. Resolves the full user and rejects frozen accounts.
- **Key symbols**: `OpenfortUserGuard` (class).
- **Inputs**: `Authorization: Bearer <token>`; `IS_PUBLIC_KEY` metadata.
- **Outputs**: Sets `request.user` (Prisma `User`), `request.openfortUserId`, `request.openfortSession`, `request.openfortEmail`; `true`. Throws `UnauthorizedException` (missing token, user not found, invalid token) or `ForbiddenException` (frozen user).
- **Dependencies**: `Reflector`, `OpenfortService`, `PrismaService`, `IS_PUBLIC_KEY`.

### `step-up.guard.ts` — `StepUpGuard`
- **Role**: Validates a step-up proof token from the `X-Step-Up-Token` header on `@RequireStepUp()` routes. Proof must be valid, unexpired, and belong to the authenticated user.
- **Key symbols**: `StepUpGuard` (class).
- **Inputs**: `STEP_UP_KEY` metadata; `X-Step-Up-Token` header; `request.user.id`.
- **Outputs**: `true` (skips when route has no step-up requirement); sets `request.stepUpVerified = true` on success. Throws `ForbiddenException` (missing token, missing auth, invalid/expired proof).
- **Dependencies**: `Reflector`, `StepUpService` (`../../modules/step-up/step-up.service`), `STEP_UP_KEY` (`../decorators/step-up.decorator`). Validates with purpose `'totp_mfa'`.

## Design/Patterns
- **NestJS `CanActivate` guards** composed per-route via `@UseGuards()`; metadata-driven activation via `Reflector.getAllAndOverride` against handler + class.
- **Three auth models kept separate**: `OpenfortUserGuard` (dashboard, IAM-only), `ApiKeyAuthGuard` (public, API-key-only), `EitherAuthGuard` (legacy dual-auth, currently unused in production controllers). Public API routes must never accept IAM tokens; dashboard routes must never accept API keys.
- **Prefix-candidate + Argon2 verification**: API keys are stored as Argon2id hashes; lookup uses 27-char and legacy 11-char prefixes as a non-unique hint, then verifies every candidate hash to avoid prefix collisions and legacy false negatives.
- **Defense in depth**: `ApiKeyPermissionGuard` enforces permissions at the guard layer while services retain their own checks; `StepUpGuard` marks `request.stepUpVerified` so downstream services can enforce per-user step-up policies.
- **Shared audit service**: `IpAllowlistService` centralizes allowlist checks and records `SecurityEvent` rows, avoiding duplicated logic across guards and `EoaExecutionPolicyService`.
- **Durable metering**: `ApiKeyAuthGuard` blocks the request (503) if billing metering cannot persist, and surfaces genuine quota rejections as 429 — never lets a handler run un-metered.
- **Fire-and-forget side effects**: `lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent` updates are non-blocking (`void ... .catch(logger.warn)`); security-event recording failures are logged, not thrown.

## Flow
1. **Global**: `ApiKeyThrottlerGuard` (APP_GUARD) rate-limits every request — key-prefix bucket for API-key auth, IP bucket otherwise.
2. **Public API-key routes** (`POST /v1/wallets/sign`, `POST /v1/transactions/send`, `GET /v1/transactions/:id`): `ApiKeyAuthGuard` → `ApiKeyPermissionGuard`. Auth resolves the key, rejects frozen key/user, enforces IP allowlist, freezes suspicious usage, meters billing; permission guard requires `canSign` / `canSendTransaction` / `canReadTransactionStatus`.
3. **Dashboard routes** (wallets, transactions status, billing, security notifications, MFA, API-key management): `OpenfortUserGuard` + `FrontendOnlyGuard`; sensitive routes (withdraw, withdrawal-addresses, API-key create/revoke, step-up challenge) add `StepUpGuard`.
4. **Auth routes**: `OpenfortAuthGuard` at controller level (session verification only); `@Public()` bypasses auth on health and Stripe webhook routes.
5. **Rejection paths** all record `SecurityEvent` rows (frozen rejections, IP rejections, first use, suspicious use, freeze) with safe metadata only — never raw keys, calldata, or headers.

## Integration
- **Global registration**: `ApiKeyThrottlerGuard` as `APP_GUARD` in `src/app.module.ts`; throttler storage via `src/common/throttler/throttler.module.ts`.
- **Consumers** (via `@UseGuards()`):
  - `src/modules/wallet/wallet.controller.ts` — `OpenfortUserGuard`+`FrontendOnlyGuard` (+`StepUpGuard` on withdraw/withdrawal-address routes); `ApiKeyAuthGuard`+`ApiKeyPermissionGuard` on sign.
  - `src/modules/transactions/transactions.controller.ts` — `ApiKeyAuthGuard`+`ApiKeyPermissionGuard` on public send/status; `OpenfortUserGuard`+`FrontendOnlyGuard` on dashboard routes.
  - `src/modules/auth/auth.controller.ts` — `OpenfortAuthGuard` (controller-level).
  - `src/modules/billing/billing.controller.ts`, `src/modules/billing/onchain/usdc-payment.controller.ts`, `src/modules/security-notifications/security-notification.controller.ts`, `src/modules/mfa/mfa.controller.ts`, `src/modules/api-key/api-key.controller.ts` — `OpenfortUserGuard`+`FrontendOnlyGuard` (+`StepUpGuard` on API-key management).
- **`IpAllowlistService`** is provided/exported by `SecurityEventModule` and consumed by `ApiKeyAuthGuard`, `EitherAuthGuard`, and `EoaExecutionPolicyService`.
- **Upstream dependencies**: `OpenfortService` (`src/core/openfort`), `PrismaService` (`src/core/database`), `SecurityEventService` (`src/modules/security-events`), `BillingService` (`src/modules/billing`), `StepUpService` (`src/modules/step-up`), `ConfigService` (`@nestjs/config`), `argon2`, `@nestjs/throttler`.
- **Sibling helpers**: decorators `public.decorator.ts`, `api-key-permission.decorator.ts`, `frontend-only.decorator.ts`, `step-up.decorator.ts`; utils `api-key-prefix.ts` (`getApiKeyLookupPrefixes`), `ip-cidr.ts` (`isIpAllowed`).
- **Access-control split**: public API-key routes are documented in `openapi.yaml`; frontend-only routes are intentionally omitted and require IAM bearer + origin/referer checks. API-key management is never callable by API keys.
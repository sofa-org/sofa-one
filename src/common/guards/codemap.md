# Code Map for /src/common/guards

## Responsibility
Centralized request access control for the SOFA ONE API. Guards here enforce three distinct auth models:
1. **Application sessions (dashboard/human routes)** — opaque HttpOnly cookie resolved locally, full-MFA required except explicit bootstrap routes; current User/freeze state is loaded on every authentication.
2. **API-key (public programmatic routes)** — `X-API-Key` verified via Argon2id against prefix candidates, with frozen-key/user rejection, IP allowlist enforcement, suspicious-usage freezing, and durable billing metering.
3. **Frontend-only / step-up / permission gates** — origin/referer allowlist checks, step-up proof validation, and API-key permission enforcement layered on top of auth.

Also hosts `IpAllowlistService`, the shared IP allowlist enforcement + audit service used by multiple guards and services.

## Files

### `api-key-auth.guard.ts` — `ApiKeyAuthGuard`
- **Role**: Public API routes authenticate with X-API-Key only; IAM bearers and application cookies are never substitutes.
- **Key symbols**: `ApiKeyAuthGuard` (class), `ApiKeyAuthRecord` (type), constants `MAX_USER_AGENT_LENGTH = 255`, `SUSPICIOUS_USE_LOOKBACK_MS = 24h`.
- **Inputs**: `X-API-Key` header; `request.ip` (trust-proxy processed — never raw `X-Forwarded-For`); `user-agent` header (truncated to 255 chars).
- **Outputs**: On success sets `request.user` (Prisma `User`) and `request.apiKeyRecord` (Prisma `ApiKey` incl. `user`), returns `true`. Throws `UnauthorizedException` (missing/invalid key), `ForbiddenException` (frozen key/user, IP not allowed, suspicious-usage freeze), `ServiceUnavailableException` (billing unavailable/metering write failure), or re-throws `BillingQuotaExceededException` (→ HTTP 429).
- **Flow**: `@Public()` bypass → key presence check → `getApiKeyLookupPrefixes()` (27-char + legacy 11-char candidates) → `prisma.apiKey.findMany` (active, non-revoked, non-expired, `include: { user }`) → Argon2-verify **every** prefix candidate (prefixes are lookup hints, not unique) → frozen key/user rejection (records `api_key_frozen_rejected` / `api_key_user_frozen_rejected`) → `IpAllowlistService.assertIpAllowed` → usage-anomaly detection (IP/UA change; high-risk keys `canSign`/`canSendTransaction`/`canUseEoaExecution` freeze immediately, others freeze on repeated suspicious use within 24h; records `api_key_suspicious_use`, `api_key_frozen`) → `api_key.first_used` event on first use → attach request context → fire-and-forget `lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent` update → **durable billing metering** via `BillingService.assertAndRecordApiCall` (server-generated `sourceKey`/`requestId`, safe metadata only; must persist before handler runs).
- **Dependencies**: `Reflector`, `PrismaService`, `SecurityEventService`, `IpAllowlistService`, `@Optional() BillingService`, `argon2`, `getApiKeyLookupPrefixes` (`../api-key/api-key-prefix`), `IS_PUBLIC_KEY` (`../decorators/public.decorator`), `BillingQuotaExceededException`.

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
- **Inputs**: FrontendOnly metadata; Origin allowlist, with trusted Referer fallback for safe GET/HEAD even in production. `assertTrustedOrigin` independently requires a single trusted Origin for unsafe cookie requests.
- **Outputs**: `true` if origin allowed; `ForbiddenException` otherwise. Origins normalized via `new URL(value).origin`. Dev default allowlist: `http://localhost:3000`, `http://localhost:3100`.
- **Dependencies**: `Reflector`, `ConfigService`, `IS_FRONTEND_ONLY_KEY` (`../decorators/frontend-only.decorator`).

### `ip-allowlist.service.ts` — `IpAllowlistService`
- **Role**: Centralized IP allowlist enforcement with `SecurityEvent` audit trail; shared by `ApiKeyAuthGuard` and `EoaExecutionPolicyService`.
- **Key symbols**: `IpAllowlistService` (class), `IpAllowlistContext` (type: `actorType`, `apiKeyId?`, `apiKeyPrefix?`, `userId?`, `clientIp`, `userAgent?`, `allowedIpCount?`).
- **Inputs**: `clientIp`, `allowedIps` (CIDR or exact IP entries), context.
- **Outputs**: `assertIpAllowed` — no-op if allowlist empty; `true` if `isIpAllowed`; otherwise records `api_key.ip_rejected` SecurityEvent (risk `high`, result `denied`) and throws `ForbiddenException('IP address not allowed for this API key')`. `isIpAllowed` — non-throwing boolean check, no event recording.
- **Dependencies**: `@Optional() SecurityEventService`, `isIpAllowed` (`../utils/ip-cidr` — IPv4/IPv6 + CIDR matching). Provided/exported by `SecurityEventModule`.

### `openfort-auth.guard.ts` — `OpenfortAuthGuard`
- Login exchange and fresh wallet identity proof only. Reads Authorization Bearer and attaches validated provider identity/access token to the request.
- Missing/invalid identity returns provider-only AUTH_PROVIDER_INVALID 401; provider outages preserve AUTH_PROVIDER_UNAVAILABLE 502 rather than becoming lost local login.

### `app-session.guard.ts` — `AppSessionGuard`
- Accepts only the live opaque application cookie; never IAM bearer or API key.
- Injects AppSessionService/FrontendOnlyGuard and Reflector; resolves session/user locally, rejects frozen users, expiry/revocation and pending business access.
- Explicit AllowPendingMfa metadata permits only bootstrap methods. Unsafe requests independently require trusted Origin and CSRF regardless of FrontendOnly metadata.
- Attaches request.user, request.appSession and derived request.appSessionCsrfToken. DB failures are 503, not 401.

### `step-up.guard.ts` — `StepUpGuard`
- RequireStepUp metadata requires X-Step-Up-Token bound to request.user.id AND request.appSession.id.
- Service validation rechecks proof expiry and the live full-MFA/unrevoked/unfrozen session; success sets request.stepUpVerified. Rejection is 403.

## Design/Patterns
- **Wallet binding**: API-key authentication requires a bound wallet relation whose ID and owner match the key; null or foreign bindings fail closed after every lookup-prefix candidate is hash verified.
- **NestJS `CanActivate` guards** composed per-route via `@UseGuards()`; metadata-driven activation via `Reflector.getAllAndOverride` against handler + class.
- **Separate audiences**: AppSessionGuard handles dashboard cookies; ApiKeyAuthGuard handles public API keys. OpenfortAuthGuard is only an identity proof at explicit exchange/wallet boundaries.
- **Prefix-candidate + Argon2 verification**: API keys are stored as Argon2id hashes; lookup uses 27-char and legacy 11-char prefixes as a non-unique hint, then verifies every candidate hash to avoid prefix collisions and legacy false negatives.
- **Defense in depth**: `ApiKeyPermissionGuard` enforces permissions at the guard layer while services retain their own checks; `StepUpGuard` marks `request.stepUpVerified` so downstream services can enforce per-user step-up policies.
- **Shared audit service**: `IpAllowlistService` centralizes allowlist checks and records `SecurityEvent` rows, avoiding duplicated logic across guards and `EoaExecutionPolicyService`.
- **Durable metering**: `ApiKeyAuthGuard` blocks the request (503) if billing metering cannot persist, and surfaces genuine quota rejections as 429 — never lets a handler run un-metered.
- **Fire-and-forget side effects**: `lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent` updates are non-blocking (`void ... .catch(logger.warn)`); security-event recording failures are logged, not thrown.

## Flow
1. **Global**: `ApiKeyThrottlerGuard` (APP_GUARD) rate-limits every request — key-prefix bucket for API-key auth, IP bucket otherwise.
2. **Public API-key routes** (`POST /v1/wallets/sign`, `POST /v1/transactions`, `GET /v1/transactions/:id`): `ApiKeyAuthGuard` → `ApiKeyPermissionGuard`. Auth resolves the key, rejects frozen key/user, enforces IP allowlist, freezes suspicious usage, meters billing; permission guard requires `canSign` / `canSendTransaction` / `canReadTransactionStatus`. The separate `GET /v1/wallets` metadata route requires API-key auth but no permission flag.
3. **Dashboard routes**: AppSessionGuard + FrontendOnlyGuard; sensitive operations add exact-session StepUpGuard. Pending MFA is explicitly allowlisted only for session/MFA bootstrap.
4. **Auth routes**: Per-method guards; login exchange and embedded-wallet identity proof additionally use OpenfortAuthGuard. Health/Stripe public behavior is unchanged.
5. **Rejection paths** all record `SecurityEvent` rows (frozen rejections, IP rejections, first use, suspicious use, freeze) with safe metadata only — never raw keys, calldata, or headers.

## Integration
- **Global registration**: `ApiKeyThrottlerGuard` as `APP_GUARD` in `src/app.module.ts`; throttler storage via `src/common/throttler/throttler.module.ts`.
- **Consumers** (via `@UseGuards()`):
  - Wallet and transaction controllers keep distinct AppSessionGuard dashboard methods and ApiKeyAuthGuard public methods.
  - Billing, notifications and API-key management use AppSessionGuard + FrontendOnlyGuard, with StepUpGuard on sensitive mutations.
  - AuthController separates login exchange, pending session introspection/logout, full-session wallet actions and all-device logout.
  - MfaController marks only status/setup/enable/verify AllowPendingMfa; disable requires full local MFA.
- **`IpAllowlistService`** is provided/exported by `SecurityEventModule` and consumed by `ApiKeyAuthGuard` and `EoaExecutionPolicyService`.
- **Upstream dependencies**: `OpenfortService` (`src/core/openfort`), `PrismaService` (`src/core/database`), `SecurityEventService` (`src/modules/security-events`), `BillingService` (`src/modules/billing`), `StepUpService` (`src/modules/step-up`), `ConfigService` (`@nestjs/config`), `argon2`, `@nestjs/throttler`.
- **Sibling helpers**: decorators `public.decorator.ts`, `api-key-permission.decorator.ts`, `frontend-only.decorator.ts`, `step-up.decorator.ts`; utils `api-key-prefix.ts` (`getApiKeyLookupPrefixes`), `ip-cidr.ts` (`isIpAllowed`).
- **Access-control split**: Public OpenAPI remains API-key-only; dashboard cookie/CSRF routes remain omitted. API keys cannot manage keys.

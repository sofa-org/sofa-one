# Code Map for /src/modules/api-key

## Responsibility
Dashboard-only API-key lifecycle management for programmatic access to public signing/transaction endpoints. Creates API keys (Argon2id-hashed, raw key returned exactly once), lists non-sensitive metadata, revokes single/all keys, and atomically rotates keys. Enforces the permission model, spend limits, IP/contract/selector allowlists, bounded expiry, and dual audit (legacy `ApiKeyEvent` rows + unified `SecurityEvent`). All mutations require Openfort IAM auth, frontend-origin checks, and TOTP step-up; the module never stores, logs, or returns the raw key after creation.

## Files
- `api-key.controller.ts` — routes for create/list/revoke-all/revoke-one under `v1/api-keys`.
- `api-key.service.ts` — all lifecycle business logic, hashing, normalization, constraints, and audit writes.
- `api-key.module.ts` — NestJS wiring; imports `StepUpModule` + `SecurityEventModule`, exports `ApiKeyService`.
- `dto/create-api-key.dto.ts` — validated request shape for creation (see `dto/codemap.md`; not duplicated here).

## Key Symbols

### `ApiKeyService` (exported, injectable)
| Method | Purpose |
|--------|---------|
| `createApiKey(userId, options)` | Generate key material, validate/normalize options, persist hash + prefix, audit `api_key.created`, return raw key **once** plus metadata. |
| `listApiKeys(userId)` | Return metadata only (no hash/secret) for all keys, newest first. |
| `revokeApiKey(keyId, userId)` | Revoke one owned key; 404 if not found, no-op if already revoked; audit `api_key.revoked`. |
| `revokeAllKeys(userId)` | Revoke every active key; audit `api_key.revoked` per key with `reason: 'bulk_revoke'`. |
| `rotateApiKey(userId, name)` | Atomically revoke all active keys and create a replacement; audit `api_key.revoked` (reason `rotation`) + `api_key.rotated`; return raw key once. |
| `authorizeDirectEgress(keyId, userId)` | BILL-016: step-up owned-key CAS set of `directEgressPolicyAcceptedAt`; rejects revoked/expired/frozen/non-send keys; idempotent when already set. |

### Types / constants
- `ApiKeyPermissions` — `canSign`, `canSendTransaction`, `canReadTransactionStatus`, `canUseEoaExecution`.
- `ApiKeySpendLimits` — optional `daily`/`monthly` wei strings.
- `DEFAULT_API_KEY_PERMISSIONS` — deny-by-default: only `canReadTransactionStatus: true`.
- `MAX_ACTIVE_API_KEYS = 10`; `DEFAULT_API_KEY_TTL_MS = 90d`; `MAX_API_KEY_TTL_MS = 365d`.
- `PERMISSION_MAX_TTL_MS` — `canUseEoaExecution` 30d, `canSign`/`canSendTransaction` 90d, `canReadTransactionStatus` 365d.
- `HIGH_RISK_PERMISSIONS` — `canSign`, `canSendTransaction`, `canUseEoaExecution`.

## Design / Patterns
- **Argon2id hashing**: raw key is `sk_` + 64 hex chars (`randomBytes(32).toString('hex')`); only the Argon2id hash (`memoryCost 65536`, `timeCost 3`, `parallelism 1`) and a 27-char lookup prefix (`getApiKeyPrefix` from `src/common/api-key/api-key-prefix`) are persisted. The raw key is returned once and is unrecoverable afterward.
- **Prefix-as-hint lookup**: `keyPrefix` is a non-unique lookup hint; every matching candidate must be Argon2-verified at auth time (in `ApiKeyAuthGuard`, not here) to tolerate prefix collisions and legacy 11-char prefixes.
- **Transactional lifecycle**: create/revoke/rotate run inside `prisma.$transaction`; constraint checks, row writes, and audit writes are atomic.
- **Dual audit**: every lifecycle event writes both a legacy `ApiKeyEvent` row and a unified `SecurityEvent` via `SecurityEventService.record` (`actorType: 'user'`, `riskLevel: 'low'`, `result: 'allowed'`) inside the same transaction.
- **Deny-by-default permissions**: omitted permissions default to `false`; only read-status is granted by default.
- **Permission-based TTL caps**: the most restrictive granted high-risk permission caps `expiresAt` (30/90/365 days); absent `expiresAt` defaults to 90d (min'd with the cap).
- **High-risk hardening**: `canSign`/`canSendTransaction`/`canUseEoaExecution` require a non-empty IP allowlist (`assertIpAllowlistForHighRiskPermissions`).
- **Normalization**: names trimmed; contract addresses and function selectors lowercased; spend limits validated as non-negative wei strings via `BigInt`.
- **Step-up + throttling**: mutations require `@RequireStepUp()`/`StepUpGuard` (TOTP proof via `X-Step-Up-Token`); create throttled 5/60s + 20/1h, revoke-all 3/60s + 10/1h.
- **Freeze state is read-only here**: `frozenAt`/`frozenReason` are surfaced in list output but set by `ApiKeyAuthGuard` at runtime (suspicious-use auto-freeze), not by this module.

## Flow

### Create (`POST /v1/api-keys`)
1. `ApiKeyController.create` — `OpenfortUserGuard` + `FrontendOnlyGuard` + `StepUpGuard`; DTO validated by global `ValidationPipe` (whitelist, forbid non-whitelisted, transform).
2. `normalizeCreateOptions`: trim/require name; merge permissions over defaults; lowercase addresses/selectors; validate spend limits; assert IP allowlist for high-risk permissions; compute `expiresAt` within the permission TTL cap.
3. `generateKeyMaterial`: `sk_` + 64-hex secret → 27-char prefix → Argon2id hash.
4. Transaction: `assertCanCreateKey` (≤10 active keys; unique non-empty active name, case-insensitive) → create `ApiKey` row (hash, prefix, name, expiry, allowlists, spend limits, permissions) → audit `api_key.created` (prefix, name, metadata: allowlists/expiry/permissions).
5. Return `{ rawKey, id, displayPrefix, name, expiresAt, createdAt, permissions }` — raw key is shown exactly once.

### List (`GET /v1/api-keys`)
- `findMany` metadata only (no hash): prefix, name, revoked, freeze state, expiry, timestamps, last-used IP/UA, permissions, allowlists, spend limits; ordered `createdAt desc`; `displayPrefix` = first 11 chars + `...`.

### Revoke one (`DELETE /v1/api-keys/:id`)
- Transaction: `findFirst` by `{ id, userId }` (404 if absent; no-op if already revoked) → `updateMany` `revoked: true` → audit `api_key.revoked`.

### Revoke all (`DELETE /v1/api-keys`)
- Transaction: collect active keys → `updateMany` `revoked: true` → audit `api_key.revoked` per key with `reason: 'bulk_revoke'`.

### Rotate (`ApiKeyService.rotateApiKey`, called by `AuthService.refreshApiKey`)
- Transaction: revoke all active keys (audit `api_key.revoked`, `reason: 'rotation'`) → create replacement (empty `allowedIps`, normalized permissions, default expiry) → audit `api_key.rotated` with `revokedKeyCount` → return raw key once.

### Runtime consumption (outside this module)
- `ApiKeyAuthGuard` (public routes): prefix lookup → Argon2 verify every candidate → reject frozen key/user → IP allowlist check → usage-anomaly detection (context change may auto-freeze high-risk keys and emit `api_key_suspicious_use`/`api_key_frozen`) → `api_key.first_used` event → fire-and-forget `lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent` update → billing metering.
- `ApiKeyPermissionGuard`: requires the route-declared permission flag (`canSign`, `canSendTransaction`, `canReadTransactionStatus`, `canUseEoaExecution`) to be `true` on the resolved key record.

## Integration
- **Imports**: `StepUpModule` (provides `StepUpGuard`/`StepUpService` for TOTP proof validation) and `SecurityEventModule` (provides `SecurityEventService.record`, callable with a Prisma transaction client for atomic audit).
- **Guards/decorators**: `OpenfortUserGuard` + `FrontendOnlyGuard` (class-level), `StepUpGuard` + `@RequireStepUp()` (mutations), `@CurrentUser('id')`, `@Throttle`.
- **Persistence**: `PrismaService`; `ApiKey` and `ApiKeyEvent` models in `prisma/schema.prisma` (`api_keys` / `api_key_events` tables). `ApiKey` carries permission booleans, allowlists, spend limits, freeze state, and last-used fields; indexed on `keyPrefix` and `[userId, revoked]`.
- **Shared helper**: `getApiKeyPrefix` from `src/common/api-key/api-key-prefix` (27-char prefix; legacy 11-char handled at lookup time).
- **Downstream consumers**: `ApiKeyAuthGuard` (hash verification, freeze, first-use/suspicious-use events, last-used updates), `ApiKeyPermissionGuard` (permission enforcement), and wallet/transactions modules read permissions, spend limits, and allowlists from the resolved key record.
- **Upstream consumer**: `src/modules/auth/auth.service.ts` calls `rotateApiKey(user.id, 'Refreshed')` in `refreshApiKey` and returns the new raw key.
- **Not part of the public API spec**: all `/v1/api-keys/*` routes are frontend-only (omitted from `openapi.yaml`); API-key management is never callable by API keys.
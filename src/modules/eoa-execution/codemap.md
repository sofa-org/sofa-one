# Code Map for /src/modules/eoa-execution

## Responsibility
Runtime isolation policy for privileged backend EOA execution (`sign` and `send_transaction`) requested through API-key public routes. Acts as a defense-in-depth gate that runs after API-key permission checks (`canUseEoaExecution`) but before wallet loading or Openfort submission, ensuring EOA-mode operations are globally opt-in, IP-allowlisted, short-lived, independently rate-limited, and fully security-event audited.

## Design/Patterns
- Single `@Injectable()` service (`EoaExecutionPolicyService`) exposing one public method, `assertAllowed(context)`, which throws `ForbiddenException` on any failed check. No controller; invoked from service layer only.
- Layered defense-in-depth checks, each independently sufficient to deny:
  1. Global opt-in flag `EOA_EXECUTION_ENABLED === 'true'` via `ConfigService`.
  2. API key must carry a non-empty IP allowlist (`allowedIps`).
  3. Request must have a verifiable client IP.
  4. `IpAllowlistService` must be available (injected `@Optional()`; absence degrades to denial, never bypass).
  5. API key `expiresAt` must be within `EOA_EXECUTION_MAX_TTL_MS` (30 days).
  6. Independent per-key rate limit: at most `EOA_EXECUTION_RATE_LIMIT_COUNT` (1) allowed EOA execution per `EOA_EXECUTION_RATE_LIMIT_WINDOW_MS` (60 s).
- Mandatory audit: every decision (allowed or denied) is recorded through `SecurityEventService.record` with event types `eoa_execution_allowed` / `eoa_execution_denied`, risk levels (`high` for allowed, `critical` for denied), a machine-readable `reason` code, and safe metadata (operation, chainId, apiKeyPrefix, plus caller-supplied metadata).
- Uses a structural type `EoaPolicyPrismaClient` to narrow `PrismaService` to only the `securityEvent.count` query needed for rate limiting, avoiding a full Prisma client dependency surface in the service.
- IP enforcement is delegated to the shared `IpAllowlistService` (from `SecurityEventModule`), which centralizes CIDR matching and records `api_key.ip_rejected` security events on mismatch.
- Rate limiting counts only prior `eoa_execution_allowed` events, so denied attempts do not consume the per-key budget; the current request's `allowed` event is recorded after the count check.

## Flow
- Callers: `WalletService.sign` (operation `sign`) and `TransactionsService.send` (operation `send_transaction`), both invoked only when `executionMode === 'eoa'` and after `assertPermission(apiKeyRecord.canUseEoaExecution, ...)`.
- Caller builds `EoaExecutionPolicyContext` from the API key record (`id`, `keyPrefix`, `allowedIps`, `expiresAt`), `userId`, `clientIp` from `RequestContextService`, `chainId`, and operation-specific metadata (e.g. `type` for sign, `interactionCount` for send).
- `assertAllowed` check order:
  1. `EOA_EXECUTION_ENABLED` not exactly `true` → deny `eoa_execution_disabled`.
  2. No `allowedIps` → deny `eoa_execution_requires_ip_allowlist`.
  3. No `clientIp` → deny `eoa_execution_requires_request_ip`.
  4. `IpAllowlistService` unavailable → deny `eoa_execution_ip_allowlist_unavailable`.
  5. `IpAllowlistService.assertIpAllowed(clientIp, allowedIps, ...)` → throws `ForbiddenException` on mismatch (records `api_key.ip_rejected`).
  6. `expiresAt` missing, invalid, or beyond 30 days → deny `eoa_execution_requires_short_ttl`.
  7. Count `eoa_execution_allowed` security events for the API key in the last 60 s; if ≥ 1 → deny `eoa_execution_rate_limited`.
  8. All checks pass → record `eoa_execution_allowed` (risk `high`).
- Every denial records `eoa_execution_denied` (risk `critical`) with its reason code before throwing `ForbiddenException`.

## Integration
- `EoaExecutionModule` imports `SecurityEventModule` (which provides `SecurityEventService` and `IpAllowlistService`) and exports `EoaExecutionPolicyService`.
- Imported by `WalletModule` and `TransactionsModule`; both inject the policy as `@Optional()` and fail closed with `ForbiddenException` if it is absent.
- Dependencies: `ConfigService` (env `EOA_EXECUTION_ENABLED`, validated in `src/config/env.validation.ts`, default `false` in `.env.example`), `PrismaService` (rate-limit count on `security_events`), `SecurityEventService` (audit), `IpAllowlistService` (IP enforcement).
- Emits security events: `eoa_execution_allowed`, `eoa_execution_denied`, and `api_key.ip_rejected` (via `IpAllowlistService`).
- Not part of the public `openapi.yaml` surface; it is an internal service-layer gate for the public `POST /v1/wallets/sign` and `POST /v1/transactions/send` routes.
# Code Map for /src/common/throttler

## Responsibility
Configures the global HTTP rate limiter for the backend and provides a resilient storage backend that uses Redis for distributed rate limiting when available and transparently falls back to in-memory storage when Redis is unreachable. The module defines the two named throttlers (`short`, `medium`) consumed by route-level `@Throttle()` decorators across all controllers.

## Design/Patterns
- **Strategy/fallback storage**: `ResilientThrottlerStorage` implements Nest's `ThrottlerStorage` interface and delegates `increment()` to either a Redis-backed `ThrottlerStorageRedisService` or an in-memory `ThrottlerStorageService`, switching at runtime based on connection state.
- **Explicit degraded mode**: Redis is used after `ready`; connection errors/close or failed increments fall back to per-instance memory buckets. This still limits requests locally, but is not a global fail-closed guarantee: replicas and mode changes do not share counters.
- **Lazy optional dependency**: `@nest-lab/throttler-storage-redis` is loaded via `require()` inside `initRedis()` so the app boots without it when `REDIS_URL` is unset.
- **Lazy Redis connect**: ioredis client is created with `lazyConnect: true`; `connect()` is fired explicitly and failures are caught.
- **Recovery and shutdown**: retry delay grows from 100ms to a 3s maximum with no attempt cap. Offline command queuing is disabled. Idempotent `onModuleDestroy()` clears memory timers and immediately `disconnect()`s Redis (including pending reconnects), rather than queueing `QUIT` behind an unavailable connection.
- **Safe health snapshot**: `getHealth()` exposes only `status`, `mode`, and an enumerated `reason`; no Redis URL or error text. Configured-but-unavailable Redis is degraded; intentional memory-only configuration is `ok`.

## Flow
1. `RateLimitStorageModule` registers one `ResilientThrottlerStorage` factory provider from `ConfigService` (`redis.url`). Both the throttler options factory and `HealthModule` import this module and consume the same instance.
2. `AppThrottlerModule` configures `short` (ttl 10s, limit 20) and `medium` (ttl 60s, limit 100). Nest's throttler also exposes the options storage through its storage provider; shutdown is idempotent because both provider tokens can invoke the lifecycle hook.
3. On construction, if a Redis URL is present, `initRedis()` builds the ioredis client, wires `error`/`ready`/`close` handlers that toggle `useRedis`, wraps it in `ThrottlerStorageRedisService`, and starts `connect()`. Without a URL, it logs and stays in-memory only.
4. Per request, the global `ApiKeyThrottlerGuard` (see `src/common/guards/api-key-throttler.guard.ts`) calls `storage.increment(key, ttl, limit, blockDuration, throttlerName)`:
   - If `useRedis && redisStorage`, delegate to Redis; on thrown error, log a warning and fall through to memory.
   - Otherwise use `memoryStorage.increment(...)`.
   - Returns `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }` to the guard, which enforces the limit.
5. On Nest application close, `onModuleDestroy()` clears timers and cancels Redis reconnects. Late `ready` events cannot re-enable distributed mode.

## Integration
- **Consumers**: `AppModule` (`src/app.module.ts`) imports `AppThrottlerModule` and registers `ApiKeyThrottlerGuard` as the global `APP_GUARD`; the guard's `getTracker()` keys buckets by API-key prefix (`req.apiKeyRecord.keyPrefix`) when present, else falls back to client IP.
- **Route-level tuning**: controllers use `@Throttle({ short: {...}, medium: {...} })` to override limits (e.g. `src/modules/auth/auth.controller.ts`, `src/modules/wallet/wallet.controller.ts`, `src/modules/transactions/transactions.controller.ts`, `src/modules/api-key/api-key.controller.ts`, `src/modules/billing/onchain/usdc-payment.controller.ts`) and `@SkipThrottle()` to opt out (e.g. `src/modules/billing/stripe/stripe-webhook.controller.ts`).
- **Config**: reads `redis.url` from `src/config/configuration.ts`; `REDIS_URL` is optional in `src/config/env.validation.ts`.
- **Dependencies**: `@nestjs/throttler` ^6.5.0, `@nest-lab/throttler-storage-redis` ^1.2.0 (lazy `require`), `ioredis` ^5.11.0, `@nestjs/config` (via `ConfigModule`/`ConfigService`).

## Files
- `throttler.module.ts` — `RateLimitStorageModule` owns the shared lifecycle provider; `AppThrottlerModule` injects it into `ThrottlerModule.forRootAsync` and declares `short`/`medium`.
- `resilient-throttler-storage.ts` — Redis↔memory storage, bounded persistent recovery, safe `RateLimitHealth`, and idempotent shutdown.
- `resilient-throttler-storage.spec.ts` — behavior regressions for prolonged outages, local blocking, command failure/recovery, safe readiness, and real Nest lifecycle close.
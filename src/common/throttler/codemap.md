# Code Map for /src/common/throttler

## Responsibility
Configures the global HTTP rate limiter for the backend and provides a resilient storage backend that uses Redis for distributed rate limiting when available and transparently falls back to in-memory storage when Redis is unreachable. The module defines the two named throttlers (`short`, `medium`) consumed by route-level `@Throttle()` decorators across all controllers.

## Design/Patterns
- **Strategy/fallback storage**: `ResilientThrottlerStorage` implements Nest's `ThrottlerStorage` interface and delegates `increment()` to either a Redis-backed `ThrottlerStorageRedisService` or an in-memory `ThrottlerStorageService`, switching at runtime based on connection state.
- **Fail-closed to in-memory, never fail-open**: Redis is used only when the `ready` event has fired (`useRedis === true`). Any Redis error, close, retry exhaustion, or failed `increment()` call drops back to in-memory so rate limiting keeps working (non-distributed) instead of being bypassed.
- **Lazy optional dependency**: `@nest-lab/throttler-storage-redis` is loaded via `require()` inside `initRedis()` so the app boots without it when `REDIS_URL` is unset.
- **Lazy Redis connect**: ioredis client is created with `lazyConnect: true`; `connect()` is fired explicitly and failures are caught.
- **Graceful shutdown**: implements `OnModuleDestroy` to flush the in-memory storage and `quit()` the Redis client.

## Flow
1. `AppThrottlerModule` calls `ThrottlerModule.forRootAsync`, injecting `ConfigService` to read `redis.url` (from `REDIS_URL` env, see `src/config/configuration.ts`).
2. A single `ResilientThrottlerStorage` instance is constructed and registered as the throttler `storage`; two named throttlers are declared: `short` (ttl 10s, limit 20) and `medium` (ttl 60s, limit 100).
3. On construction, if a Redis URL is present, `initRedis()` builds the ioredis client, wires `error`/`ready`/`close` handlers that toggle `useRedis`, wraps it in `ThrottlerStorageRedisService`, and starts `connect()`. Without a URL, it logs and stays in-memory only.
4. Per request, the global `ApiKeyThrottlerGuard` (see `src/common/guards/api-key-throttler.guard.ts`) calls `storage.increment(key, ttl, limit, blockDuration, throttlerName)`:
   - If `useRedis && redisStorage`, delegate to Redis; on thrown error, log a warning and fall through to memory.
   - Otherwise use `memoryStorage.increment(...)`.
   - Returns `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }` to the guard, which enforces the limit.
5. On app shutdown, `onModuleDestroy()` flushes memory storage and quits the Redis client.

## Integration
- **Consumers**: `AppModule` (`src/app.module.ts`) imports `AppThrottlerModule` and registers `ApiKeyThrottlerGuard` as the global `APP_GUARD`; the guard's `getTracker()` keys buckets by API-key prefix (`req.apiKeyRecord.keyPrefix`) when present, else falls back to client IP.
- **Route-level tuning**: controllers use `@Throttle({ short: {...}, medium: {...} })` to override limits (e.g. `src/modules/auth/auth.controller.ts`, `src/modules/wallet/wallet.controller.ts`, `src/modules/transactions/transactions.controller.ts`, `src/modules/api-key/api-key.controller.ts`, `src/modules/billing/onchain/usdc-payment.controller.ts`) and `@SkipThrottle()` to opt out (e.g. `src/modules/billing/stripe/stripe-webhook.controller.ts`).
- **Config**: reads `redis.url` from `src/config/configuration.ts`; `REDIS_URL` is optional in `src/config/env.validation.ts`.
- **Dependencies**: `@nestjs/throttler` ^6.5.0, `@nest-lab/throttler-storage-redis` ^1.2.0 (lazy `require`), `ioredis` ^5.11.0, `@nestjs/config` (via `ConfigModule`/`ConfigService`).

## Files
- `throttler.module.ts` — `AppThrottlerModule`: wires `ThrottlerModule.forRootAsync`, reads Redis URL from config, instantiates storage, declares `short`/`medium` throttlers.
- `resilient-throttler-storage.ts` — `ResilientThrottlerStorage`: Redis↔memory fallback storage; key symbols: `initRedis()`, `increment()`, `onModuleDestroy()`, state flags `useRedis`, `redisStorage`, `redisClient`, `memoryStorage`.
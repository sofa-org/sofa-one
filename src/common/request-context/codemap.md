# src/common/request-context/

## Responsibility

Per-request async context propagation. This folder owns the single `RequestContextService`, a thin wrapper around Node's `AsyncLocalStorage` that carries `requestId` and `clientIp` through the entire async call chain of an HTTP request. It lets any service (deep in the call stack, including background/awaited work) retrieve the originating request's ID and client IP without threading parameters through every call, and it provides a uniform `getLogContext()` helper so log lines are consistently correlated by `requestId`.

## Files

| File | Role |
|------|------|
| `request-context.service.ts` | `RequestContextService` — the AsyncLocalStorage-backed context store and accessors |
| `request-context.module.ts` | `RequestContextModule` — `@Global()` Nest module that provides/exports the service |

## Design / Patterns

- **AsyncLocalStorage (node:async_hooks)** — the core mechanism. `run(context, callback)` establishes a context for the callback and everything it awaits; `getStore()` reads it back. This is the idiomatic NestJS/Node way to propagate request-scoped data without request-scoped providers or DI plumbing.
- **Global module** — `@Global()` + `exports: [RequestContextService]` makes the service injectable anywhere without re-importing the module (one consumer, `SecurityEventModule`, still imports it explicitly).
- **Minimal, immutable context shape** — `type RequestContext = { requestId: string; clientIp?: string }`. `clientIp` is optional because only the middleware path populates it.
- **Optional injection at call sites** — consumers (`WalletService`, `TransactionsService`, `AuthService`, `OpenfortService`) declare `@Optional() private readonly requestContext?` and fall back to `?? extra` / `?? null`, so the service is a convenience, never a hard dependency.
- **`getLogContext` contract** — returns `{ requestId, ...extra }` when a requestId is in scope, otherwise returns `extra` unchanged. Callers spread this into logger calls; `extra` keys never get clobbered because `requestId` is spread first.

## Key Symbols

- `RequestContextService.run<T>(context: RequestContext, callback: () => T): T` — input: context + callback; output: callback's return value; runs callback inside the async context.
- `RequestContextService.getRequestId(): string | undefined` — output: current `requestId` or `undefined` outside any `run()` scope.
- `RequestContextService.getClientIp(): string | undefined` — output: current `clientIp` or `undefined`.
- `RequestContextService.getLogContext(extra: Record<string, unknown> = {}): Record<string, unknown>` — input: caller-supplied log fields; output: `extra` merged with `requestId` when present.
- `RequestContextModule` — `@Global()` module; providers/exports `RequestContextService`.

## Flow

1. **Write path (middleware)** — `RequestIdMiddleware` (in `src/common/middleware/`, registered for all routes in `AppModule.configure`) resolves the requestId from the `x-request-id` header (first value, trimmed, ≤128 chars) or generates `randomUUID()`, sets `request.requestId` and the `X-Request-Id` response header, then calls `this.requestContext.run({ requestId, clientIp: request.ip }, next)`.
2. **Propagation** — every handler, guard, interceptor, and service invoked (synchronously or via `await`) under that `next()` call inherits the same async context.
3. **Read path** — services call `getRequestId()` / `getClientIp()` / `getLogContext(extra)` at any depth; `AsyncLocalStorage` returns the store for the current async execution chain.
4. **Teardown** — when the request's async chain completes, the context is automatically discarded; a new request starts with an empty store (`undefined` accessors).

## Integration

- **`src/app.module.ts`** — imports `RequestContextModule` (line 31) and registers `RequestIdMiddleware` for `'*'` routes (lines 54–55); this is the only place the context is written.
- **`src/common/middleware/request-id.middleware.ts`** — the sole producer of context; depends on `RequestContextService.run`.
- **`src/modules/security-events/security-event.service.ts`** — `getRequestId()` (line 66) to attribute `SecurityEvent.requestId` (falls back to `null`).
- **`src/modules/wallet/wallet.service.ts`** — `getClientIp()` (line 423) for signing/withdrawal audit attribution; `getLogContext(extra)` (line 485) for correlated logging.
- **`src/modules/transactions/transactions.service.ts`** — `getClientIp()` (line 296) for transaction audit; `getLogContext(extra)` (line 552).
- **`src/modules/auth/auth.service.ts`** — `getLogContext(extra)` (line 370).
- **`src/core/openfort/openfort.service.ts`** — `getLogContext(extra)` (line 751) so Openfort SDK calls and errors are correlated by requestId.
- **`src/modules/security-events/security-event.module.ts`** — imports `RequestContextModule` (line 11); redundant with `@Global()` but harmless.
- **Dependencies** — `@nestjs/common` (`Injectable`, `Module`, `Global`) and `node:async_hooks` (`AsyncLocalStorage`). No database, config, or external-service dependencies.
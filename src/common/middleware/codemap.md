# src/common/middleware/

## Responsibility

Global HTTP middleware layer for the NestJS backend. Currently holds a single production middleware, `RequestIdMiddleware`, whose job is to:

- Assign a stable request ID to every inbound HTTP request (either honoring a well-formed inbound `x-request-id` header or generating a UUID fallback).
- Propagate that request ID (plus the client IP) through the entire request lifecycle via `AsyncLocalStorage`, so downstream services and logs can correlate work to a single request.
- Echo the request ID back to the client in the `X-Request-Id` response header.

## Files

| File | Role |
| --- | --- |
| `request-id.middleware.ts` | The only production file. Defines `RequestIdMiddleware` (NestJS class-based middleware). |

(`request-id.middleware.spec.ts` is test-only and out of scope.)

## Design / Patterns

- **NestJS class-based middleware**: `@Injectable()` + `implements NestMiddleware`, with a single `use(request, response, next)` method. Registered globally via `MiddlewareConsumer` in `AppModule`.
- **AsyncLocalStorage request context**: the middleware does not just tag the request object — it wraps the downstream handler in `RequestContextService.run({ requestId, clientIp }, next)`, seeding a continuation-local storage context that survives async boundaries (promises, DB calls, etc.).
- **Header passthrough with sanitization**: inbound `x-request-id` is accepted only if it is a non-empty string ≤ 128 chars after trimming; otherwise a `randomUUID()` is generated. Array header values (duplicate headers) collapse to the first element.
- **Type augmentation**: `request.requestId` is not part of Express's stock types; it is declared globally in `src/types/express.d.ts` (`Express.Request.requestId?: string`).
- **Single responsibility**: the middleware only resolves/propagates the ID; it does no logging, auth, or throttling itself.

## Key Symbols

| Symbol | Kind | Notes |
| --- | --- | --- |
| `RequestIdMiddleware` | class | `@Injectable()`, implements `NestMiddleware`. Constructor-injects `RequestContextService`. |
| `use(request, response, next)` | method | Entry point called by Nest for every matched route. |
| `resolveRequestId(header)` | private method | `string \| string[] \| undefined` → `string`. Validates/trims inbound header, falls back to `randomUUID()`. |
| `REQUEST_ID_HEADER` | const | `'x-request-id'` — inbound header read. |
| `MAX_REQUEST_ID_LENGTH` | const | `128` — max accepted inbound ID length. |

## Flow

1. Inbound HTTP request enters the Nest middleware chain (`AppModule.configure` applies this middleware to `'*'`, i.e. all routes).
2. `use()` reads `request.headers['x-request-id']` and passes it to `resolveRequestId`.
3. `resolveRequestId` collapses arrays to the first value, trims, and accepts it only if non-empty and ≤ 128 chars; otherwise returns `randomUUID()`.
4. The resolved ID is written to `request.requestId` (typed via `src/types/express.d.ts`) and to the response header `X-Request-Id`.
5. `requestContext.run({ requestId, clientIp: request.ip }, next)` invokes the rest of the request pipeline inside an `AsyncLocalStorage` context. `request.ip` reflects Express trust-proxy handling (never raw `X-Forwarded-For`).
6. Downstream code reads the context through `RequestContextService` getters (`getRequestId`, `getClientIp`, `getLogContext`).

## Inputs / Outputs

- **Inputs**: Express `Request` (reads `x-request-id` header, `request.ip`), `Response`, `NextFunction`.
- **Outputs**:
  - `request.requestId: string` (always set — either inbound or generated).
  - Response header `X-Request-Id: string`.
  - `next()` invoked inside an ALS context `{ requestId: string, clientIp?: string }`.

## Integration

- **Registration**: `src/app.module.ts` — `RequestIdMiddleware` is listed as a provider and applied via `consumer.apply(RequestIdMiddleware).forRoutes('*')`, so it runs for every route (public API-key routes and frontend-only routes alike).
- **Dependency**: `RequestContextService` from `../request-context/request-context.service` (exported by the `@Global()` `RequestContextModule`, so no per-module import needed).
- **Type contract**: `src/types/express.d.ts` augments `Express.Request` with `requestId?: string`.
- **Consumers of the seeded context**:
  - `getLogContext(...)` — `auth.service.ts`, `wallet.service.ts`, `transactions.service.ts`, `openfort.service.ts` (enrich logs with `requestId`).
  - `getRequestId()` — `security-event.service.ts` (persists `requestId` on security events).
  - `getClientIp()` — `wallet.service.ts`, `transactions.service.ts` (audit/security fields).
- **Client contract**: the `X-Request-Id` response header lets clients correlate requests; the inbound `x-request-id` header lets clients supply their own correlation ID.
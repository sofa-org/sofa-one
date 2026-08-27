# Code Map for /src/common/filters

## Responsibility
Global HTTP exception formatting for the NestJS app: converts any thrown exception (including non-`HttpException`/unknown errors) into a standardized JSON error envelope, derives a stable machine-readable `code`, sanitizes messages before they reach clients, and logs server (5xx) errors with request context. Private/internal details (hashes, URLs, file paths, stack traces) must never leak into API responses.

## Files
- `http-exception.filter.ts` — the only production file. (`http-exception.filter.spec.ts` is a unit test and is intentionally excluded.)

## Key Symbols
- `HttpExceptionFilter` — `@Catch()` (catch-all) `ExceptionFilter<unknown>`, instantiated as a global filter in `main.ts` (line 79: `app.useGlobalFilters(new HttpExceptionFilter())`) and in e2e test bootstrap.
- `catch(exception: unknown, host: ArgumentsHost)` — entry point called by NestJS for every uncaught exception. Reads the Express `Response`/`Request`, derives status (via `exception.getStatus()` for `HttpException`, else `500`), builds the payload, logs 5xx failures, and writes the JSON body.
- `toPayload(status: number, exceptionResponse: string | object)` — private; normalizes the exception body into `{ code, message, details? }`.
- `ExceptionResponse` — local type for the shape of an `HttpException` body (`code?`, `error?`, `message?: string | string[]`).

## Inputs / Outputs
- Input: any `exception` thrown by route handlers/guards/services plus the `ArgumentsHost` for the current request; reads `request.requestId` (set by `src/common/middleware/request-id.middleware.ts`) and `request.method`/`request.url`.
- Output: HTTP response `{ statusCode, code, message, details? (only for validation errors), requestId, timestamp, path }`.
  - `message` is always `sanitizeErrorMessage(...)`-cleaned; array messages collapse to `'Validation failed'` with the raw array preserved in `details`.
- `code` resolution order: explicit `code` on the exception body → `resolveApiErrorCode(status, message)` from `src/common/errors/api-error-codes.ts` (keyword/status matching, array messages → `VALIDATION_ERROR`).

## Design/Patterns
- NestJS global exception filter (`@Catch()` catches everything, not just `HttpException`), so unexpected/unknown errors still yield a controlled 500 response instead of a raw Express error.
- Structured response envelope: every error response carries `requestId` + `timestamp` + `path` for client debugging and server correlation.
- Selective logging: only `status >= 500` is logged via `Logger` (message, requestId, method, path, statusCode, and the stack when the exception is an `Error`); 4xx client errors are not logged.
- Defense-in-depth for leakage: message sanitization (`sanitizeErrorMessage`) plus code mapping kept in separate helpers (`api-error-codes.ts`, `utils/sanitize.ts`) rather than inline.

## Flow
1. NestJS routes the exception to `HttpExceptionFilter.catch` (global filter).
2. Status: `HttpException` → `getStatus()`; anything else → `500 Internal Server Error`.
3. `toPayload` normalizes the body: string bodies are treated as the message; object bodies use `message ?? error ?? 'Unexpected error'`.
4. Array messages → `message: 'Validation failed'` with the raw array in `details`; scalar messages are `sanitizeErrorMessage`-cleaned (hex → `[hex]`, URLs → `[url]`, paths → `[path]`, stack lines stripped, truncated to 500 chars).
5. `code` = explicit body code, else `resolveApiErrorCode(status, codeSource)` (arrays and scalars both supported so validation errors resolve correctly).
6. 5xx: `logger.error` with request correlation context.
7. Respond `response.status(status).json({ statusCode, ...payload, requestId, timestamp, path })`.

## Integration
- Registered globally in `src/main.ts` via `useGlobalFilters`; also applied in `test/frontend-only.e2e-spec.ts` and `test/api-key-flow.e2e-spec.ts` e2e setups. Not scoped per controller.
- Consumes `request.requestId`/`X-Request-Id` populated by `src/common/middleware/request-id.middleware.ts` (which runs before controllers) and echoes it back to clients.
- Depends on `resolveApiErrorCode` (`src/common/errors/api-error-codes.ts`) and `sanitizeErrorMessage` (`src/common/utils/sanitize.ts`).
- Consumed by the frontend: `frontend/src/lib/api.ts` surfaces `requestId` in the error class and appends `Request ID: <id>` to error messages for user support.

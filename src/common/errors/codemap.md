# Code Map for /src/common/errors

## Responsibility
Single source of truth for machine-readable API error codes: defines the canonical code vocabulary, the `ApiErrorCode` type, and a pure resolver that maps an HTTP status + raw error message to the most specific code. The backend never relies on raw message text for API consumers — it emits a stable `code` string in every HTTP error envelope.

## Design/Patterns
- Single-file module (`api-error-codes.ts`) with no runtime services or NestJS providers — plain exported constants, a type, and one pure function.
- `API_ERROR_CODES` is declared `as const`, so both the runtime object and the derived union type (`ApiErrorCode`) come from one definition; values mirror keys to keep codes self-describing and greppable. DeFi policy denials have stable `DEFI_*` identifiers and generic messages.
- Resolver is pure and side-effect-free: `(statusCode, message) => ApiErrorCode`. Input is a string or `string[]` (class-validator produces arrays); any array input short-circuits to `VALIDATION_ERROR`.
- Ordered substring matching over a lowercased message: most-specific domain substrings (e.g. `'wallet is not active'`, `'paymaster policy'`) are checked before coarse HTTP-status fallbacks (`401 → UNAUTHORIZED`, `404 → NOT_FOUND`, `>= 500 → INTERNAL_ERROR`, else `BAD_REQUEST`).
- Defense in depth: services may throw exceptions with an explicit `code` in the response body; `resolveApiErrorCode` is only the fallback for exceptions without one.

## Flow
- `resolveApiErrorCode(statusCode, message)`:
  1. `Array.isArray(message)` → `VALIDATION_ERROR`.
  2. Lowercase the string and run ordered `includes()` checks → one of the 20 domain codes (e.g. `INVALID_API_KEY`, `IDEMPOTENCY_CONFLICT`, `CHAIN_NOT_SUPPORTED`, `RAW_HASH_SIGNING_DISABLED`, `USER_OPERATION_REJECTED`).
  3. No match → status-code fallback via `HttpStatus`: `UNAUTHORIZED`, `NOT_FOUND`, `INTERNAL_ERROR` (5xx), `BAD_REQUEST` (default).
- Errors thrown by services (e.g. `ConflictException({ code: API_ERROR_CODES.AGENT_REGISTRATION_PENDING, ... })`) bypass the resolver entirely and are passed through verbatim by the filter.

## Integration
- **Consumers of `resolveApiErrorCode`:** `src/common/filters/http-exception.filter.ts` (only backend consumer). The global filter calls it in `toPayload()` when an exception response carries no explicit `code`, passing the raw message/array so array payloads resolve to `VALIDATION_ERROR`; it prefers `response.code` when present.
- **Consumers of `API_ERROR_CODES`:** `src/core/openfort/openfort.service.ts` throws NestJS exceptions with explicit `code` payloads for Openfort/user-operation failures (`AGENT_REGISTRATION_PENDING`, `PAYMASTER_POLICY_NOT_CONFIGURED`, `WALLET_SERVICE_UNAVAILABLE`, `BACKEND_TRANSACTION_FAILED`, `USER_OPERATION_GAS_PRICE_UNAVAILABLE`, `USER_OPERATION_REJECTED`).
- **Downstream contract:** the emitted `code` string is the public wire contract consumed by the SPA in `frontend/src/lib/api.ts`, where `ApiError.code` carries it and `hasApiErrorCode(error, ...codes)` branches on it.
- **Dependencies:** `@nestjs/common` (for `HttpStatus` in the status-code fallbacks). No imports from other project modules, so the file has no intra-repo dependency graph.

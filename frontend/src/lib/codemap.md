# API Client Library

## Responsibility
Centralizes browser requests to the backend with auth header injection, JSON handling, and normalized errors.

## Design/Patterns
- Two typed transport helpers: Clerk JWT (`authFetch<T>`) and explicit API key (`apiFetch<T>`)
- `apiFetch` wrappers are limited to public API-key endpoints (`/v1/wallets/sign`, `/v1/transactions/send`, `/v1/transactions/:id`)
- Frontend-only routes (`/v1/api-keys/*`, `/v1/wallets/balances`, `/v1/wallets/withdraw`) use Clerk JWT wrappers only
- Shared DTO/response types and error parsing for non-2xx responses

## Flow
- `authFetch` calls `getToken()` and sends `Authorization: Bearer ...`
- `apiFetch` sends `X-API-Key: ...`
- Both default to `VITE_API_URL` or `/api` and parse JSON responses
- Higher-level helpers map directly to backend routes used by dashboard pages and public API examples

## Integration
- Depends on browser `fetch` and Clerk token retrieval
- Consumed by dashboard pages for all data fetches and mutations

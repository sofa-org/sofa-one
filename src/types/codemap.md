# src/types/

## Responsibility

Global TypeScript ambient type declarations for the backend. This folder augments
third-party / framework types (Express) with request-scoped fields that the NestJS
app populates at runtime. It is the single source of truth for "what is attached to
`req`" so that controllers, guards, filters, and decorators can read these fields
with full type safety.

Contains one production file: `express.d.ts`.

## Design / Patterns

- **Module augmentation / ambient declaration**: `express.d.ts` uses
  `declare global { namespace Express { interface Request { ... } } }` to extend the
  existing `Express.Request` interface rather than creating a new type. This is the
  idiomatic way to type fields added to the Express request object by middleware and
  guards.
- **Optional fields**: every added field is optional (`?`), reflecting that they are
  populated conditionally depending on which guard/middleware ran for a given route.
- **Prisma model reuse**: `user` and `apiKeyRecord` are typed directly from the
  generated Prisma client (`@prisma/client` `User`, `ApiKey`), avoiding duplicated
  shape definitions. `apiKeyRecord` is `ApiKey & { user?: User }` to expose the
  related user when the API key resolves one.
- **`export {}`**: the trailing empty export marks the file as a module so the
  `declare global` block augments the global scope instead of being treated as a
  script.

### Key symbols

| Symbol | Type | Meaning |
| --- | --- | --- |
| `Express.Request.requestId` | `string?` | Correlation id for the request; set by `RequestIdMiddleware`. |
| `Express.Request.user` | `User?` | Resolved full user record; set by auth guards. |
| `Express.Request.apiKeyRecord` | `ApiKey & { user?: User }?` | Resolved API-key record (with optional related user); set by API-key auth guards. |
| `Express.Request.openfortUserId` | `string?` | Openfort IAM user id from the validated session. |
| `Express.Request.openfortEmail` | `string?` | Email from the validated Openfort session. |
| `Express.Request.openfortSession` | `unknown?` | Raw Openfort session payload (opaque). |

## Flow

1. `RequestIdMiddleware` runs first for every request: it resolves a `requestId`
   (from the `x-request-id` header if valid, else a fresh `randomUUID()`), assigns it
   to `request.requestId`, echoes it in the `X-Request-Id` response header, and seeds
   `RequestContextService` (AsyncLocalStorage) with `{ requestId, clientIp }`.
2. Depending on the route's guard, one of the auth guards populates the request:
   - `OpenfortUserGuard` / `EitherAuthGuard` (Openfort IAM path) set
     `request.openfortUserId`, `request.openfortEmail`, `request.openfortSession`,
     and `request.user` (the resolved `User` row).
   - `ApiKeyAuthGuard` / `EitherAuthGuard` (API-key path) set `request.apiKeyRecord`
     and `request.user` (from `keyRecord.user`).
3. Downstream consumers read these fields:
   - `CurrentUserDecorator` reads `request.user`.
   - `StepUpGuard` reads `request.user?.id`.
   - `ApiKeyOnlyGuard` / `ApiKeyPermissionGuard` / `ApiKeyThrottlerGuard` read
     `request.apiKeyRecord`.
   - `HttpExceptionFilter` reads `request.requestId` for error correlation.
   - Controllers (e.g. `WalletController.sign`) pass `req.apiKeyRecord` into services.

## Integration

- **`src/common/middleware/request-id.middleware.ts`** — writes `request.requestId`;
  pairs with `RequestContextService` for AsyncLocalStorage-based logging context.
- **`src/common/guards/openfort-user.guard.ts`**, **`either-auth.guard.ts`**,
  **`api-key-auth.guard.ts`** — write `request.user`, `request.apiKeyRecord`, and the
  `openfort*` fields.
- **`src/common/guards/api-key-only.guard.ts`**, **`api-key-permission.guard.ts`**,
  **`api-key-throttler.guard.ts`** — read `request.apiKeyRecord`.
- **`src/common/guards/step-up.guard.ts`** — reads `request.user?.id`.
- **`src/common/decorators/current-user.decorator.ts`** — reads `request.user`.
- **`src/common/filters/http-exception.filter.ts`** — reads `request.requestId` for
  error responses/logging.
- **`src/modules/wallet/wallet.controller.ts`** — passes `req.apiKeyRecord` to
  `WalletService.sign`.
- **`@prisma/client`** — provides the `User` and `ApiKey` model types referenced here.

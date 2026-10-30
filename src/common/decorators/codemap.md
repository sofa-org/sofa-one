# Code Map for /src/common/decorators

## Responsibility
Route- and parameter-level decorators that control auth-related controller behavior. They are thin metadata markers (plus one param extractor) with **no business logic**: they only stamp metadata onto handlers/classes or read values off the request. Actual enforcement lives in the guards under `/src/common/guards`.

## Files & Key Symbols

### api-key-permission.decorator.ts
- `ApiKeyPermission` (type): `'canSign' | 'canSendTransaction' | 'canReadTransactionStatus' | 'canUseEoaExecution'`
- `API_KEY_PERMISSION_KEY = 'apiKeyPermission'` (exported const)
- `RequireApiKeyPermission(permission: ApiKeyPermission)` → `SetMetadata(API_KEY_PERMISSION_KEY, permission)`
- Input: a permission string; Output: NestJS metadata decorator.
- Dependencies: `@nestjs/common` (`SetMetadata`).

### current-user.decorator.ts
- `CurrentUser` (param decorator via `createParamDecorator`)
- Input: optional `data` (property name, e.g. `'id'`) + `ExecutionContext`; Output: `request.user` or `request.user[data]`.
- Depends on request.user attached by AppSessionGuard or ApiKeyAuthGuard.
- Dependencies: `@nestjs/common` (`createParamDecorator`, `ExecutionContext`).

### frontend-only.decorator.ts
- `IS_FRONTEND_ONLY_KEY = 'isFrontendOnly'` (exported const)
- `FrontendOnly()` → `SetMetadata(IS_FRONTEND_ONLY_KEY, true)`
- Input: none; Output: metadata decorator.
- Dependencies: `@nestjs/common` (`SetMetadata`).

### public.decorator.ts
- `IS_PUBLIC_KEY = 'isPublic'` (exported const)
- `Public()` → `SetMetadata(IS_PUBLIC_KEY, true)`
- Input: none; Output: metadata decorator.
- Dependencies: `@nestjs/common` (`SetMetadata`).

### step-up.decorator.ts
- `STEP_UP_KEY = 'requireStepUp'` (exported const)
- `RequireStepUp()` → `SetMetadata(STEP_UP_KEY, true)`
- Input: none; Output: metadata decorator. Frontend must supply a proof token in the `X-Step-Up-Token` header.
- Dependencies: `@nestjs/common` (`SetMetadata`).

## Design/Patterns
- **NestJS metadata decorator pattern**: each marker decorator calls `SetMetadata(KEY, value)`; guards read the same key via `Reflector.getAllAndOverride(KEY, [handler, class])` at request time.
- **Param decorator pattern**: `CurrentUser` uses `createParamDecorator` to extract `request.user` (with optional property access) instead of injecting `@Req()` in every handler.
- **Thin helpers / no business logic**: decorators only declare intent; all enforcement (auth, origin checks, permission checks, step-up validation) is delegated to guards and services.
- **Exported metadata keys**: keys are exported as constants so guards import them directly (no string duplication).

## Flow
1. At class/handler definition time, decorators stamp metadata onto the route (e.g. `@Public()`, `@FrontendOnly()`, `@RequireStepUp()`, `@RequireApiKeyPermission('canSign')`).
2. At request time, guards query that metadata with `Reflector.getAllAndOverride`:
   - Public metadata bypasses ApiKeyAuthGuard, AppSessionGuard and OpenfortAuthGuard where explicitly applied.
   - `FrontendOnly` → `FrontendOnlyGuard` validates `Origin`/`Referer` against the `CORS_ORIGIN` allowlist.
   - RequireStepUp validates X-Step-Up-Token against exact userId AND request.appSession.id plus live full-MFA state.
   - `RequireApiKeyPermission` → `ApiKeyPermissionGuard` checks `request.apiKeyRecord[permission] === true`.
3. `CurrentUser` reads `request.user` (populated by the auth guard) and optionally returns a single property.

## Integration
- Public is consumed by API-key, application-session and provider-identity guards; health/Stripe endpoints retain their explicit public boundaries.
- **`FrontendOnly()`** — consumed by `FrontendOnlyGuard` (`IS_FRONTEND_ONLY_KEY`). Applied to dashboard/frontend-only routes in `BillingController`, `UsdcPaymentController`, `DashboardWalletController`, `DashboardTransactionsController`, `SecurityNotificationController`, `ApiKeyController`, and `MfaController`. These routes are intentionally omitted from `openapi.yaml`.
- **`RequireApiKeyPermission()`** — consumed by `ApiKeyPermissionGuard` (`API_KEY_PERMISSION_KEY`), which reads the permission off `request.apiKeyRecord` (set by `ApiKeyAuthGuard`). Used on public API-key routes: `WalletController.sign` (`canSign`), `TransactionsController.send` (`canSendTransaction`), `TransactionsController.getStatus` (`canReadTransactionStatus`). `canUseEoaExecution` remains in the union and is enforced by `WalletService` for restricted signing, not by the transaction send route or a route decorator.
- **`RequireStepUp()`** — consumed by `StepUpGuard` (`STEP_UP_KEY`). Applied to sensitive routes: `ApiKeyController` (create/list/revoke/rotate), `DashboardWalletController` (withdraw, withdrawal-address add/remove). `WithdrawalPolicyService` also checks step-up state as defense-in-depth.
- AllowPendingMfa is consumed only by AppSessionGuard and applied to session introspection/current logout and MFA status/setup/enable/verify; never business routes or factor disable.
- **`CurrentUser`** — used across all dashboard controllers (`BillingController`, `WalletController`, `TransactionsController`, `ApiKeyController`, `SecurityNotificationController`, `UsdcPaymentController`) and public API-key routes (`WalletController.sign`, `TransactionsController.send/getStatus`) to obtain `userId` from the authenticated request.

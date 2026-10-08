# Code Map for /src/modules/api-key/dto

## Responsibility
Defines the validated request shape for API-key creation (`POST /v1/api-keys`). The DTO layer is the single gate that normalizes and validates the create payload before it reaches `ApiKeyService.createApiKey`, enforcing field types, string formats (IP/CIDR, Ethereum address, function selector, wei amounts), nested-object shape, and length/format bounds. It also carries the permission and spend-limit sub-objects that drive downstream API-key authorization.

## Files
- `create-api-key.dto.ts` — the only production file in this directory. Contains three exported DTO classes plus four private validator constraints.

## Key Symbols

### Exported classes
| Symbol | Kind | Purpose |
|--------|------|---------|
| `CreateApiKeyDto` | DTO (root) | Request body for API-key creation; capability mode (`all`/`custom`) and optional configured IDs (maximum 100 unique nonempty IDs ≤160 chars), plus name, expiry, IPs, spend limits, and permissions. |
| `ApiKeyPermissionsDto` | DTO (nested) | Optional boolean flags: `canSign`, `canSendTransaction`, `canReadTransactionStatus`, `canUseEoaExecution`. All optional; absence means "not granted". |
| `ApiKeySpendLimitsDto` | DTO (nested) | Optional wei-amount strings: `daily`, `monthly`. Validated as non-negative integer strings via `IsWeiAmountConstraint`. |

### Private validator constraints (not exported)
| Symbol | Kind | Rule |
|--------|------|------|
| `IsIpOrCidrConstraint` | `ValidatorConstraint` (`isIpOrCidr`, sync) | Delegates to `isIpOrCidr()` from `src/common/utils/ip-cidr`; used with `{ each: true }` on `allowedIps`. |
| `IsWeiAmountConstraint` | `ValidatorConstraint` (`isWeiAmount`, sync) | Regex `^\d+$`; used on `ApiKeySpendLimitsDto.daily`/`monthly`. |

## Inputs / Outputs
- **Input**: raw JSON request body of `POST /v1/api-keys` (Openfort IAM bearer token + step-up required at the controller level).
- **Output**: a validated, transformed `CreateApiKeyDto` instance whose fields are destructured by `ApiKeyController.create` into the plain object passed to `ApiKeyService.createApiKey(userId, {...})`.
- **Rejection**: invalid input surfaces as a 400 via the global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`); unknown fields are rejected, not stripped.

## Design / Patterns
- **NestJS DTO + class-validator/class-transformer**: declarative validation via decorators; `@Transform` trims `name`; `@Type(() => ...)` + `@ValidateNested()` recursively transforms/validates nested `spendLimits` and `permissions`.
- **Custom sync `ValidatorConstraint`s**: four small, single-purpose constraints with explicit `defaultMessage()` strings for user-facing 400 errors; array fields reuse them with `{ each: true }`.
- **Optional-by-default permission model**: every permission and spend-limit field is `@IsOptional()`, so an omitted capability is simply not granted downstream (deny-by-default).
- **Single Responsibility**: the file only shapes/validates input; no business logic, hashing, or persistence.

## Flow
1. `POST /v1/api-keys` → `ApiKeyController.create` (guarded by `OpenfortUserGuard`, `FrontendOnlyGuard`, `StepUpGuard`; throttled 5/60s, 20/1h).
2. Global `ValidationPipe` transforms the raw body into `CreateApiKeyDto` and runs all decorator rules (trim, length, ISO-8601, per-element regex checks, nested-object validation).
3. On success, the controller destructures the DTO fields and forwards them as a plain object to `ApiKeyService.createApiKey(userId, {...})`.
4. On failure, the pipe throws a 400 before any service code runs.

## Integration
- **Consumer**: `src/modules/api-key/api-key.controller.ts` — imports `CreateApiKeyDto` and binds it to the `@Body()` of the create endpoint.
- **Downstream**: `ApiKeyService.createApiKey` receives the validated fields; `permissions` and `spendLimits` feed API-key authorization and spend-limit enforcement in the API-key auth/permission guards and transaction/signing paths.
- **Dependency**: `src/common/utils/ip-cidr.ts` — `isIpOrCidr()` backs `IsIpOrCidrConstraint` (shared IP/CIDR validation used elsewhere in the codebase).
- **External libs**: `class-validator` (decorators + `ValidatorConstraint`), `class-transformer` (`Transform`, `Type`).
- **Not part of the public API spec**: `POST /v1/api-keys` is a frontend-only route (omitted from `openapi.yaml`); this DTO is never used by API-key-authenticated public endpoints.

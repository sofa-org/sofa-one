# Code Map for /src/modules/wallet/dto

## Responsibility
Validated request bodies and query params for the wallet module's signing and withdrawal flows. These DTOs are the single source of truth for what the `WalletController` accepts from clients; they enforce shape, format, and business-rule bounds before any service logic runs. No business logic lives here beyond validation.

## Files & Key Symbols

### `sign.dto.ts`
- **`SignMessage`** (type): `string | { raw: \`0x${string}\` }` — plain text or hex data.
- **`ExecutionMode`** (type): `'session_key' | 'eoa'` — which backend wallet authority signs.
- **`isSignMessage(value)`** (private fn): type guard; accepts non-empty string or a single-key `{ raw }` object whose `raw` is even-length hex (`/^0x(?:[a-fA-F0-9]{2})*$/`).
- **`IsSignMessage(options?)`** (private decorator factory): wraps the guard via `ValidateBy` with a custom message.
- **`SignDto`** (class): fields `executionMode?`, `chainId?`, `type` (`'message' | 'typed_data'`, required), `message?`, `typedData?`.
  - Input: JSON body for `POST /v1/wallets/sign`.
  - Output: validated `SignDto` instance consumed by `WalletService.sign` and `SigningPolicyService`.
  - Conditional rules: `message` required only when `type === 'message'`; `typedData` required only when `type === 'typed_data'` (via `@ValidateIf`). Raw hash signing is intentionally disabled (no `'hash'` type).

### `withdraw.dto.ts`
- **`WithdrawalToken`** (type): `'USDC' | 'USDT' | 'NATIVE'`.
- **Amount constants** (exported `BigInt`): `USDC_MAX_AMOUNT` (10k), `USDC_HIGH_VALUE_AMOUNT` (1k), `USDC_MIN_AMOUNT` (0.01), `NATIVE_MAX_AMOUNT` (100 wei), `NATIVE_HIGH_VALUE_AMOUNT` (1 wei), `NATIVE_MIN_AMOUNT` (1n). Stablecoins use 6 decimals; native uses 18.
- **`getWithdrawalAmountBounds(token)`** (private fn): returns `{ min, max, label }` per token family.
- **`IsWithdrawalAmount(options?)`** (private decorator factory): `registerDecorator` validating that `amount` is a digits-only string parseable to `BigInt` within the token's bounds; reads `token` from the containing `WithdrawDto` instance.
- **`WithdrawDto`** (class): fields `chainId` (`@IsInt @Min(1)`), `to` (Ethereum address regex), `amount` (string, `@MaxLength(40)` + `@IsWithdrawalAmount`), `token` (`@IsIn`), `idempotencyKey` (alphanumeric, max 64).
  - Input: JSON body for `POST /v1/wallets/withdraw`.
  - Output: validated `WithdrawDto` consumed by `WalletService.withdraw` and `WithdrawalPolicyService`.

### `withdrawal-address.dto.ts`
- **`CreateWithdrawalAddressDto`** (class): fields `address` (Ethereum address regex, required), `label?` (string, max 100).
  - Input: JSON body for `POST /v1/wallets/withdrawal-addresses`.
  - Output: validated DTO consumed by `WalletService.addWithdrawalAddress` / `WithdrawalPolicyService.addWithdrawalAddress`.

### `list-signing-requests-query.dto.ts`
- **`ListSigningRequestsQueryDto`** (class): optional query filters `type?` (`'message' | 'typed_data'`), `chainId?` (`@IsInt @Min(1)`), `status?` (`'submitting' | 'signed' | 'failed'`), `page?` (default 1), `limit?` (default 20, `@Max(100)`). Numeric fields use `@Type(() => Number)` for query-string coercion.
  - Input: query string for `GET /v1/wallets/signing-requests`.
  - Output: validated query object consumed by `WalletService.listSigningRequests`.

## Design/Patterns
- **class-validator + class-transformer DTOs**: standard NestJS validation layer; the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) applies these decorators, so unknown fields 400.
- **Conditional validation** via `@ValidateIf` in `SignDto` to enforce type-dependent required fields.
- **Custom decorators via `ValidateBy`/`registerDecorator`** for non-trivial rules (`IsSignMessage`, `IsWithdrawalAmount`), keeping regex/BigInt logic encapsulated and testable.
- **Cross-field validation**: `IsWithdrawalAmount` reads sibling `token` from the instance to pick bounds.
- **Type aliases + exported constants** (`ExecutionMode`, `SignMessage`, `WithdrawalToken`, amount bounds) are shared with service/policy layers as `import type`, keeping a single source of truth for allowed values and limits.
- **Query coercion** with `@Type(() => Number)` so string query params become numbers before `@IsInt` runs.

## Flow
1. `POST /v1/wallets/sign` → `SignDto` validates `type` and conditionally requires `message` (EIP-191) or `typedData` (EIP-712); `executionMode` defaults to session key; `chainId` optional (required for message signing, optional for typed data when `domain.chainId` present). Passed to `WalletService.sign`.
2. `POST /v1/wallets/withdraw` → `WithdrawDto` validates chain, destination address, token, amount within token-specific bounds, and idempotency key. Passed to `WalletService.withdraw`.
3. `POST /v1/wallets/withdrawal-addresses` → `CreateWithdrawalAddressDto` validates address + optional label. Passed to `WalletService.addWithdrawalAddress`.
4. `GET /v1/wallets/signing-requests` → `ListSigningRequestsQueryDto` validates optional filters/pagination. Passed to `WalletService.listSigningRequests`.

## Integration
- **`WalletController`** (`../wallet.controller.ts`) is the sole consumer of all four DTOs as `@Body()`/`@Query()` parameters:
  - `SignDto` → `POST /v1/wallets/sign` (API-key only, `ApiKeyAuthGuard` + `ApiKeyPermissionGuard`, requires `canSign`).
  - `WithdrawDto` → `POST /v1/wallets/withdraw` (frontend-only, step-up required).
  - `CreateWithdrawalAddressDto` → `POST /v1/wallets/withdrawal-addresses` (frontend-only, step-up required).
  - `ListSigningRequestsQueryDto` → `GET /v1/wallets/signing-requests` (frontend-only).
- **`WalletService`** (`../wallet.service.ts`): consumes `SignDto`/`SignMessage`/`ExecutionMode` (sign, `resolveSigningChainId`), `WithdrawDto` (withdraw, `getWithdrawalTokenLabel`), `CreateWithdrawalAddressDto` (addWithdrawalAddress), `ListSigningRequestsQueryDto` (listSigningRequests).
- **`SigningPolicyService`** (`../signing-policy.service.ts`): consumes `SignDto`/`SignMessage` types for policy checks.
- **`WithdrawalPolicyService`** (`../withdrawal-policy.service.ts`): consumes `WithdrawDto` and `CreateWithdrawalAddressDto` types for policy checks.
- **Dependencies**: `class-validator`, `class-transformer` (external). No internal module imports; DTOs are leaf nodes.
- **Tests** (not part of this map): `sign.dto.spec.ts`, `withdraw.dto.spec.ts` cover the validation rules.

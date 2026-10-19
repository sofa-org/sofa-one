# Code Map for /src/modules/wallet/dto

## Responsibility
Validated request bodies and query params for the wallet module's signing and withdrawal flows. These DTOs are the single source of truth for what the API-key `WalletController` and IAM `DashboardWalletController` accept; they enforce shape, format, and business-rule bounds before any service logic runs. No business logic lives here beyond validation.

## Files & Key Symbols

### `sign.dto.ts`
- **`ExecutionMode`** (type): `'eoa'` — the only signing authority, also the default when omitted. Transaction execution modes are independent.
- **`SignDto`** (class): fields `walletId?`, `executionMode?`, `chainId?`, required `type: 'typed_data'` and `typedData`. Message payloads, raw-hash signing, and session-key signing are rejected by validation.
  - Input: JSON body for `POST /v1/wallets/sign`.
  - Output: validated `SignDto` instance consumed by `WalletService.sign` and `SigningPolicyService`.
  - `typedData` is required and must be an object; runtime policy restricts its contents to approved Polymarket lanes. `chainId` may be inferred from `typedData.domain.chainId`.

### `withdraw.dto.ts`
- **`WithdrawalToken`** (type): `'USDC' | 'USDT' | 'NATIVE'`.
- **Amount constants** (exported `BigInt`): `USDC_MAX_AMOUNT` (10k), `USDC_HIGH_VALUE_AMOUNT` (1k), `USDC_MIN_AMOUNT` (0.01), `NATIVE_MAX_AMOUNT` (100 wei), `NATIVE_HIGH_VALUE_AMOUNT` (1 wei), `NATIVE_MIN_AMOUNT` (1n). Stablecoins use 6 decimals; native uses 18.
- **`getWithdrawalAmountBounds(token)`** (private fn): returns `{ min, max, label }` per token family.
- **`IsWithdrawalAmount(options?)`** (private decorator factory): `registerDecorator` validating that `amount` is a digits-only string parseable to `BigInt` within the token's bounds; reads `token` from the containing `WithdrawDto` instance.
- **`WithdrawDto`** (class): fields `chainId` (`@IsInt @Min(1)`), `to` (Ethereum address regex), `amount` (string, `@MaxLength(40)` + `@IsWithdrawalAmount`), `token` (`@IsIn`), `idempotencyKey` (alphanumeric, max 64).
  - Input: JSON body for `POST /wallets/withdrawals`.
  - Output: validated `WithdrawDto` consumed by `WalletService.withdraw` and `WithdrawalPolicyService`.

### `withdrawal-address.dto.ts`
- **`CreateWithdrawalAddressDto`** (class): fields `address` (Ethereum address regex, required), `label?` (string, max 100).
  - Input: JSON body for `POST /wallets/withdrawal-addresses`.
  - Output: validated DTO consumed by `WalletService.addWithdrawalAddress` / `WithdrawalPolicyService.addWithdrawalAddress`.

### `wallet-query.dto.ts`
- `WalletDepositInfoDto` validates `chainId` with numeric query-string coercion and optional UUID `walletId`; used by canonical `GET /wallets/deposits`. `WalletBalancesQueryDto` validates dashboard balance query parameters.

### `list-signing-requests-query.dto.ts`
- **`ListSigningRequestsQueryDto`** (class): optional query filters `type?` (`'message' | 'typed_data'`), `chainId?` (`@IsInt @Min(1)`), `status?` (`'submitting' | 'signed' | 'failed'`), `page?` (default 1), `limit?` (default 20, `@Max(100)`). Numeric fields use `@Type(() => Number)` for query-string coercion.
  - Input: query string for `GET /wallets/signing-requests`.
  - Output: validated query object consumed by `WalletService.listSigningRequests`.

## Design/Patterns
- **class-validator + class-transformer DTOs**: standard NestJS validation layer; the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) applies these decorators, so unknown fields 400.
- **Signing validation** directly requires the typed-data object; there is no message-specific or conditional signing branch.
- **Custom withdrawal decorator via `registerDecorator`** encapsulates and tests withdrawal amount bounds without adding signing-message validation.
- **Cross-field validation**: `IsWithdrawalAmount` reads sibling `token` from the instance to pick bounds.
- **Type aliases + exported constants** (`ExecutionMode`, `WithdrawalToken`, amount bounds) are shared with service/policy layers as `import type`, keeping a single source of truth for allowed values and limits.
- **Query coercion** with `@Type(() => Number)` so string query params become numbers before `@IsInt` runs.

## Flow
1. `POST /v1/wallets/sign` → `SignDto` accepts typed data with EOA execution only (omitted executionMode defaults to EOA in the service); runtime policy accepts only approved Polymarket lanes. EIP-191 `message` is rejected by DTO validation; arbitrary typed-data shapes are denied by policy.
2. `POST /wallets/withdrawals` → `WithdrawDto` validates chain, destination address, token, amount within token-specific bounds, and idempotency key. Passed to `WalletService.withdraw`.
3. `POST /wallets/withdrawal-addresses` → `CreateWithdrawalAddressDto` validates address + optional label. Passed to `WalletService.addWithdrawalAddress`.
4. `GET /wallets/signing-requests` → `ListSigningRequestsQueryDto` validates optional filters/pagination. Passed to `WalletService.listSigningRequests`.

## Integration
- **Controllers** (`../wallet.controller.ts`) consume these DTOs as `@Body()`/`@Query()` parameters:
  - `SignDto` → `POST /v1/wallets/sign` (API-key only, `ApiKeyAuthGuard` + `ApiKeyPermissionGuard`, requires `canSign`).
  - `WithdrawDto` → `POST /wallets/withdrawals` (frontend-only, step-up required).
  - `CreateWithdrawalAddressDto` → `POST /wallets/withdrawal-addresses` (frontend-only, step-up required).
  - `ListSigningRequestsQueryDto` → `GET /wallets/signing-requests` (frontend-only).
- **`WalletService`** (`../wallet.service.ts`): consumes `SignDto`/`ExecutionMode` (sign, `resolveSigningChainId`), `WithdrawDto` (withdraw, `getWithdrawalTokenLabel`), `CreateWithdrawalAddressDto` (addWithdrawalAddress), `ListSigningRequestsQueryDto` (listSigningRequests, preserving historical message filters).
- **`SigningPolicyService`** (`../signing-policy.service.ts`): consumes `SignDto` typed-data shape for policy checks; signing context is typed-data/EOA only.
- **`WithdrawalPolicyService`** (`../withdrawal-policy.service.ts`): consumes `WithdrawDto` and `CreateWithdrawalAddressDto` types for policy checks.
- **Dependencies**: `class-validator`, `class-transformer` (external). No internal module imports; DTOs are leaf nodes.
- **Tests** (not part of this map): `sign.dto.spec.ts`, `withdraw.dto.spec.ts` cover the validation rules.

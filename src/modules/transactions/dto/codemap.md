# Code Map for /src/modules/transactions/dto

## Responsibility
Request/query validation types for the transactions module: the public send-transaction body and the dashboard-only list-transactions query. The DTOs are the single source of truth for shape, constraints, and shared validation constants consumed by the controller, service, and transaction-policy service.

## Files
- `send-transaction.dto.ts` — request body DTO for `POST /v1/transactions/send` plus shared interaction constants and nested `InteractionDto`.
- `list-transactions-query.dto.ts` — query-string DTO for `GET /v1/transactions` with status filter and pagination.

## Design/Patterns
- Class-validator decorator-based DTOs validated by the global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`); unknown request fields are 400s, not silently stripped.
- Primitive types (addresses, calldata, wei) validated via `Matches` regex rather than enums; enum-like string unions (`ExecutionMode`, `SponsorshipMode`, `VALID_STATUSES`) enforced with `IsIn`.
- Nested array validation via `ValidateNested({ each: true })` + `@Type(() => InteractionDto)` from class-transformer.
- Query-string coercion: `@Type(() => Number)` on numeric query fields because `@Query()` values arrive as strings (transform mode does not otherwise coerce).
- Shared validation constants exported from the DTO file so policy logic and validators stay in sync with DTO limits (single source of truth).

## Key Symbols

### send-transaction.dto.ts
- `type ExecutionMode = 'session_key' | 'eoa'` — which backend wallet authority executes. Also independently redeclared in `wallet/dto/sign.dto.ts` (module-local copy).
- `type SponsorshipMode = 'required' | 'none'`.
- `const MAX_TRANSACTION_INTERACTIONS = 10` — max interactions per send; mirrors `TransactionPolicyService.assertAllowed` limit.
- `const MAX_INTERACTION_CALLDATA_BYTES = 64 * 1024` — per-interaction calldata cap; imported by policy service.
- `const MAX_INTERACTION_CALLDATA_HEX_LENGTH = 2 + MAX_INTERACTION_CALLDATA_BYTES * 2` — max `data` string length (0x prefix + hex bytes).
- `class InteractionDto` — per-call descriptor:
  - `to: string` — `Matches(/^0x[0-9a-fA-F]{40}$/)` valid Ethereum address.
  - `data: string` — byte-aligned hex `Matches(/^0x(?:[0-9a-fA-F]{2})*$/)`, max `MAX_INTERACTION_CALLDATA_HEX_LENGTH`.
  - `value?: string` — optional wei as decimal string `Matches(/^\d+$/)`, `MaxLength(78)` (max uint256).
- `class SendTransactionDto`:
  - `executionMode?: ExecutionMode` — optional, `IsIn(['session_key', 'eoa'])`.
  - `sponsorship?: SponsorshipMode` — optional, `IsIn(['required', 'none'])`.
  - `chainId: number` — required, `IsInt`, `Min(1)`.
  - `interactions: InteractionDto[]` — required, `ArrayMinSize(1)`, `ArrayMaxSize(MAX_TRANSACTION_INTERACTIONS)`, nested-validated.
  - `idempotencyKey: string` — required, `MaxLength(64)`, `Matches(/^[a-zA-Z0-9_-]+$/)`; prevents duplicate submissions.

### list-transactions-query.dto.ts
- Module-private `const VALID_STATUSES = ['submitting', 'pending', 'confirmed', 'failed', 'unknown'] as const` — allowed status filter values.
- `class ListTransactionsQueryDto`:
  - `status?: string` — optional, `IsString`, `IsIn(VALID_STATUSES)`.
  - `chainId?: number` — optional, `IsInt`, `Min(1)`, `IsIn(SUPPORTED_CHAIN_IDS)`, coerced via `@Type(() => Number)`.
  - `page?: number = 1` — optional, `IsInt`, `Min(1)`, coerced.
  - `limit?: number = 20` — optional, `IsInt`, `Min(1)`, `Max(100)`, coerced.

## Flow
- `POST /v1/transactions/send`: `@Body() dto: SendTransactionDto` → global ValidationPipe whitelists/transforms/validates → `TransactionsService.send(userId, dto, req.apiKeyRecord)`. Policy service additionally re-checks interaction count and calldata bytes against the DTO-exported constants before wallet/Openfort work.
- `GET /v1/transactions`: `@Query() query: ListTransactionsQueryDto` → strings coerced to numbers where typed → `TransactionsService.list(userId, query)` for filtering + pagination.
- Invalid fields are rejected at the pipe boundary before any service or guard-side business logic runs (except guards, which run before pipes).

## Integration
- `transactions.controller.ts` imports both DTO classes; `send` is public API-key route (`ApiKeyAuthGuard` + `ApiKeyPermissionGuard`, `canSendTransaction`, throttled 5/60s + 20/3600s), `list` is dashboard-only (`OpenfortUserGuard` + `FrontendOnlyGuard`, throttled 20/60s + 100/3600s).
- `transactions.service.ts` imports types `ExecutionMode`, `SendTransactionDto`, `ListTransactionsQueryDto`; uses `SendTransactionDto['interactions']` / `['sponsorship']` index types and `resolveExecutionMode(dto.executionMode)`.
- `transaction-policy.service.ts` imports `MAX_INTERACTION_CALLDATA_BYTES`, `MAX_TRANSACTION_INTERACTIONS`, and types `ExecutionMode`, `SendTransactionDto`; `assertAllowed(dto, context)` validates against the DTO limits.
- `transaction-simulation.service.ts` imports types `ExecutionMode`, `SendTransactionDto` for simulation input typing.
- `list-transactions-query.dto.ts` depends on `SUPPORTED_CHAIN_IDS` from `../../../common/chains/supported-chains`.
- Validation rule consistency is enforced by specs (`send-transaction.dto.spec.ts`) rather than duplicated runtime checks.

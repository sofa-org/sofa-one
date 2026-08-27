# Code Map for /src/modules/transactions

## Responsibility
Public transaction submission and status API for Openfort-backed sends, plus dashboard-only transaction history. The module owns the full send pipeline: API-key permission enforcement, execution-mode strategy selection, pre-wallet policy checks, risk evaluation, wallet readiness, idempotency, provider simulation preflight, Openfort submission, and safe response shaping. Dedicated `TransactionPolicyService` and `TransactionSimulationService` isolate the high-risk calldata/approval rules and the minimal provider preflight respectively.

## Files
- `transactions.controller.ts` — route wiring: guards, throttles, DTO binding, and delegation to the service.
- `transactions.service.ts` — orchestration of the send pipeline, list/detail/status reads, idempotency, and response shaping.
- `transaction-policy.service.ts` — pre-wallet risk policy: interaction/calldata limits, native value, Permit/approval selectors, allowlists, spend limits.
- `transaction-simulation.service.ts` — per-interaction `eth_call` preflight via a cached viem public client.
- `transactions.module.ts` — module composition (imports `SecurityEventModule`, `EoaExecutionModule`, `SessionKeyModule`, `BillingModule`).
- `dto/` — request/query validation DTOs; see `dto/codemap.md` (not modified here).

## Design/Patterns

### Access-control split
- `POST /v1/transactions/send` and `GET /v1/transactions/:id` are public API-key routes: `ApiKeyAuthGuard` (resolves the API key, rejects frozen users/keys) + `ApiKeyPermissionGuard` with `canSendTransaction` / `canReadTransactionStatus`. The service re-asserts the permission from `req.apiKeyRecord` so it never trusts the guard alone.
- `GET /v1/transactions` and `GET /v1/transactions/:id/detail` are dashboard-only: `OpenfortUserGuard` + `FrontendOnlyGuard` (origin/referer allowlist). These routes are intentionally omitted from `openapi.yaml`.
- Route-level throttling: send is tight (5/60s + 20/3600s); read routes are 20/60s + 100/3600s.

### Execution-mode strategy
- `executionMode` (`'session_key'` default | `'eoa'`) selects the submission strategy via `resolveExecutionMode` and `submitTransaction`:
  - `session_key` — Calibur agent UserOperation submitted through the Openfort bundler (`openfort.sendUserOperation`), with optional `sponsorship` (`'required' | 'none'`, default `'none'`).
  - `eoa` — backend EOA direct send (`openfort.sendBackendTransaction`), gated by `EoaExecutionPolicyService` (global opt-in, short API-key TTL, IP allowlist, per-key rate limit) and audited as a privileged security warning.
- `session_key` additionally requires a registered, non-expired chain authorization (`AgentStatus.Registered`) and a `SessionKeyPolicyService.assertSessionKeyAllowed` check; `eoa` requires the agent backend wallet fields.

### Optional dependency injection
- `EoaExecutionPolicyService`, `TransactionSimulationService`, `RiskEvaluationService`, `SessionKeyPolicyService`, and `RequestContextService` are injected with `@Optional()`. The service degrades gracefully (e.g., simulation unavailable → 400 "not available"; missing risk evaluator → skip) rather than failing at construction.

### Policy service (strategy)
- `TransactionPolicyService.assertAllowed(dto, context)` runs before wallet lookup, idempotency persistence, or Openfort calls. Checks: interaction count (`MAX_TRANSACTION_INTERACTIONS`), per-interaction and aggregate calldata bytes (64 KB caps), distinct-target fanout (max 5), native value (must be zero), malformed/short calldata, blocked Permit/Permit2 selectors, infinite ERC20 approvals, NFT `setApprovalForAll`, API-key contract/selector allowlists, and cumulative daily/monthly spend limits (sum of past `submitting|pending|confirmed|unknown` transaction values + current value).
- Denies throw `BadRequestException` and write `transaction.policy_denied` `SecurityEvent` rows (risk `high`); passes write `transaction.policy_allowed` (risk `low`). Metadata is safe-only (counts, lengths, selectors, prefixes) — never full calldata.

### Simulation service
- `TransactionSimulationService.assertSimulatable` performs a minimal viem `eth_call` per interaction from the resolved transaction wallet address. Multi-interaction batches are deferred to the bundler (`batch_simulation_deferred_to_bundler`) rather than simulated. Pass/fail is recorded as `transaction.simulation_allowed` / `transaction.simulation_denied` `SecurityEvent` rows with safe metadata only; failures surface a generic 400.

### Idempotency
- Idempotency is keyed on `[userId, operationType, chainId, idempotencyKey]` (DB unique constraint) plus a `requestHash` = SHA-256 of a stable-serialized request (`operationType`, `chainId`, `executionMode`, optional `sponsorship`, `interactions`) via `hashRequest`.
- Same key + same hash → return the existing transaction response (no resubmission). Same key + different hash → 400 "Idempotency key was already used for a different request".
- Race handling: `createPendingOrReturnExisting` catches Prisma `P2002` and re-fetches the existing row; if the row already has a `txHash` or is not `submitting`, the existing response is returned instead of resubmitting.

### State machine
- `Transaction.status`: `submitting` (row created, submission in flight) → `confirmed` (Openfort returned a `transactionHash`) | `pending` (UserOperation accepted, only `userOpHash` so far) | `failed` (submission threw; `failureReason` is sanitized via `sanitizeErrorMessage`). `unknown` is a valid stored/filter value for spend-limit accounting.
- Wallet gates: wallet must exist, not be frozen (`frozenAt` → `ForbiddenException`), and be `active` with the required addresses/agent fields for the chosen mode.
- Response shaping is explicit and safe: `toSendResponse`, `toStatusResponse`, `toListItemResponse`, `toDashboardDetailResponse` never expose calldata, `requestHash`, or `interactionsHash`; `failureReason` is reduced to a boolean-safe `'Transaction failed'` string in list/status/detail responses.

## Flow

### Send (`POST /v1/transactions/send`)
1. Guards resolve the API key and require `canSendTransaction`; throttle applies; `req.apiKeyRecord` is passed to the service.
2. Service asserts the API key record and permission, validates `chainId` via `getSupportedChain`, and resolves `executionMode` (default `session_key`).
3. `eoa` mode: assert `canUseEoaExecution`, run `EoaExecutionPolicyService.assertAllowed` (IP allowlist from `request.ip` via `RequestContextService`, TTL, rate limit), and log a privileged security warning.
4. `TransactionPolicyService.assertAllowed` runs policy checks (denies → `SecurityEvent` + 400).
5. `RiskEvaluationService.evaluateRisk` runs; non-`allow` results are enforced via `enforceRiskAction`.
6. Load `UserWallet` with `chainAuthorizations` for the chain; 404 if missing; reject frozen/inactive wallets.
7. `session_key`: `assertAgentWalletReady` (agent account/address/key hash + registered non-expired chain authorization) then `SessionKeyPolicyService.assertSessionKeyAllowed`. `eoa`: `assertBackendWalletReady`. The transaction wallet address is `agentWalletAddress` for `eoa`, else the user `walletAddress`.
8. Compute `requestHash`; `findExistingTransactionRequest` returns the existing response on match or 400 on hash mismatch.
9. `TransactionSimulationService.assertSimulatable` preflights each interaction (batch deferred to bundler).
10. `createPendingOrReturnExisting` inserts a `Transaction` row (`status: 'submitting'`, `authMethod: 'api_key'`, API-key attribution snapshot, `requestHash`, safe `details` JSON) or returns the existing row on `P2002`.
11. `submitTransaction` dispatches by mode to `openfort.sendUserOperation` (session_key, with sponsorship) or `openfort.sendBackendTransaction` (eoa).
12. On success the row is updated to `confirmed` (with `txHash`) or `pending` (with `userOpHash` in `details`); response is `{ transactionId, transactionHash, status }`.
13. On failure the row is updated to `failed` with a sanitized `failureReason` and the error is rethrown.

### Reads
- `GET /v1/transactions` (dashboard): filter by `status`/`chainId`, paginate (`page`/`limit`, default 1/20, max 100), order by `createdAt desc`; returns `{ items, total, page, limit }` with safe list items.
- `GET /v1/transactions/:id/detail` (dashboard): ownership-enforced `findFirst({ id, userId })`; safe detail view including withdrawal `to`/`amount`/`token` for `operationType === 'withdraw'`.
- `GET /v1/transactions/:id` (public API key): requires `canReadTransactionStatus`; scoped to `operationType: 'send'` and `authMethod: 'api_key'`; returns safe status fields only.

## Integration
- **Guards/decorators**: `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `RequireApiKeyPermission`, `OpenfortUserGuard`, `FrontendOnlyGuard`, `FrontendOnly`, `CurrentUser` from `src/common`.
- **Services**: `PrismaService` (Transaction/UserWallet reads and writes), `OpenfortService` (`sendUserOperation`, `sendBackendTransaction`), `RequestContextService` (client IP + log context), `EoaExecutionPolicyService`, `SessionKeyPolicyService`, `RiskEvaluationService`, `SecurityEventService` (via policy/simulation services).
- **Modules**: `SecurityEventModule`, `EoaExecutionModule`, `SessionKeyModule`, `BillingModule` (module-level import; the send pipeline itself does not call billing services directly).
- **Common utils**: `getSupportedChain` (`src/common/chains/supported-chains`), `hashRequest` (`src/common/utils/request-hash`), `sanitizeErrorMessage` (`src/common/utils/sanitize`), `AgentStatus` (`src/common/agent/agent-status`).
- **DTOs**: `SendTransactionDto` / `InteractionDto` (shared constants `MAX_TRANSACTION_INTERACTIONS`, `MAX_INTERACTION_CALLDATA_BYTES` consumed by the policy service) and `ListTransactionsQueryDto`; see `dto/codemap.md`.
- **Data model**: Prisma `Transaction` (`transactions` table) with `@@unique([userId, operationType, chainId, idempotencyKey])` and indexes on `[apiKeyId, createdAt]`, `[requestHash]`, `[userId, createdAt]`, `[userId, status]`; `details` JSON holds safe send metadata (execution mode, sponsorship, interaction count, agent wallet/key hash, `userOpHash`).
- **Security-event contract**: policy and simulation services emit `transaction.policy_allowed|denied` and `transaction.simulation_allowed|denied` rows with safe metadata only; the service logs privileged EOA sends as security warnings.
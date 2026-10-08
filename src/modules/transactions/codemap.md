# Code Map for /src/modules/transactions

## Responsibility
Public transaction submission and status API for Openfort-backed sends, plus dashboard-only transaction history. The module owns the full send pipeline: API-key permission enforcement, execution-mode strategy selection, generic transaction limits, risk evaluation, wallet readiness, idempotency, destination and billing gates, provider simulation preflight, Openfort submission, and safe response shaping. `TransactionPolicyService` enforces generic structural constraints, configured API-key spend budgets, and Permit/NFT restrictions; function authority belongs to the DeFi catalog.

## Files
- `transactions.controller.ts` — route wiring: guards, throttles, DTO binding, and delegation to the service.
- `transactions.service.ts` — orchestration of the send pipeline, list/detail/status reads, idempotency, and response shaping. DeFi authorization snapshots exact interactions and is rechecked at acceptance for current catalog/grant/pause state; it does not capture or recheck DeFi-specific source/runtime/financial evidence. Separate debt-aware billing asset-flow checks may perform their own simulation/evidence verification.
- `transaction-policy.service.ts` — generic pre-wallet policy: interaction/calldata/target limits, user-configured API-key daily/monthly value budgets, and Permit/Permit2/NFT operator restrictions. Payable native value and cataloged ERC-20 approvals are not blanket-denied here. Contract/function authorization belongs exclusively to `DefiPolicyService`.
- `transaction-simulation.service.ts` — per-interaction `eth_call` preflight via a cached viem public client; plus separate debt-gated asset-flow evidence simulation (explicit per-chain HTTPS `rpcUrl`, never default public `http()`).
- `transaction-asset-flow.policy.ts` — static batch asset-flow classifier used by the independent billing-debt gate and destination analysis; it is not a DeFi catalog grant or financial policy.
- `direct-transfer-intents.ts` — strict ERC-20-shaped `transfer` / owner-sourced `transferFrom` destination extraction for BILL-016 allowlist/cooldown; also reports `fullyProvenDirectEgress` + per-interaction `notProven` reasons (empty/unknown/self/non-owner) so destination protection can fail closed without a generic calldata decoder (not an asset-flow classifier).
- `asset-flow-rules/weth-addresses.ts` — chain-scoped official wrapped-native addresses (`SUPPORTED_CHAINS_WETH`).
- `asset-flow-rules/trusted-spenders.ts` — chain-scoped revoke-only spender/operator allowlist (`TRUSTED_SPENDERS`; Aave pools + Uni routers).
- `asset-flow-rules/erc4626-vaults.ts` — chain-scoped ERC-4626 vault allowlist (`ERC4626_VAULTS`).
- `transaction-asset-flow.verifier.ts` — pure fail-closed verifier for billing-debt asset-flow simulation evidence.
- `transactions.module.ts` — module composition (imports `DefiModule`, `SecurityEventModule`, `EoaExecutionModule`, `SessionKeyModule`, `BillingModule`).
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
- `TransactionPolicyService.assertAllowed(dto, context)` runs before wallet lookup, idempotency persistence, or Openfort calls. It enforces interaction count (`MAX_TRANSACTION_INTERACTIONS`), per-interaction/aggregate calldata bytes (64 KB caps), distinct-target fanout (max 5), generic calldata shape, blocked Permit/Permit2 selectors, NFT `setApprovalForAll(true)`, and configured daily/monthly API-key spend budgets. Payable native value is not categorically zeroed; it remains subject to those user-configured budgets and other gates. There is no generic infinite-ERC20-approval ban. This service does not authorize contract/functions; `DefiPolicyService` owns catalog authority.
- **DeFi authorization**: after an outer idempotency miss, `DefiPolicyService` checks chain → contract → exact catalog function and API-key grant → canonical ABI decode/re-encode. Caller-chosen ABI arguments are not subjected to former DeFi-specific financial validators. Grants do not override pause. Denials are safely audited before destination, billing, simulation, new `Transaction` creation, and Openfort. The final create transaction rechecks current authorization under destination → pause `FOR SHARE` → API key `FOR UPDATE` locks at READ COMMITTED; this checks live grants/catalog/pause and call binding, not DeFi evidence. No network work runs under these locks.
- Denies throw `BadRequestException` and write `transaction.policy_denied` `SecurityEvent` rows (risk `high`); passes write `transaction.policy_allowed` (risk `low`). Metadata is safe-only (counts, lengths, selectors, prefixes) — never full calldata.

### Simulation service
- `TransactionSimulationService.assertSimulatable` performs a minimal viem `eth_call` per interaction from the resolved transaction wallet address. Multi-interaction batches are deferred to the bundler (`batch_simulation_deferred_to_bundler`) rather than simulated. Pass/fail is recorded as `transaction.simulation_allowed` / `transaction.simulation_denied` `SecurityEvent` rows with safe metadata only; failures surface a generic 400.

### Idempotency
- Idempotency is keyed on `[userId, operationType, chainId, idempotencyKey]` (DB unique constraint) plus a `requestHash` = SHA-256 of a stable-serialized request (`operationType`, `chainId`, `executionMode`, optional `sponsorship`, `interactions`) via `hashRequest`.
- Same key + same hash → return the existing transaction response (no resubmission). Same key + different hash → 400 "Idempotency key was already used for a different request".
- Race handling: `createPendingOrReturnExisting` catches Prisma `P2002` after the interactive transaction has rolled back, then re-fetches the existing row through the root Prisma client (never the aborted transaction client); if the row already has a `txHash` or is not `submitting`, the existing response is returned instead of resubmitting.

### Billing outbound / asset-flow gate (independent debt-aware policy)
- Static classification: `transaction-asset-flow.policy.ts` classifies the **full** ordered interaction batch with the trusted execution owner (`walletAddress` for `session_key`, `agentWalletAddress` for `eoa`). This is an independent billing-debt control, not a capability grant or a hidden set of DeFi caller-argument rules. Protocol brand alone is not a debt-period exemption.
- **Outer gate** (`evaluateOuterBillingAssetFlowGate`, outside any DB transaction; skipped on idempotent hits):
  - No finalized unpaid invoice → returns `null` bound proof; existing send path unchanged (no evidence RPC).
  - Debt + static `external_transfer` → `BILLING_OUTBOUND_BLOCKED` (no simulation).
  - Debt + retained/unknown → `TransactionSimulationService.simulateAssetFlowEvidence` with explicit `simulation.rpcUrls.<chainId>` HTTPS RPC, then `verifyTransactionAssetFlow`. The independent debt gate requires `status === 'verified'`, `simulationMode === 'calibur_atomic'`, and complete matching evidence binding; unavailable/non-atomic/unverified evidence fails closed (`BILLING_ASSET_FLOW_UNVERIFIABLE`). This billing-debt rule is not a per-capability DeFi admission or financial validator.
  - Debt-query failure → `BILLING_DEBT_CHECK_UNAVAILABLE` (fail-closed).
  - **Inner gate** (`assertInnerBillingAssetFlowGate`, inside the create interactive transaction only): rechecks debt via the tx client (**no** RPC/simulation). When debt is present, it requires the outer billing-gate verification to match the request context. A later invoice does not revoke an already-committed row.
- Evidence primitives live in `transaction-asset-flow.verifier.ts` and `transaction-simulation.service.ts` (explicit rpcUrl; never default public `http()`).

### State machine
- `Transaction.status`: `submitting` (row created, submission in flight) → `confirmed` (Openfort returned a `transactionHash`) | `pending` (UserOperation accepted, only `userOpHash` so far) | `failed` (submission threw; `failureReason` is sanitized via `sanitizeErrorMessage`). `unknown` is a valid stored/filter value for spend-limit accounting.
- Wallet gates: wallet must exist, not be frozen (`frozenAt` → `ForbiddenException`), and be `active` with the required addresses/agent fields for the chosen mode.
- Response shaping is explicit and safe: `toSendResponse`, `toStatusResponse`, `toListItemResponse`, `toDashboardDetailResponse` never expose calldata, `requestHash`, or `interactionsHash`; `failureReason` is reduced to a boolean-safe `'Transaction failed'` string in list/status/detail responses.

## Flow

### Send (`POST /v1/transactions/send`)
1. Guards resolve the API key and require `canSendTransaction`; throttle applies; `req.apiKeyRecord` is passed to the service.
2. Service asserts the API key record and permission, validates `chainId` via `getSupportedChain`, and resolves `executionMode` (default `session_key`).
3. `eoa` mode: assert `canUseEoaExecution`, run `EoaExecutionPolicyService.assertAllowed` (IP allowlist from `request.ip` via `RequestContextService`, TTL, rate limit), and log a privileged security warning.
4. `TransactionPolicyService.assertAllowed` runs generic checks (calldata shape/size, Permit/NFT restrictions, configured API-key spend budgets and structural limits). Payable value and cataloged approvals are caller-controlled subject to independent controls. Contract/selector authorization is not duplicated here.
5. `RiskEvaluationService.evaluateRisk` runs; non-`allow` results are enforced via `enforceRiskAction`.
6. Load `UserWallet` with `chainAuthorizations` for the chain; 404 if missing; reject frozen/inactive wallets.
7. `session_key`: `assertAgentWalletReady` (agent account/address/key hash + registered non-expired chain authorization) then `SessionKeyPolicyService.assertSessionKeyAllowed`. `eoa`: `assertBackendWalletReady`. The transaction wallet address is `agentWalletAddress` for `eoa`, else the user `walletAddress`.
8. Compute `requestHash`; `findExistingTransactionRequest` returns the existing response on match or 400 on hash mismatch. A hit skips DeFi authorization and all new-request gates.
9. After idempotency miss and wallet readiness, `DefiPolicyService.authorizeContractCalls` authorizes every interaction against exact catalog functions using current API-key `capabilityMode` (`all` or custom ID membership), plus active/unpaused and ABI checks. It validates the fixed ABI, not DeFi financial templates or per-request source/runtime evidence. Denials are audited without masking the denial. This precedes destination, billing, simulation, and create.
10. **BILL-016 destination gate** (new requests only): `extractDirectTransferIntents` (strict layout; malformed → 400). When `WithdrawalPolicy.requireAddressAllowlist === true` (destination protection): the full batch must be `fullyProvenDirectEgress` (every interaction a non-self owner-sourced `transfer`/`transferFrom`); otherwise **`UNPROVEN_ASSET_OUTFLOW_BLOCKED`** (403) — approvals, routers/multicall/execute, unknown selectors, empty calldata, mixed unproven interactions, self/non-owner transferFrom fail closed with **no Transaction create and no broadcast**. `intents.length === 0` is never treated as safe under protection. Proven destinations still require API-key direct-egress reauth + `WithdrawalDestinationPolicyService.assertDestinationsAllowed`. When protection is **off**, legacy semantics remain: only proven external destinations are allowlist-checked; unproven interactions are not blocked here. Dedicated withdraw/payment paths are out of scope for this gate.
11. **Outer billing asset-flow gate** (new requests only): classify full batch → `evaluateOuterBillingAssetFlowGate` applies its independent billing-debt policy and may run evidence simulation + verifier (or throw `BILLING_*` as above).
12. `TransactionSimulationService.assertSimulatable` preflights each interaction (batch deferred to bundler). This is separate from debt-gate evidence simulation.
13. `createPendingOrReturnExisting`:
       - Interactive `$transaction`: inner idempotency lookup → destination advisory lock and live destination gates → `DefiPolicyService.assertStillAuthorized` (destination, pause `FOR SHARE`, API-key `FOR UPDATE`; current grants, key, catalog identity, pause and call binding; READ COMMITTED) → defer allowed security event to transaction; recheck billing with no RPC → insert. No DeFi evidence/freshness recheck occurs here. DeFi denials are recorded only after rollback; committed allowed events are exported only after commit.
    - On unique-key race **`P2002`**, the interactive transaction aborts; recovery **re-reads the existing row on the root `PrismaService` client** (never the aborted tx client), then returns that row if `requestHash` matches. Deferred destination denials are audited on the root client after rollback.
14. `submitTransaction` dispatches by mode to `openfort.sendUserOperation` (session_key, with optional configured sponsorship) or `openfort.sendBackendTransaction` (eoa), after ordinary authorization, destination, billing, and simulation gates. There is no DeFi-specific provider evidence/freshness wrapper. Generic session readiness and EOA isolation remain in force.
15. On success the row is updated to `confirmed` (with `txHash`) or `pending` (with `userOpHash` in `details`); response is `{ transactionId, transactionHash, status }`.
16. On failure the row is updated to `failed` with a sanitized `failureReason` and the error is rethrown.

### Reads
- `GET /v1/transactions` (dashboard): filter by `status`/`chainId`, paginate (`page`/`limit`, default 1/20, max 100), order by `createdAt desc`; returns `{ items, total, page, limit }` with safe list items.
- `GET /v1/transactions/:id/detail` (dashboard): ownership-enforced `findFirst({ id, userId })`; safe detail view including withdrawal `to`/`amount`/`token` for `operationType === 'withdraw'`.
- `GET /v1/transactions/:id` (public API key): requires `canReadTransactionStatus`; scoped to `operationType: 'send'` and `authMethod: 'api_key'`; returns safe status fields only.

## Integration
- **Guards/decorators**: `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `RequireApiKeyPermission`, `OpenfortUserGuard`, `FrontendOnlyGuard`, `FrontendOnly`, `CurrentUser` from `src/common`.
- **Services**: `PrismaService` (Transaction/UserWallet reads and writes), `OpenfortService` (`sendUserOperation`, `sendBackendTransaction`), `RequestContextService` (client IP + log context), `EoaExecutionPolicyService`, `SessionKeyPolicyService`, `RiskEvaluationService`, `SecurityEventService` (via policy/simulation services).
- **Modules**: `DefiModule` (leaf catalog/grant/pause authorization), `SecurityEventModule`, `EoaExecutionModule`, `SessionKeyModule`, `BillingModule` (debt snapshot via billing debt helper on the send path; Stripe/USDC settlement remains outside this module), `WithdrawalDestinationModule` (destination/cooldown leaf for API-key direct egress; no WalletModule cycle). Protection enablement (`WithdrawalPolicy.requireAddressAllowlist`) is read in this module for the BILL-016 conservative gate; dedicated withdraw/payment paths stay outside generic-send capability authorization.
- **Common utils**: `getSupportedChain` (`src/common/chains/supported-chains`), `hashRequest` (`src/common/utils/request-hash`), `sanitizeErrorMessage` (`src/common/utils/sanitize`), `AgentStatus` (`src/common/agent/agent-status`).
- **DTOs**: `SendTransactionDto` / `InteractionDto` (shared constants `MAX_TRANSACTION_INTERACTIONS`, `MAX_INTERACTION_CALLDATA_BYTES` consumed by the policy service) and `ListTransactionsQueryDto`; see `dto/codemap.md`.
- **Data model**: Prisma `Transaction` (`transactions` table) with `@@unique([userId, operationType, chainId, idempotencyKey])` and indexes on `[apiKeyId, createdAt]`, `[requestHash]`, `[userId, createdAt]`, `[userId, status]`; `details` JSON holds safe send metadata (execution mode, sponsorship, interaction count, agent wallet/key hash, `userOpHash`).
- **Security-event contract**: policy and simulation services emit `transaction.policy_allowed|denied` and `transaction.simulation_allowed|denied` rows with safe metadata only; the service logs privileged EOA sends as security warnings.

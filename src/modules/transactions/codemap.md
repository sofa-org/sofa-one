# Code Map for /src/modules/transactions

## Responsibility
Public Calibur UserOperation submission and status API, plus dashboard-only transaction history. The module owns the full send pipeline: API-key permissions, session-key readiness, generic transaction limits, risk evaluation, wallet readiness, idempotency, destination and billing gates, provider simulation preflight, Openfort submission, and safe response shaping. `TransactionPolicyService` enforces generic structural constraints, configured API-key spend budgets, and Permit/NFT restrictions; function authority belongs to the DeFi catalog.

## Files
- `transactions.controller.ts` — separate API-key `TransactionsController` send/status from IAM `DashboardTransactionsController` history/detail under `/transactions`; public send is canonical `POST /v1/transactions` only.
- `transactions.service.ts` — orchestration of the send pipeline, list/detail/status reads, idempotency, and response shaping. DeFi authorization snapshots exact interactions and is rechecked at acceptance for current catalog/grant/pause state; it does not capture or recheck DeFi-specific source/runtime/financial evidence. Separate debt-aware billing asset-flow checks may perform their own simulation/evidence verification.
- `transaction-policy.service.ts` — generic pre-wallet policy: interaction/calldata/target limits, user-configured API-key daily/monthly value budgets, and Permit/Permit2/NFT operator restrictions. Payable native value and cataloged ERC-20 approvals are not blanket-denied here. Contract/function authorization belongs exclusively to `DefiPolicyService`.
- `transaction-simulation.service.ts` — per-interaction `eth_call` preflight via a cached viem public client; plus separate debt-gated asset-flow evidence simulation (explicit per-chain HTTPS `rpcUrl`, never default public `http()`).
- `transaction-asset-flow.policy.ts` — static batch asset-flow classifier used by the independent billing-debt gate and destination analysis; it is not a DeFi catalog grant or financial policy.
- `direct-transfer-intents.ts` — strict ERC-20-shaped `transfer` / owner-sourced `transferFrom` destination extraction for BILL-016 allowlist/cooldown; also reports `fullyProvenDirectEgress` + per-interaction `notProven` reasons (empty/unknown/self/non-owner) so destination protection can fail closed without a generic calldata decoder (not an asset-flow classifier).
- `asset-flow-rules/weth-addresses.ts` — chain-scoped official wrapped-native addresses (`SUPPORTED_CHAINS_WETH`).
- `asset-flow-rules/trusted-spenders.ts` — chain-scoped revoke-only spender/operator allowlist (`TRUSTED_SPENDERS`; Aave pools + Uni routers).
- `asset-flow-rules/erc4626-vaults.ts` — chain-scoped ERC-4626 vault allowlist (`ERC4626_VAULTS`).
- `transaction-asset-flow.verifier.ts` — pure fail-closed verifier for billing-debt asset-flow simulation evidence.
- `transactions.module.ts` — module composition (imports `DefiModule`, `SecurityEventModule`, `SessionKeyModule`, `BillingModule`; no EOA execution-policy dependency).
- `dto/` — request/query validation DTOs; see `dto/codemap.md`.

## Design/Patterns

### Access-control split
- API-key send and public status are scoped to the authenticated key's bound wallet; explicit send wallet selectors may only repeat that binding. Idempotency and legacy attribution must prove that same wallet before returning an existing row.
- `POST /v1/transactions` and `GET /v1/transactions/:id` are public API-key routes: `ApiKeyAuthGuard` (resolves the API key, rejects frozen users/keys) + `ApiKeyPermissionGuard` with `canSendTransaction` / `canReadTransactionStatus`. The service re-asserts the permission from `req.apiKeyRecord` so it never trusts the guard alone.
- Dashboard transaction history/detail uses AppSessionGuard + FrontendOnlyGuard (full local cookie/MFA), intentionally omitted from public OpenAPI.
- Route-level throttling: send is tight (5/60s + 20/3600s); read routes are 20/60s + 100/3600s.

### Session-key execution only
- Transaction `executionMode` may be omitted (defaults to `'session_key'`) or explicitly `'session_key'`. DTO validation and the service boundary reject `'eoa'`, unknown modes, and null with HTTP 400 before policy/database/provider actions. `canUseEoaExecution` grants no transaction submission authority; off-chain signing has its own independent DTO and policy.
- Every new send executes as `UserWallet.walletAddress` through a Calibur agent UserOperation (`OpenfortService.submitUserOperation`), with optional `sponsorship` (`'required' | 'none'`, default `'none'`).
- The wallet must have agent account/signer/key-hash fields and a registered, non-expired chain authorization (`AgentStatus.Registered`), and pass `SessionKeyPolicyService.assertSessionKeyAllowed`.

### Required security dependencies
- `TransactionSimulationService`, `RiskEvaluationService`, `SessionKeyPolicyService`, and `RequestContextService` are required constructor dependencies. Missing wiring fails Nest startup rather than skipping security gates; tests supply explicit policy fixtures.

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
- Static classification: `transaction-asset-flow.policy.ts` classifies the **full** ordered interaction batch with the trusted execution owner `UserWallet.walletAddress`. Evidence simulation and verification accept only `session_key`; historical EOA status/ownership reads remain independent of these new-request types. This is an independent billing-debt control, not a capability grant or a hidden set of DeFi caller-argument rules.
- **Outer gate** (`evaluateOuterBillingAssetFlowGate`, outside any DB transaction; skipped on idempotent hits):
  - No finalized unpaid invoice → returns `null` bound proof; existing send path unchanged (no evidence RPC).
  - Debt + static `external_transfer` → `BILLING_OUTBOUND_BLOCKED` (no simulation).
  - Debt + retained/unknown → `TransactionSimulationService.simulateAssetFlowEvidence` with explicit shared `rpc.urls.<chainId>` HTTPS RPC, then `verifyTransactionAssetFlow`. The independent debt gate requires `status === 'verified'`, `simulationMode === 'calibur_atomic'`, and complete matching evidence binding; unavailable/non-atomic/unverified evidence fails closed (`BILLING_ASSET_FLOW_UNVERIFIABLE`). This billing-debt rule is not a per-capability DeFi admission or financial validator.
  - Debt-query failure → `BILLING_DEBT_CHECK_UNAVAILABLE` (fail-closed).
  - **Inner gate** (`assertInnerBillingAssetFlowGate`, inside the create interactive transaction only): rechecks debt via the tx client (**no** RPC/simulation). When debt is present, it requires the outer billing-gate verification to match the request context. A later invoice does not revoke an already-committed row.
- Evidence primitives live in `transaction-asset-flow.verifier.ts` and `transaction-simulation.service.ts` (explicit rpcUrl; never default public `http()`).

### State machine
- `Transaction.status`: `submitting` → `confirmed` (hash + successful receipt) | `pending` (known UserOperation identity) | `unknown` (timeout, known broadcast followed by persistence/receipt error) | `failed` (definitive rejection without known identity). UserOperation hashes are CAS-persisted as soon as observed and before waiting for inclusion; late callbacks may restore unknown to pending without resubmission. Callback/final persistence failures never turn known identities into definitive failures; completion/error CAS cannot overwrite reconciled outcomes. Historical EOA rows remain readable and reconcilable without new EOA submission support.
- Wallet gates: wallet must exist, not be frozen (`frozenAt` → `ForbiddenException`), and be active with the registered/unexpired Calibur session-key prerequisites.
- Response shaping is explicit and safe: `toSendResponse`, `toStatusResponse`, `toListItemResponse`, `toDashboardDetailResponse` never expose calldata, `requestHash`, or `interactionsHash`; `failureReason` is reduced to a boolean-safe `'Transaction failed'` string in list/status/detail responses.

## Flow

### Send (`POST /v1/transactions`)
1. Guards resolve the API key and require `canSendTransaction`; throttle applies; `req.apiKeyRecord` is passed to the service.
2. Service asserts the API-key record, send permission and wallet binding, validates `chainId`, and accepts only omitted or explicit `session_key` mode. Unsupported modes are 400, never silently converted.
3. No backend signer EOA send path exists; independent off-chain signature policy remains outside this module.
4. `TransactionPolicyService.assertAllowed` runs generic checks (calldata shape/size, Permit/NFT restrictions, configured API-key spend budgets and structural limits). Payable value and cataloged approvals are caller-controlled subject to independent controls. Contract/selector authorization is not duplicated here.
5. `RiskEvaluationService.evaluateRisk` runs; non-`allow` results are enforced via `enforceRiskAction`.
6. Load the API key's bound `UserWallet` directly by `{ id, userId }` with chain-filtered `chainAuthorizations`; 404 if missing; reject frozen/inactive wallets. This does not enumerate other wallets or change final transactional authorization rechecks.
7. `assertAgentWalletReady` requires agent account/signer/key hash and registered non-expired chain authorization, then `SessionKeyPolicyService.assertSessionKeyAllowed` enforces on-chain session-key controls. Execution, simulation, destination and asset-flow owner are always `walletAddress`; `details.signerAddress` remains attribution metadata.
8. Compute `requestHash`; `findExistingTransactionRequest` returns an existing response only when wallet attribution, explicit session-key mode and current or persisted legacy fingerprint match. Historical EOA rows cannot be mistaken for new session-key requests. Hits skip DeFi authorization and all new-request gates.
9. After idempotency miss and wallet readiness, `DefiPolicyService.authorizeContractCalls` authorizes every interaction against exact catalog functions using current API-key `capabilityMode` (`all` or custom ID membership), plus active/unpaused and ABI checks. It validates the fixed ABI, not DeFi financial templates or per-request source/runtime evidence. Denials are audited without masking the denial. This precedes destination, billing, simulation, and create.
10. **BILL-016 destination gate** (new requests only): `extractDirectTransferIntents` (strict layout; malformed → 400). When `WithdrawalPolicy.requireAddressAllowlist === true` (destination protection): the full batch must be `fullyProvenDirectEgress` (every interaction a non-self owner-sourced `transfer`/`transferFrom`); otherwise **`UNPROVEN_ASSET_OUTFLOW_BLOCKED`** (403) — approvals, routers/multicall/execute, unknown selectors, empty calldata, mixed unproven interactions, self/non-owner transferFrom fail closed with **no Transaction create and no broadcast**. `intents.length === 0` is never treated as safe under protection. Proven destinations still require API-key direct-egress reauth + `WithdrawalDestinationPolicyService.assertDestinationsAllowed`. When protection is **off**, legacy semantics remain: only proven external destinations are allowlist-checked; unproven interactions are not blocked here. Dedicated withdraw/payment paths are out of scope for this gate.
11. **Outer billing asset-flow gate** (new requests only): classify full batch → `evaluateOuterBillingAssetFlowGate` applies its independent billing-debt policy and may run evidence simulation + verifier (or throw `BILLING_*` as above).
12. `TransactionSimulationService.assertSimulatable` preflights each interaction (batch deferred to bundler). This is separate from debt-gate evidence simulation.
13. `createPendingOrReturnExisting`:
       - Interactive `$transaction`: inner idempotency lookup → destination advisory lock and live destination gates → `DefiPolicyService.assertStillAuthorized` (destination, pause `FOR SHARE`, API-key `FOR UPDATE`; current grants, key, catalog identity, pause and call binding; READ COMMITTED) → defer allowed security event to transaction; recheck billing with no RPC → insert. No DeFi evidence/freshness recheck occurs here. DeFi denials are recorded only after rollback; committed allowed events are exported only after commit.
    - On unique-key race **`P2002`**, the interactive transaction aborts; recovery **re-reads the existing row on the root `PrismaService` client** (never the aborted tx client), then returns that row if `requestHash` matches. Deferred destination denials are audited on the root client after rollback.
14. `submitTransaction` invokes only `openfort.submitUserOperation`, after authorization, destination, billing, simulation and session-key gates. There is no DeFi-specific provider evidence/freshness wrapper.
15. UserOperation callbacks persist the identity immediately; the returned identity is saved again before waiting for inclusion. Late callbacks remain observed after request timeout. Ordinary receipt lookup does not use billing-specific confirmation thresholds.
16. 最终完成写入与错误写入均为 CAS，不覆盖已对账终态。已知任一 hash 时失败保留 hash + unknown，不记录确定失败；没有身份的超时保持 unknown（不编造恢复身份、不重播）。

### Reads
- `GET /transactions` (dashboard): filter by `status`/`chainId`, paginate (`page`/`limit`, default 1/20, max 100), order by `createdAt desc`; returns `{ items, total, page, limit }` with safe list items.
- `GET /transactions/:id/detail` (dashboard): ownership-enforced `findFirst({ id, userId })`; safe detail view including withdrawal `to`/`amount`/`token` for `operationType === 'withdraw'`.
- `GET /v1/transactions/:id` (public API key): requires `canReadTransactionStatus`; scoped to `operationType: 'send'` and `authMethod: 'api_key'`; returns safe status fields only.

## Integration
- **Guards**: ApiKeyAuthGuard/ApiKeyPermissionGuard for public automation; AppSessionGuard/FrontendOnlyGuard for dashboard history; CurrentUser derives the authenticated local owner.
- **Services**: `PrismaService` (Transaction/UserWallet reads and writes), `OpenfortService` (`submitUserOperation`, receipt readers), `RequestContextService` (log context), `SessionKeyPolicyService`, `RiskEvaluationService`, `SecurityEventService` (via policy/simulation services).
- **Modules**: `DefiModule` (leaf catalog/grant/pause authorization), `SecurityEventModule`, `SessionKeyModule`, `BillingModule` (debt snapshot on the send path; settlement stays outside this module), `WithdrawalDestinationModule` (destination/cooldown leaf; no WalletModule cycle). Destination protection reads remain here for the BILL-016 conservative gate.
- **Common utils**: `getSupportedChain` (`src/common/chains/supported-chains`), `hashRequest` (`src/common/utils/request-hash`), `sanitizeErrorMessage` (`src/common/utils/sanitize`), `AgentStatus` (`src/common/agent/agent-status`).
- **DTOs**: `SendTransactionDto` / `InteractionDto` (shared constants `MAX_TRANSACTION_INTERACTIONS`, `MAX_INTERACTION_CALLDATA_BYTES` consumed by the policy service) and `ListTransactionsQueryDto`; see `dto/codemap.md`.
- **Data model**: Prisma `Transaction` (`transactions` table) with `@@unique([userId, operationType, chainId, idempotencyKey])` and indexes on `[apiKeyId, createdAt]`, `[requestHash]`, `[userId, createdAt]`, `[userId, status]`; `details` JSON holds safe send metadata (execution mode, sponsorship, interaction count, agent wallet/key hash, `userOpHash`).
- **Security-event contract**: policy and simulation services emit `transaction.policy_allowed|denied` and `transaction.simulation_allowed|denied` rows with safe metadata only.

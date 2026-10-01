# Code Map for /src/modules/wallet

## Responsibility
Wallet operations for the SOFA ONE dashboard and public API:
- Read-only wallet queries: deposit info, native/stablecoin balances, signing-request history, with owner-scoped wallet selection.
- Reserved API-key signing route for EIP-191/EIP-712 inputs; all signing is denied in the DeFi-policy MVP before hashing or provider calls.
- Withdrawal-address allowlist management and withdrawal policy enforcement (single/daily limits, step-up, address allowlist + cooldown).
- Withdrawal submission as a Calibur agent user operation through Openfort, with idempotency and on-chain balance pre-checks.
- Freeze enforcement: frozen wallets are rejected before any query result or signing/withdrawal side effect.

## Design/Patterns
- **Controller/service split with validated DTOs.** `WalletController` owns routing, guard composition, and route-level throttles; `WalletService` owns business logic; `dto/` (see `dto/codemap.md`) owns class-validator request shapes.
- **Access-control split.** `POST /v1/wallets/sign` is API-key only (`ApiKeyAuthGuard` + `ApiKeyPermissionGuard` with `canSign`). All other routes are dashboard-only: `OpenfortUserGuard` + `FrontendOnlyGuard`, with `StepUpGuard` + `@RequireStepUp()` on `withdraw`, `POST/DELETE withdrawal-addresses`.
- **Policy services encapsulate security rules.** `DefiPolicyService` denies public API-key signing for the MVP; `WithdrawalPolicyService` owns dashboard withdrawal/address rules and records telemetry. `SigningPolicyService` remains unreachable from the API signing route.
- **Optional dependency injection for defense-in-depth services.** `WalletService` injects `EoaExecutionPolicyService`, `SigningPolicyService`, `RequestContextService`, `RiskEvaluationService`, and `SessionKeyPolicyService` as `@Optional()`; each is invoked when present and its absence is handled explicitly (e.g. EOA mode throws `ForbiddenException` if the policy service is missing).
- **Execution modes.** `session_key` (default) signs with the Calibur session key and wraps the raw signature as ABI-encoded `(keyHash, signature, hookData)`; `eoa` signs with the backend EOA and returns the raw signature. EOA mode is gated by `EoaExecutionPolicyService` (global opt-in, IP allowlist, ≤30-day key TTL, 1/min rate limit, security-event audit).
- **Idempotent withdrawal creation.** Unique constraint `(userId, operationType, chainId, idempotencyKey)` on `Transaction` plus a `requestHash` comparison (mismatch → `BadRequestException`). Creation runs inside a Prisma `$transaction` with a `SELECT ... FOR UPDATE` row lock on the user's `withdrawal_policies` row before the daily-limit check, closing the race between concurrent withdrawals.
- **Per-chain cached viem public clients.** `WalletService` memoizes `createPublicClient` per `chainId` for balance reads; all on-chain reads go through `getSupportedChain`-validated chains.
- **Hashing/encoding via viem.** `hashMessage` (EIP-191), `hashTypedData` (EIP-712), `encodeFunctionData` (ERC-20 `transfer`), `encodeAbiParameters` (Calibur signature wrap), `formatEther`/`formatUnits` (balance formatting), `getAddress` (address normalization in withdrawal policy).
- **Request hashing.** `hashRequest` (stable-key SHA-256) fingerprints signing requests and withdrawal intents for audit/idempotency; raw hash signing is disabled (`resolveSigningChainId` rejects `type: 'hash'`).

## Flow

### Wallet queries (dashboard-only)
- `GET /v1/wallets/deposit-info` → optional owned `walletId` selects the user's wallet; omission resolves only when exactly one eligible wallet exists (multiple require explicit selection, no arbitrary default). Load `UserWallet`, reject frozen (`assertWalletNotFrozen`) and non-active wallets, return `walletAddress`, chain metadata, and supported tokens (USDC/USDT/native per chain config).
- `GET /v1/wallets/balances?chainId=&walletId=` → optional owned `walletId` selects the user's wallet; omission resolves only when exactly one eligible wallet exists. Apply the same frozen/active guards, then parallel viem reads: native `getBalance` (`formatEther`) and ERC-20 `balanceOf` for configured stablecoins (`formatUnits(raw, 6)`). Per-token failures degrade to `{ formatted: null, error: 'fetch failed' }` rather than failing the whole request.
- `GET /v1/wallets/signing-requests` and `GET /v1/wallets/signing-requests/:id` → ownership-scoped (`userId`) `SigningRequest` list (filters: type/status/chainId; pagination) and detail. Never returns the digest or request hash.

### Signing (API-key only)
1. `ApiKeyAuthGuard` resolves the API key user; `ApiKeyPermissionGuard` requires `canSign`; `WalletService.sign` re-checks `apiKeyRecord.canSign`.
2. Chain resolution: `chainId` required; for `typed_data`, `domain.chainId` must be present and match `chainId`; `type: 'hash'` is rejected.
3. `DefiPolicyService.authorizeSigning` always denies with `DEFI_FUNCTION_NOT_ALLOWED` in this MVP. Denial is audited safely; audit failure never masks the denial. It runs before destination-protection lookup, EOA/signing-policy/risk/session-key gates, hashing, successful signing audit, SigningRequest creation, or Openfort. Every message/typed-data API-key signing request is disabled, including legacy keys; no old grant arrays are consulted.
4. The independent BILL-016 destination-protection path and dedicated withdrawal/billing-payment paths retain their own policies; DeFi generic-send grants do not blanket-gate them.
5. The final `assertStillAuthorized` check remains wired at atomic SigningRequest creation for future reviewed support, but is unreachable while `authorizeSigning` always denies. Allowed events are deferred in the transaction and exported only after commit. No Openfort/RPC/HTTP occurs under locks.

### Withdrawal-address allowlist (dashboard-only, step-up for writes)
- `GET` lists policy (`requireAddressAllowlist`, `newAddressCooldownHours`) and addresses with `isAvailable`.
- `POST` normalizes the address (`getAddress` → lowercase), upserts `WithdrawalPolicy` enabling `requireAddressAllowlist`, sets `availableAt = now + cooldownHours` (default 24h), records `withdrawal_address.added`; duplicate → `BadRequestException`.
- `DELETE` removes ownership-scoped (`userId`) and records `withdrawal_address.removed`.

### Withdrawal (dashboard-only, step-up)
1. Guards: `OpenfortUserGuard` + `FrontendOnlyGuard` + `StepUpGuard`; `stepUpVerified` is passed into the service.
2. Load `UserWallet` with `chainAuthorizations`; reject frozen, non-active (missing agent account/address/keyHash), or chain-unauthorized wallets; reject self-withdrawal.
3. `WithdrawalPolicyService.assertWithdrawalAllowed` with `skipDailyLimit: true`: enforces `requireStepUp` (defense-in-depth), single-withdrawal limit (defaults: 10k USDC/USDT micro-units, 100 native wei), and address allowlist/cooldown; records `withdrawal.policy_denied` and `withdrawal.high_value_requested` (≥1k stablecoin units / ≥1 native token).
4. `RiskEvaluationService.evaluateRisk` (`operationType: 'withdrawal'`); `require_step_up` is satisfied only when `stepUpVerified === true`.
5. Resolve token address (NATIVE → null; USDC/USDT must be supported on the chain), compute `requestHash`, and check idempotency (`findExistingWithdrawal`; requestHash mismatch → error). A matching existing request returns before the billing gate.
6. For a new request, query the user-scoped billing debt snapshot before the balance RPC; `BILLING_OUTBOUND_BLOCKED` rejects finalized unpaid invoices and `BILLING_DEBT_CHECK_UNAVAILABLE` fails closed on query errors.
7. On-chain balance pre-check via cached public client (native `getBalance` or ERC-20 `balanceOf`); insufficient balance → `BadRequestException`.
8. Prisma `$transaction`: re-check idempotency → re-check billing debt with the transaction client → `assertDailyLimitWithUserLock` (row lock + daily limit over today's counted-status withdrawals per token) → create `Transaction` (`status: 'submitting'`, `operationType: 'withdraw'`, details incl. `execution: 'calibur_agent_user_operation'`, agent wallet/keyHash, idempotency key, request hash). If the create loses a P2002 race, wait for rollback and re-read the existing row through the root Prisma client.
9. If already finalized (`txHash` set or not `submitting`) → return stored response. Otherwise build the interaction (native value transfer or encoded ERC-20 `transfer`) and call `OpenfortService.sendUserOperation` (agent account, account address, keyHash). On success update `Transaction` with `txHash`, `status: 'pending'`, and `userOpHash` in details; on failure set `status: 'unknown'` and rethrow. Return `{ transactionId, transactionHash, status }`.

### Freezing
- `assertWalletNotFrozen` throws `ForbiddenException(frozenReason ?? 'Wallet is frozen')` whenever `UserWallet.frozenAt` is set; applied to `getDepositInfo`, `getBalances`, `sign`, and `withdraw` before any data return or side effect.
- Frozen users/API keys are additionally rejected upstream by `ApiKeyAuthGuard`/`OpenfortUserGuard` (outside this module).
- Risk enforcement can freeze the API key (`risk.critical_frozen` → `ApiKey.frozenAt`) during signing/withdrawal risk evaluation.

## Integration
- **Guards/decorators:** `ApiKeyAuthGuard`, `ApiKeyPermissionGuard` + `@RequireApiKeyPermission('canSign')` (sign); `OpenfortUserGuard`, `FrontendOnlyGuard`, `@FrontendOnly()` (dashboard routes); `StepUpGuard` + `@RequireStepUp()` (withdraw, withdrawal-address writes); `@CurrentUser('id')`.
- **Services:** `PrismaService` (persistence), `OpenfortService` (`signData`, `sendUserOperation`), `DefiPolicyService` (mandatory), `WithdrawalPolicyService`, `SigningPolicyService` (not reached in MVP signing), `EoaExecutionPolicyService` (optional), `SessionKeyPolicyService` (optional), `RiskEvaluationService` (optional), `RequestContextService` (optional; request-id/IP log context), `SecurityEventService`.
- **Modules imported by `WalletModule`:** `StepUpModule`, `SecurityEventModule`, `EoaExecutionModule`, `SessionKeyModule`, `BillingModule`, `DefiModule`, `WithdrawalDestinationModule` (shared destination/cooldown leaf + `withdrawal_dest:<userId>` advisory lock for BILL-016; no cycle with destination module).
- **Common utils:** `getSupportedChain` (chain validation + token addresses), `hashRequest` (stable SHA-256), `AgentStatus` (chain-authorization readiness), `API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION` / `WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE`.
- **Prisma models:** `UserWallet` (+ `WalletChainAuthorization`), `SigningRequest`, `Transaction`, `WithdrawalPolicy`, `WithdrawalAddress`, `SecurityEvent`.
- **DTOs:** `SignDto` (message/typed-data, executionMode, chainId), `WithdrawDto` (chainId, to, amount bounds, token, idempotencyKey), `CreateWithdrawalAddressDto`, `ListSigningRequestsQueryDto` — see `dto/codemap.md`.
- **Route throttles:** signing-request reads 20/60s + 100/1h; withdraw and withdrawal-address writes 3/60s + 10/1h (on top of global throttling).

# Code Map for /src/modules/wallet

## Responsibility
Wallet operations for the SOFA ONE dashboard and public API:
- Read-only wallet queries: deposit info, native/stablecoin balances, signing-request history, with owner-scoped wallet selection.
- API-key wallet metadata (`GET /v1/wallets`) is restricted to the authenticated key's immutable wallet binding; unbound legacy keys fail closed.
- Internal wallet bindings use `signerAddress` for the backend signer, separately from the user's `walletAddress`; signing history retains its stored execution `walletAddress` without reinterpretation.
- API-key signing route with exact Polymarket CLOB `ClobAuth`, capability-authorized CLOB V2 order, and high-privilege DepositWallet Batch EIP-712 signing; arbitrary message/typed-data signing remains denied. Batch calls accept any well-formed calldata/target with zero native value and retain per-target pause checks. The verifier probes configured Polygon RPC and fails closed on missing/invalid deployment evidence.
- Withdrawal-address allowlist management and withdrawal policy enforcement (single/daily limits, step-up, address allowlist + cooldown).
- Withdrawal submission as a Calibur agent user operation through Openfort, with idempotency and on-chain balance pre-checks.
- Freeze enforcement: frozen wallets are rejected before any query result or signing/withdrawal side effect.

## Design/Patterns
- **Controller split**: WalletController owns public API-key signing; DashboardWalletController owns local-session wallet operations; ApiKeyWalletController owns public key-bound metadata. Existing DTO/service responsibilities are unchanged.
- **Auth split**: AppSessionGuard + FrontendOnlyGuard on dashboard routes, Origin/CSRF on mutations and exact-session StepUpGuard on withdrawal/address changes. Public signing remains API-key-only.
- **Policy services encapsulate security rules.** `DefiPolicyService` restricts API-key signing to the exact Polymarket `ClobAuth` bootstrap shape, while `WithdrawalPolicyService` owns dashboard withdrawal/address rules and records telemetry. `SigningPolicyService` is applied to the narrowly allowed signing path.
- **Required core policy injection.** `WalletService` requires EOA execution, signing, risk, request context, Polymarket order verifier/budget, and Batch verifier services. Only best-effort destination-protection audit injection remains optional, with failures isolated from policy results.
- **Signing execution mode.** Signing accepts only approved `typed_data` with `executionMode: 'eoa'` (also the default when omitted), returning the raw backend EOA signature. EOA isolation remains gated by `EoaExecutionPolicyService`. Transaction session-key/UserOperation submission is unchanged; withdrawals still use the Calibur agent.
- **Wallet selection.** Explicit wallet IDs use one owner-scoped `findFirst({ id, userId })`, never a full wallet enumeration. Omitted IDs retain zero/one/multiple-wallet disambiguation. Signing and withdrawal selection load chain authorizations in the same preflight query; atomic authorization rechecks remain in place.
- **Idempotent withdrawal creation.** Unique constraint `(userId, operationType, chainId, idempotencyKey)` on `Transaction` plus a `requestHash` comparison (mismatch → `BadRequestException`). Creation runs inside a Prisma `$transaction` with a `SELECT ... FOR UPDATE` row lock on the user's `withdrawal_policies` row before the daily-limit check, closing the race between concurrent withdrawals.
- **Per-chain cached viem public clients.** `WalletService` memoizes `createPublicClient` per `chainId` for balance reads; all on-chain reads go through `getSupportedChain`-validated chains.
- **Hashing/encoding via viem.** Approved EIP-712 digests are supplied by DeFi authorization, `encodeFunctionData` encodes ERC-20 `transfer`, `formatEther`/`formatUnits` format balances, and `getAddress` normalizes withdrawal addresses.
- **Request hashing.** `hashRequest` (stable-key SHA-256) fingerprints signing requests and withdrawal intents for audit/idempotency. Message and raw-hash signing are rejected; historical message signing requests remain queryable.

## Flow

### Wallet queries (dashboard-only)
- `GET /wallets/deposits?chainId=...&walletId=...` → validated query DTO; optional owned `walletId` selects the user's wallet; omission resolves only when exactly one eligible wallet exists (multiple require explicit selection, no arbitrary default). Load `UserWallet`, reject frozen (`assertWalletNotFrozen`) and non-active wallets, return `walletAddress`, chain metadata, and supported tokens (USDC/USDT/native per chain config).
- `GET /wallets/balances?chainId=&walletId=` → optional owned `walletId` selects the user's wallet; omission resolves only when exactly one eligible wallet exists. Apply the same frozen/active guards, then parallel viem reads: native `getBalance` (`formatEther`) and ERC-20 `balanceOf` for configured stablecoins (`formatUnits(raw, 6)`). Per-token failures degrade to `{ formatted: null, error: 'fetch failed' }` rather than failing the whole request.
- `GET /wallets/signing-requests` and `GET /wallets/signing-requests/:id` → ownership-scoped (`userId`) `SigningRequest` list (filters: type/status/chainId; pagination) and detail. Never returns the digest or request hash.

### Signing (API-key only)
1. `ApiKeyAuthGuard` resolves the API key user; `ApiKeyPermissionGuard` requires `canSign`; `WalletService.sign` re-checks `apiKeyRecord.canSign`.
2. Only `type: 'typed_data'` and optional `executionMode: 'eoa'` are accepted; omission defaults to EOA. `domain.chainId` is required and supplies `chainId` when omitted; explicit `chainId` must match.
3. Signing preserves the exact ClobAuth bootstrap and V2 order lanes. The Batch lane requires active `polymarket:137:deposit-wallet-batch-sign:v1` (`all` or exact `custom` ID), EOA permissions and ordinary EOA isolation; the order-only rolling 60s budget is not applied. Batch calldata/target are unrestricted beyond strict typed-data bounds and zero native value; arbitrary calls can transfer assets or alter permissions. Each actual call target's pause is checked at preflight and atomic acceptance; capability metadata/grant only follows global/chain/capability pause. Signature digest binds every ordered call. No RPC runs while policy locks are held. The verifier uses shared backend `RPC_URLS__137` (`rpc.urls.137`), pins complete deployment identity, binds evidence to digest/deadline/signer/RPC fingerprint, and performs non-broadcast `wallet.execute` simulation after TEE signer recovery.
4. The independent BILL-016 destination-protection path and dedicated withdrawal/billing-payment paths retain their own policies; DeFi generic-send grants do not blanket-gate them.
5. SigningRequest creation rechecks grant, pause, live-key, and bound-digest acceptance state before commit; provider signing occurs afterward, outside locks. This check does not serialize against concurrent freeze writers and must not be described as race-free freeze exclusion. Allowed events are deferred and exported only after commit. PostgreSQL race behavior and live Openfort/Polymarket outcomes remain unverified.

### Withdrawal-address allowlist (dashboard-only, step-up for writes)
- `GET` lists policy (`requireAddressAllowlist`, `newAddressCooldownHours`) and addresses with `isAvailable`.
- `POST` normalizes the address (`getAddress` → lowercase), upserts `WithdrawalPolicy` enabling `requireAddressAllowlist`, sets `availableAt = now + cooldownHours` (default 24h), records `withdrawal_address.added`; duplicate → `BadRequestException`.
- `DELETE` removes ownership-scoped (`userId`) and records `withdrawal_address.removed`.

### Withdrawal (dashboard-only, step-up)
1. Guards: AppSessionGuard + FrontendOnlyGuard + exact-session StepUpGuard; unsafe Origin/CSRF checked before the existing stepUpVerified service boundary.
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
- Frozen users are rejected by AppSessionGuard/ApiKeyAuthGuard; frozen API-key behavior is unchanged.
- Risk enforcement can freeze the API key (`risk.critical_frozen` → `ApiKey.frozenAt`) during signing/withdrawal risk evaluation.

## Integration
- **Guards**: public API-key permission guards remain separate from dashboard application-session/Origin/CSRF and step-up guards.
- **Services:** `PrismaService` (persistence), `OpenfortService` (`signData`, `sendUserOperation`), `DefiPolicyService` (mandatory), `PolymarketDepositBatchVerifierService` + deployment probe (full Polygon deployment identity and non-broadcast execute simulation; configured RPC required), Polymarket order verifier/budget, `WithdrawalPolicyService`, `SigningPolicyService`, EOA/risk policies, `RequestContextService`, optional best-effort `SecurityEventService`.
- **Modules imported by `WalletModule`:** `StepUpModule`, `SecurityEventModule`, `EoaExecutionModule`, `BillingModule`, `DefiModule`, `WithdrawalDestinationModule` (shared destination/cooldown leaf + `withdrawal_dest:<userId>` advisory lock for BILL-016; no cycle with destination module). Session-key policy wiring is owned by the transaction module, not wallet signing.
- **Common utils:** `getSupportedChain` (chain validation + token addresses), `hashRequest` (stable SHA-256), `AgentStatus` (chain-authorization readiness), `API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION` / `WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE`.
- **Prisma models:** `UserWallet` (+ `WalletChainAuthorization`), `SigningRequest`, `Transaction`, `WithdrawalPolicy`, `WithdrawalAddress`, `SecurityEvent`.
- **DTOs:** `SignDto` (typed-data only, optional EOA-only executionMode, chainId inferred from domain), `WithdrawDto` (chainId, to, amount bounds, token, idempotencyKey), `CreateWithdrawalAddressDto`, `ListSigningRequestsQueryDto` (retains historical message filtering) — see `dto/codemap.md`.
- **Route throttles:** signing-request reads 20/60s + 100/1h; withdrawal and withdrawal-address writes 3/60s + 10/1h (on top of global throttling). `POST /wallets/withdrawals` uses the existing withdrawal throttle.

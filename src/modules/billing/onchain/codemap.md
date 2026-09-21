# src/modules/billing/onchain/

Dashboard-only native USDC invoice payment rail (Phase 3B Phase 2). Lets a user pay a finalized USD invoice on-chain with USDC on Ethereum (1), Ethereum Sepolia (11155111), Base (8453) or Base Sepolia (84532), with server-side quote snapshots and strict receipt verification. Not part of the public API-key spec (`openapi.yaml`).

## Responsibility

- **Quote** (`POST /v1/billing/invoices/:id/usdc/quote`): creates (or idempotently reuses) a pending `BillingPaymentAttempt` for a finalized, unpaid, USD invoice owned by the user. All payment facts are server-derived and snapshotted at quote time; the client only supplies an optional verified `chainId` selector.
- **Claim** (`POST /v1/billing/invoices/:id/usdc/claim`): verifies a user-submitted `{ paymentAttemptId, txHash }` against the attempt's immutable quote snapshot via RPC receipt lookup, then advances the payment lifecycle (`pending → confirming → succeeded`, or `expired`/`needs_review`/`failed` on any mismatch). Never fabricates a payment.
- **Cancel** (`POST /v1/billing/invoices/:id/usdc/cancel`, BILL-003): user-initiated cancel of a **clean** evidence-free pending USDC quote. Body is only `{ paymentAttemptId }`. Allowed only for invoice-owned `method=usdc` attempts that are `pending`, `walletPaymentReserved=false`, and fully evidence-free. Confirming, reserved, any hash/receipt/evidence, unknown/inconsistent markers, and other terminals fail closed without rewriting evidence. Already-`cancelled` is idempotent. No RPC/provider/broadcast. Safe DTO only (`status`/`cancelledAt`/`cancelReason` — no hash/receipt/provider/secrets). Frees the active pending/confirming slot for a fresh quote; does not change quote TTL/cooldown/evidence-release rules for non-cancel paths.
- **Receipt verification**: settlement requires a successful receipt with exactly one unambiguous canonical USDC `Transfer` log from the expected payer to the configured treasury for the exact expected amount, plus the configured confirmation threshold. Underpayment, overpayment, wrong token/recipient/payer, malformed/removed/ambiguous logs, reorgs, duplicate evidence, and Stripe-vs-USDC races all become `needs_review` (or retryable `expired`/`failed`) — never automatic accumulation, refunds, or overwrites of a paid invoice.
- **Worker recovery (gated)**: pending/confirming claims with a persisted canonical `submittedTxHash` and a due `nextCheckAt` are resumed by `BillingWorkerService.recoverUsdcClaims` (enabled only with `BILLING_WORKER_ENABLED=true`) through the same `claim()` verification path with the persisted hash — never re-derived or fabricated. Without the worker, user claim/retry remains the only driver of the lifecycle. Cancelled attempts are terminal and are never recovered.

Files:

- `usdc-payment.controller.ts` — route wiring, guards, claim/cancel throttle.
- `usdc-payment.service.ts` — quote/claim/cancel orchestration, strict Transfer parsing, evidence-aware CAS state transitions, atomic settlement.
- `usdc-receipt.provider.ts` — RPC boundary (viem-backed), sanitized receipt/log types, DI token contract.
- `usdc.constants.ts` — chain allowlist, `Transfer` topic0, decimals, strict hex regexes, `USDC_RECEIPT_PROVIDER` symbol.
- `dto/` — request DTOs (see `dto/codemap.md`; referenced here, not owned).

## Design/Patterns

- **Server-derived facts**: the client is trusted only for a verified chain selector (quote) and `{ paymentAttemptId, txHash }` (claim). Token, treasury, RPC, expected payer, amount, decimals, TTL, and confirmations are always derived server-side and snapshotted on the attempt.
- **Immutable quote snapshot**: `BillingPaymentAttempt` stores `chainId`, `tokenAddress`, `treasuryAddress`, `tokenDecimals`, `expectedBaseUnits` (= invoice `totalMicros`, 1:1 at 6 decimals), `quoteExpiresAt`, `expectedPayerAddress` (invoice owner's active `UserWallet`), `requiredConfirmations`, and `providerIdentity` — a sha256 digest of the per-chain RPC URL (the raw URL, which may embed an API key, is never persisted/logged/returned). `assertSnapshotComplete` fails closed on any missing/inconsistent field before a claim can proceed.
- **Evidence-aware compare-and-set**: every state write after RPC is bound to a `ClaimEvidence` identity (`txHash`, `chainId`, `tokenAddress`, `blockNumber`, `blockHash`, `logIndex`, `payerAddress`, `actualBaseUnits`). The CAS (`casUpdateEvidence`) only matches when the attempt is still active AND its recorded evidence is absent or exactly equal, so a stale claim can never regress a terminal state or overwrite a different evidence identity. `casUpdateReview` additionally guards on the recorded tx hash.
- **First-rail-wins settlement**: the final transition runs in one `$transaction` that takes stable PostgreSQL row locks (attempt → invoice, matching the Stripe webhook's lock order to avoid deadlocks), re-reads the attempt under the lock, marks it `succeeded`, and calls the shared `InvoiceSettlementService.settleInvoice` (atomic `paidAt`/`paidVia`/`settlementAttemptId` CAS). A lost rail race records the successful evidence as `duplicate_unallocated` review.
- **Strict Transfer parsing**: only logs from the canonical token with `Transfer` topic0 are candidates; topics must be exactly three strictly 32-byte hex values with zero ABI padding, data a 32-byte uint256, `removed === false` (missing/non-boolean/true is unsafe), from = expected payer, to = treasury, amount = expected. Zero matches, malformed/removed/unsafe logs, and multiple exact matches are all review with a specific reason.
- **Retryable vs terminal states**: `pending` (receipt not found) and `rpc_error` (transient RPC) are retryable no-ops; `confirming` records evidence and stays active; `succeeded`/`expired`/`needs_review`/`failed`/`cancelled` (BILL-003 user cancel of clean pending) are terminal and returned idempotently on replay. Cancel never touches confirming/evidence rows.
- **User cancel CAS (BILL-003)**: lock order `billing-period advisory → payment attempt FOR UPDATE → invoice FOR UPDATE` (compatible with claim settle / wallet-pay / plan-cancel). CAS predicates require `pending` + unreserved + null evidence fields + null `allocatedAt`/`succeededAt`. Writes `status=cancelled`, `cancelledAt`, `cancelReason=user_requested` (dedicated fields — not `failedAt`/`failureCode`/`reviewReason`). Error codes: `USDC_CANCEL_NOT_ALLOWED`, `USDC_WALLET_PAYMENT_RESERVED`, `USDC_INVALID_ATTEMPT`; ownership misses are 404.
- **Reorg and chain-time guards**: recorded block hash/number mismatch → `reorged`; transfer mined before attempt creation → `receipt_predates_attempt`; mined after quote expiry → `expired` (pending) or `evidence_changed` (confirming); chain head behind receipt block → retryable `rpc_error`.
- **Evidence uniqueness**: the schema's `@@unique([chainId, tokenAddress, txHash, logIndex])` makes the same Transfer allocatable to at most one attempt; a P2002 conflict becomes `duplicate_unallocated` review. The migration-only unique index on the canonical `submitted_tx_hash` (NULLs distinct) makes the SAME user-submitted hash allocatable to at most one attempt: a second attempt's persist write hits a Prisma P2002 and fails closed to `needs_review`/`duplicate_unallocated` (`failureCode: duplicate_submitted_hash`) before any provider work.
- **Persist-before-RPC / first-writer-wins**: the canonical user-submitted hash is CAS-persisted (`submittedTxHash`, guarded by active states and null-or-equal) BEFORE any RPC verification, so a process restart/worker retry resumes the claim from the stored hash. The first claim to persist owns the attempt: a competing claim with a DIFFERENT hash matches zero rows and returns the observed real state without RPC; a competing attempt with the SAME hash hits the unique index P2002 and fails closed to `duplicate_unallocated` review. Hash persistence is never deferred to after RPC, and no second provider claim is ever allowed.
- **DI boundary**: `USDC_RECEIPT_PROVIDER` (Symbol) abstracts the RPC layer; `ViemUsdcReceiptProvider` is the production implementation. Receipt-not-found is classified by viem's `TransactionReceiptNotFoundError` type (never error-message text) and returned as `null`; all other provider errors propagate as retryable RPC errors.

## Flow

**Quote** (`UsdcPaymentService.quote`):

1. `assertEnabled` (`billing.usdc.enabled === true`) → `loadOwnedInvoice` (via `BillingAccount.userId`) → `assertInvoiceEligible` (finalized, unpaid, USD, positive total).
2. `resolveChain`: client `chainId` must be in `USDC_BILLING_CHAIN_IDS` AND have both a configured treasury and RPC URL; without a selector, `chain.defaultChainId` if it is a USDC chain, else 84532.
3. Derive token (`getSupportedChain(...).usdcAddress`), treasury (config), expected payer (active unfrozen `UserWallet`), confirmations (default 5), expiry (default 24h).
4. Find existing active attempt (`pending`/`confirming`): confirming is always reused on the same chain (never released); an expired/incomplete pending attempt is released via a pending-only CAS before any chain-conflict check; a non-expired different-chain active attempt is a `ConflictException`.
5. Create the attempt with the full snapshot; on a P2002 insert race, reuse the winner only when it is active on the requested chain.

**Claim** (`UsdcPaymentService.claim`):

1. Load owned invoice (must be `finalized`), load attempt (must belong to the invoice, be `method === 'usdc'`, match amount/currency), `assertSnapshotComplete` (fail-closed).
2. Canonicalize `txHash` to lowercase (format validated; casing can never bypass evidence uniqueness). Terminal states are returned as-is.
3. A confirming attempt bound to a different hash → `evidence_conflict` review.
4. Persist the canonical submitted hash BEFORE RPC (active-states + null-or-equal CAS, schedules the recovery backoff). A different-hash loser matches zero rows → the observed real state is returned with NO RPC. A same-hash cross-attempt P2002 (migration-only unique `submitted_tx_hash` index) → the active attempt is CAS-marked `needs_review`/`duplicate_unallocated` (`failureCode: duplicate_submitted_hash`) and the sanitized state returned — never a 500, never a permanent pending, never a second provider claim. Non-P2002 errors propagate unchanged.
5. RPC `getTransactionReceipt`: `null` → `pending` (retryable), or `confirming` if evidence already recorded, or `expired` if the quote lapsed; throw → `rpc_error` (retryable).
6. Verify receipt hash matches, block timestamp present, no reorg, transfer not predating the attempt, receipt status `success` (reverted → `failed` for pending, `reorged` review for confirming).
7. `parseTransfer` strict verification; any mismatch → `needs_review` with a specific reason.
8. Confirming attempt's recorded evidence must match the current receipt (`evidence_changed` review otherwise); post-expiry timestamp → `expired` (pending) or `evidence_changed` (confirming).
9. `getBlockNumber`: confirmations = head − receipt block + 1. Below threshold → `markConfirming` (evidence-aware CAS, records evidence, stays active). At/above threshold → `settleConfirmed`.

**Settlement** (`settleConfirmed`): `$transaction` → `FOR UPDATE` locks attempt then invoice → re-read attempt → terminal states returned as-is → recorded evidence must match the caller's identity (else `duplicate_unallocated` review) → mark `succeeded` with evidence → `settlementService.settleInvoice` (first-rail-wins CAS) → if another rail won, record `duplicate_unallocated` review in the same transaction. P2002 → `duplicate_unallocated` via evidence-aware CAS.

**Cancel** (`UsdcPaymentService.cancel`, BILL-003):

1. `assertEnabled` → `loadOwnedInvoice` (ownership 404).
2. `$transaction`: period advisory → attempt `FOR UPDATE` → invoice `FOR UPDATE`.
3. Re-read attempt under lock: wrong invoice → 404; already `cancelled` → idempotent safe DTO; non-`usdc` → `USDC_INVALID_ATTEMPT`; reserved → `USDC_WALLET_PAYMENT_RESERVED`; confirming or any evidence → `USDC_CANCEL_NOT_ALLOWED`; other terminals → stable `USDC_CANCEL_NOT_ALLOWED`.
4. CAS `updateMany` with cancellable-pending predicates → `cancelled` + `cancelledAt` + `cancelReason=user_requested`. CAS miss → re-read (idempotent cancel or fail closed). No RPC/settlement side effects.

## Integration

- **`BillingModule`** (`../billing.module.ts`): registers `UsdcPaymentController`, provides `UsdcPaymentService`, and binds `USDC_RECEIPT_PROVIDER` → `ViemUsdcReceiptProvider`. The module imports `PrismaModule`.
- **`InvoiceSettlementService`** (`../invoice-settlement.service.ts`): shared atomic first-rail-wins settlement boundary, also used by the Stripe webhook; takes the interactive transaction client so USDC settles inside its own transaction. Lock order attempt → invoice is shared with Stripe to stay deadlock-free.
- **Prisma** (`prisma/schema.prisma`): `BillingPaymentAttempt` (quote snapshot + evidence columns, `@@unique([chainId, tokenAddress, txHash, logIndex])`, `@@index([invoiceId, method, status])`), `BillingInvoice` (`paidAt`/`paidVia`/unique `settlementAttemptId`), `BillingAccount` (ownership), `UserWallet` (expected payer).
- **Config** (`src/config/configuration.ts`): `billing.usdc.enabled` (`BILLING_USDC_ENABLED`), `treasuryAddresses.{1,11155111,8453,84532}` (`BILLING_USDC_TREASURY_ADDRESS_1/11155111/8453/84532`), `rpcUrls.{1,11155111,8453,84532}` (`BILLING_USDC_RPC_URL_1/11155111/8453/84532`), `requiredConfirmations` (default 5), `quoteTtlSeconds` (default 86400), `chain.defaultChainId`.
- **`getSupportedChain`** (`../../../common/chains/supported-chains.ts`): canonical `usdcAddress` per chain and the viem `Chain` object used by the receipt provider.
- **Guards/decorators**: `OpenfortUserGuard` + `FrontendOnlyGuard` + `@FrontendOnly()` — dashboard-only routes intentionally omitted from `openapi.yaml`; require an Openfort IAM bearer token plus origin/referer checks. `@CurrentUser('id')` supplies the user id.
- **Throttling**: claim carries a tight route-level throttle (`short: 5/60s`, `medium: 20/3600s`) to bound RPC amplification; cancel is DB-only but throttled (`short: 10/60s`, `medium: 60/3600s`); global throttling still applies.
- **DTOs** (`dto/`): `UsdcQuoteDto` (optional `chainId`), `UsdcClaimDto` (`paymentAttemptId` UUID + `txHash` 32-byte hex regex), `UsdcCancelDto` (`paymentAttemptId` UUID only). The global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`) rejects any other field.
- **Prisma**: `BillingPaymentAttemptStatus.cancelled` terminal + `cancelledAt` / `cancelReason` columns (migration `20260921200000_usdc_payment_attempt_cancelled`).
- **`billing.utils`** (`../billing.utils.ts`): `microsToDecimalUsd` formats the quote's `amountUsd` without floating point.

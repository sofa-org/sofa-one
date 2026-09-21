# src/modules/billing/

Commercial billing subsystem for SOFA ONE: plan catalog and self-service plan
changes, usage metering (API calls, outbound volume, active wallets), quota
enforcement, monthly invoice finalization, Stripe payment rails (Checkout,
renewal fixed fees, Stripe off-session overage collection, and native USDC on
Base), receipt-confirmed reconciliation, and a shared coverage-first allocation
boundary. All monetary math is bigint microdollars;
all persisted/returned payloads are JSON-safe (no BigInt leaks).

## Responsibility

| File                                | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.module.ts`                 | Nest module wiring: imports `PrismaModule`, `SecurityEventModule`, and `ScheduleModule.forRoot()`; registers 3 controllers + 10 providers, exports the services consumed by other modules.                                                                                                                                                                                                                                                                                                                                        |
| `billing.controller.ts`             | Frontend-only dashboard routes under `v1/billing` (plans, plan change, summary, invoices, checkout, subscription-checkout, reconcile).                                                                                                                                                                                                                                                                                                                                                                                            |
| `billing.service.ts`                | Core service: plan catalog seeding/validation, plan assignment, usage recording + API-call quota, outbound metering (legacy + receipt-confirmed), summary aggregation, invoice list/get/finalize, and the shared billing-period lock seam.                                                                                                                                                                                                                                                                                        |
| `billing-calculator.ts`             | Pure pricing calculator: `PLANS` config, `STANDARD_OUTBOUND_TIERS`, `calculateInvoiceTotals` / `calculateOutboundOverage`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `billing-catalog.ts`                | Human-facing plan marketing copy (`description`/`features`) keyed by `PlanId`; no monetary values.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `billing-pricing.ts`                | Pure deterministic USDC/USDT → microdollar pricing boundary (`evaluatePricing`, `TOKEN_PRICES`) with structured `quarantined` results.                                                                                                                                                                                                                                                                                                                                                                                            |
| `billing-entitlement.service.ts`    | Read-only plan/quota façade: `getEntitlements`, `getPlanForPeriod`, and the transaction-aware `assertWalletActivationAllowed` hard-quota seam.                                                                                                                                                                                                                                                                                                                                                                                    |
| `billing-worker.service.ts`         | Gated 5-minute `@Interval` worker (`BILLING_WORKER_ENABLED`, default off; exposes no route): drains receipt reconciliation per account/period, runs invoice finalization catch-up, materializes due recurring periods, resumes pending/confirming USDC claims, retries deferred Stripe renewal events, and recovers interrupted pending checkouts. Reuses the existing evidence-backed services. Maintains a non-sensitive `BillingWorkerHeartbeat` lifecycle row (`starting`→`running`→`healthy`/`failed`) for health readiness. |
| `billing-reconciliation.service.ts` | Receipt-confirmed outbound reconciliation: scans `Transaction` rows, fetches sanitized receipts via Openfort, appends `posted`/`quarantined` ledger events, records run summaries with completion markers.                                                                                                                                                                                                                                                                                                                        |
| `invoice-settlement.service.ts`     | Shared atomic invoice-allocation boundary (`settleInvoice`): row-locked, coverage-first, invoice-paid-last; used by both Stripe and USDC rails and the renewal fixed-fee catch-up.                                                                                                                                                                                                                                                                                                                                                |
| `billing-quota.exception.ts`        | `BillingQuotaExceededException` — HTTP 429 with machine-readable `BILLING_API_QUOTA_EXCEEDED` code, metric, limit, period, retryAfter.                                                                                                                                                                                                                                                                                                                                                                                            |
| `billing.utils.ts`                  | Pure helpers: `parsePeriod`, `formatUtcMonth`, `microsToDecimalUsd`, `ppmToPercentString`, `safeNumber`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `dto/`                              | Request DTOs for the five dashboard billing routes (see `dto/codemap.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `stripe/`                           | Stripe Checkout rail: client provider, payment service, signature-verified webhook controller/service, constants (see `stripe/codemap.md`).                                                                                                                                                                                                                                                                                                                                                                                       |
| `onchain/`                          | Native USDC rail: quote/claim controller + service, viem receipt provider, constants (see `onchain/codemap.md`).                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Design/Patterns

- **Bigint microdollar accounting.** Every amount is a bigint in microdollars
  (1 USD = 1_000_000 microdollars); rates are ppm. `billing-calculator.ts`,
  `billing-pricing.ts`, and `billing.utils.ts` are pure and never use floats.
  BigInt is converted to `Number` only at safe boundaries (`toSafeCount`) and
  serialized as strings in every DTO/result (`microsToDecimalUsd`).
- **Static plan whitelist + versioned DB snapshot.** `PLANS` in
  `billing-calculator.ts` is the canonical price table; `PLAN_CATALOG` carries
  marketing copy. `BillingService.ensurePlanVersions()` seeds
  `BillingPlanVersion` + `BillingPlanTier` rows on first access (only when
  missing; used versions are never updated). `validatePlanVersion` is the
  fail-closed gate: unknown codes, malformed terms, and Enterprise custom/null
  terms are rejected with `ConflictException` — never silently treated as Free,
  0, or infinite.
- **Billing-period lock seam.** `withBillingPeriodLock` opens a Prisma
  interactive transaction at `Serializable` isolation and takes a
  PostgreSQL transaction-scoped advisory lock keyed deterministically by
  `billingAccountId + periodStart`. All writers for the same account+period
  (quota check-and-record, receipt evidence appends, reconciliation-run
  creation, invoice finalization) serialize on this seam; `withRetryOnSerialization`
  retries P2034/40001 a bounded number of times with fresh transactions.
- **Usage ledger as an append-only event table.** `BillingUsageEvent` rows
  carry `metric` (`api_call` | `outbound_volume`), `entryType` (`usage`),
  `sourceType` (`api_request` | `openfort_receipt` | `legacy_import`), and
  `status` (`posted` | `quarantined` | `unverified`). Idempotency is a unique
  `sourceKey` (server-generated, never a client `X-Request-Id`); receipt-backed
  rows additionally dedupe on `(billingAccountId, receiptRef, receiptLogIndex)`.
  Only `posted + usage` rows count toward invoices; `quarantined` blocks
  finalization; `unverified`/`legacy_import` rows are excluded from billing.
- **Fail-closed receipt evidence.** `recordSuccessfulOutbound` with a `receipt`
  requires transaction ownership/evidence match, complete block evidence,
  deterministic pricing (`assertPostedPricingEvidence` — the amount must equal
  `roundHalfUp(baseUnitAmount * unitPriceMicros / 10^decimals)`), and a
  `periodStart` equal to the receipt block timestamp's UTC month. A finalized
  invoice is a period-close barrier: late evidence is rejected, never appended.
- **Invoice lifecycle.** `open` (zero-usage estimate created by a plan change)
  → `finalized` (immutable, after period end + 24h grace, with SHA-256
  `snapshotHash` over a JSON snapshot) → `paid` (set only by the settlement
  boundary). `finalized`/`needs_review`/`void` invoices are immutable; only
  `open` invoices can be updated by a plan change.
- **Dual-rail payment attempts + coverage-first allocation.** `BillingPaymentAttempt`
  rows are method-scoped (`stripe` | `usdc`); a partial unique index keeps at
  most one active pending attempt per invoice+method, and a second
  migration-only partial unique index
  (`billing_payment_attempts_one_active_payment_per_invoice_idx`) allows at most
  ONE active (`pending`/`confirming`) payment attempt per invoice across ALL
  rails (USDC and every Stripe charge kind), so a confirming USDC transfer and
  an off-session Stripe overage — or any other two active rails — can never
  coexist (services preflight and treat the P2002 as a fail-closed Conflict). `InvoiceSettlementService.settleInvoice`
  takes stable PostgreSQL row locks (attempt → invoice, matching the webhook's
  natural order to avoid deadlocks) and allocates a succeeded attempt's coverage
  toward `BillingInvoice.allocatedMicros` — never more than the remaining
  balance — marking the invoice paid only when cumulative coverage reaches the
  frozen total. The attempt `allocatedAt` marker makes a replay of the same
  attempt an idempotent no-op, and any coverage/paid-marker CAS failure aborts
  the whole caller transaction (throw → rollback) so the attempt marker and the
  invoice coverage/paid markers can never diverge. Precondition failures are
  no-ops (`allocated: false`), never throws; a lost rail race is recorded as
  `needs_review`/`duplicate_unallocated`, never an overwrite of the paid invoice,
  and a fixed-fee under-charge on a larger invoice is a legitimate PARTIAL
  allocation (the overage remainder is collected by the overage worker).
- **Scheduled worker seam (default off).** `BillingWorkerService` ticks every 5
  minutes via `ScheduleModule.forRoot()` but only acts when `billing.worker.enabled`
  (`BILLING_WORKER_ENABLED=true`) is set; otherwise the tick returns immediately.
  Cross-instance correctness comes from the shared PostgreSQL billing-period advisory
  lock, DB-backed reconciliation-run leases/heartbeats, and Stripe/USDC retry
  leases — never an in-memory lock or Redis. RPC and Stripe calls are never inside a
  DB transaction; the worker reuses the existing services instead of duplicating
  business logic. It is a provider, not a controller — no route.
- **Worker heartbeat/readiness (P1).** When enabled, `onModuleInit` upserts a
  `BillingWorkerHeartbeat` row keyed by the process's random `workerId` with
  `starting`; immediately before the bounded tick work it upserts `running` and
  refreshes `lastHeartbeatAt`/`lastStartedAt`; only after every bounded stage
  succeeds it upserts `healthy` with `lastSuccessAt` and resets
  `consecutiveFailures`; the top-level tick catch upserts `failed` with
  `lastFailureAt`, refreshes the heartbeat, and increments `consecutiveFailures`.
  The row stores only status/timestamps/counters — no error text, account/user
  data, secrets, or provider identifiers. Heartbeat writes are sanitized/logged
  and never mask the original billing result or abort unrelated work.
  `HealthService` aggregates these rows (never exposing worker IDs) for
  `/health/ready`.
- **Reconciliation runs with completion markers.** `BillingReconciliationRun`
  rows carry a JSON `summary` with counters, `userId`, `complete: true` (only
  when the bounded scan was exhausted with zero errors/conflicts), a
  `highWaterMark` (max `(createdAt, id)` across candidates), and
  `accountingPeriods`. `isRiskyReconciliationRun` treats missing/malformed
  metadata, running/failed status, and any error/conflict/notFound/transient
  counter as unresolved risk that blocks invoice finalization.
- **JSON-safe by construction.** Every result type serializes bigints as
  strings; `assertJsonSafe` rejects BigInt nested in `receiptData`/`metadata`;
  reconciliation and claim results never expose logs, calldata, RPC details,
  Openfort IDs, or secrets.

## Flow

### Controller wiring

- `BillingController` (`v1/billing`, all routes `@FrontendOnly()` +
  `OpenfortUserGuard` + `FrontendOnlyGuard`, user id from `@CurrentUser('id')`):
  - `GET /plans` → `billingService.getPlans`
  - `POST /plan` → `billingService.assignPlan(userId, body.planCode)`
  - `GET /summary?period=` → `billingService.getSummary`
  - `GET /invoices?page=&limit=` → `billingService.listInvoices`
  - `GET /invoices/:id` → `billingService.getInvoice`
  - `GET /invoices/:id/payment-status` → `billingService.getInvoicePaymentStatus`
    (BILL-018 invoice-level read-only recovery: active attempt, wallet
    reservation, all unresolved needs_review/reorged attempts + blocking
    reasons; never creates quote/attempt or calls providers; never returns
    calldata/receipts/RPC/hashes; ownership-scoped)
  - `POST /invoices/:id/checkout` → `stripePaymentService.createCheckoutSession`
  - `POST /invoices/:id/subscription-checkout` → `stripePaymentService.createSubscriptionCheckout(userId, id, body.planVersionId)`
  - `POST /reconcile` → `reconciliationService.reconcile(userId, { limit })`
- `StripeWebhookController` (`POST v1/billing/webhooks/stripe`): `@Public()`,
  `@SkipThrottle({ short, medium })`, verifies the signature from `req.rawBody`
  (never re-parsed) → `stripeWebhookService.handleWebhook`.
- `UsdcPaymentController` (`v1/billing/invoices/:id/usdc`, dashboard guards):
  - `POST /quote` → `usdcPaymentService.quote(userId, id, body.chainId)`
  - `POST /claim` → `usdcPaymentService.claim(userId, id, body)` with a tight
    route throttle (`5/60s`, `20/3600s`) to bound RPC amplification.

### Plans

```
GET /v1/billing/plans
  → ensureAccount (lazy BillingAccount create, P2002-tolerant)
  → ensurePlanVersions (seed catalog from PLANS + PLAN_CATALOG)
  → ensureDefaultAssignment (current-month Free assignment if none ≤ now)
  → current plan = assignment effective ≤ current UTC month (future scheduled
    assignment never overrides); future assignment exposed as scheduledPlan
  → validatePlanVersion on every persisted row (fail closed)

POST /v1/billing/plan { planCode }
  → isOwnPlanCode whitelist check (no DB calls on unknown code)
  → ensurePlanVersions + validatePlanVersion + assertPlanFinalizable
  → effective period = next UTC month (never client-supplied)
  → withBillingPeriodLock: reject immutable future invoice; idempotent no-op on
    same plan; replace/create BillingPlanAssignment; upsertOpenInvoice
    (zero-usage estimate + lines + snapshotHash)
```

### Metering

```
API-key request → ApiKeyAuthGuard.recordApiCallUsage
  → billing.assertAndRecordApiCall({ sourceKey: api:<uuid>, ... })
  → withBillingPeriodLock: resolve plan, fail closed on null includedApiCalls
  → sum only metric=api_call AND entryType=usage quantities (bigint)
  → used ≥ limit → BillingQuotaExceededException (429, Retry-After = period end)
  → else insert posted/usage/api_request event (atomic, no double count)

Wallet activation → AuthService (preflight + in-transaction)
  → billingEntitlements.assertWalletActivationAllowed(userId, tx)
  → resolve entitlements; Enterprise null includedWallets → ConflictException
  → already-active wallet is idempotent; else count active wallets and reject
    with 429 when count ≥ includedWallets (same transaction snapshot)

Outbound transfer (receipt-confirmed) → BillingReconciliationService
  → billing.recordSuccessfulOutbound({ ...receipt evidence })
  → withBillingPeriodLock: validate evidence, ownership, pricing, period;
    canonical lookup (sourceKey then receiptRef+logIndex) → replay or conflict;
    finalized-period barrier; insert posted/quarantined event
```

### Invoices

```
GET /v1/billing/summary?period=YYYY-MM
  → ensureAccount/planVersions/defaultAssignment; resolvePlanVersion
  → aggregate usage (posted outbound + usage api_call) and active-wallet count
  → calculateInvoiceTotals → decimal-string BillingSummaryDto + tier breakdown

GET /v1/billing/invoices, GET /v1/billing/invoices/:id
  → account-scoped paginated list / single invoice (NotFound if not owned)

GET /v1/billing/invoices/:id/payment-status (BILL-018)
  → ownership-scoped read-only recovery: active pending/confirming attempt,
    wallet reservation, and ALL unresolved needs_review/reorged attempts
    (oldest first) with blockingReasons — never latest-pending-only;
    never creates quote/attempt or calls external providers; safe DTO only

finalizeInvoice (service-internal, no route)
  → pre-check: non-open invoice returned unchanged
  → assertFinalizablePeriod (period ended + 24h UTC grace)
  → withBillingPeriodLock: re-check, resolve plan, assertPlanFinalizable,
    assertNoUnresolvedBillingRisk (quarantined usage + risky reconciliation
    runs), aggregate usage, calculateInvoiceTotals, build snapshot + SHA-256
    hash, create/update finalized invoice + lines (P2002 race returns existing)
```

### Reconciliation

```
POST /v1/billing/reconcile { limit ≤ 200 }
  → withBillingPeriodLock: create running BillingReconciliationRun
  → selectCandidates: non-confirmed (submitting/pending/unknown) first, then
    confirmed fill, both (createdAt, id) asc, bounded by limit
  → per candidate: OpenfortService.getTransactionReceipt
      not_found/error → retryable counters, keep pending
      reverted → markReverted (CAS), never metered
      success → txHash match check; EOA sender mismatch / native withdrawal →
        quarantined; else parse each Transfer log (strict runtime validation)
        → evaluatePricing → posted (recordSuccessfulOutbound) or quarantined
      → markConfirmed (CAS updateMany)
  → build highWaterMark + accountingPeriods; persist completed summary with
    complete flag (or failed summary with sanitized errorDetails)
```

### Stripe rail

```
POST /v1/billing/invoices/:id/checkout (one-time, mode 'payment')
  → stripeClientProvider (null when STRIPE_SECRET_KEY unset → 503)
  → assertCheckoutEligible (finalized, unpaid, USD, positive, cent-aligned)
  → reuse valid pending attempt (TTL 24h) or createPendingAttemptOrReuseInFlight
    (partial pending index + in-flight poll, stale release, never a second
    pending attempt); a pending attempt of a different stripeChargeKind is
    never reused or released
  → ensureStripeCustomer (idempotency key `customer:<accountId>`)
  → stripe.checkout.sessions.create with idempotencyKey `checkout:<attemptId>`,
    metadata { invoiceId, attemptId, period }, client_reference_id = invoiceId
  → persist session/PI ids + checkoutUrl; failure marks attempt failed (CAS)

POST /v1/billing/invoices/:id/subscription-checkout { planVersionId } (recurring)
  → assertCheckoutEligible; selected plan version must EXACTLY match the owned
    invoice plan and the invoice total must equal the finite, positive,
    cent-aligned fixed fee (a dynamic/overage invoice is rejected)
  → reuse only a fixed_fee pending attempt with matching amount (a full
    pending attempt is a hard conflict, never reused/released)
  → mode:'subscription' Checkout with billing_cycle_anchor = invoice.periodStart,
    proration_behavior 'none', idempotencyKey `subscription-checkout:<attemptId>`;
    persists stripeSubscriptionId and bootstraps the account subscription mirror
    (status 'incomplete' until webhooks confirm)

POST /v1/billing/webhooks/stripe (signed, raw body; 13 processed event types)
  → constructEventAsync; unknown event type → record ignored, 2xx
  → processKnownEvent in one transaction: insert StripeWebhookEvent (unique
    event id = atomic idempotency), findAttemptForEvent (persisted object id →
    verified metadata attemptId/invoiceId → client_reference_id, all
    method=stripe scoped), persistEventIds, resolveTransition
    (checkout.session.completed only succeeds when payment_status=paid)
  → renewal events (customer.subscription.* / invoice.created|finalized|paid|
    payment_failed) drive the subscription mirror + fixed-fee materialization:
    an unmatched renewal event is `deferred` with bounded exponential backoff
    and retried by the worker (never silently ignored); an exact UTC-month
    fixed-fee renewal materializes the local renewal invoice + fixed-fee attempt
    exactly once (unique stripeInvoiceId), subject to provider-fact validation
  → succeeded → forward-only attempt update + settlementService.settleInvoice
    (coverage-first allocation; lost race → duplicate_unallocated review;
    fixed-fee partial coverage keeps the invoice unpaid and the overage worker
    collects the remainder — never a fake paid); failed/canceled/requires_action
    → pending-only CAS to failed

Worker recovery (BillingWorkerService, gated by BILLING_WORKER_ENABLED)
  → retryDeferredStripeEvents: re-fetches deferred events from Stripe by id and
    re-applies them through the signature/idempotent webhook pipeline under a
    DB-backed retry lease; bounded retry budget then needs_review
  → recoverPendingCheckouts: resumes interrupted pending Stripe Checkouts via
    stripe.checkout.sessions.retrieve (expanded subscription), proving session
    identity/amount/currency/customer/period compatibility before persisting
    recovered ids, with checkoutRetry* lease columns; exhaustion → needs_review
  → recoverUnallocatedFixedFee: retries the post-commit fixed-fee allocation for
    finalized unpaid invoices whose succeeded fixed-fee attempt still has
    allocatedAt NULL (the finalize post-commit catch-up can fail transiently)
  → attemptRenewalOverage: after finalization + allocated fixed-fee coverage,
    charges the frozen remainder off-session (Stripe PaymentIntent,
    confirm+off_session, stable key `overage-payment:<attemptId>`, provable
    default PM, active-USDC exclusion, bounded backoff-respecting retries)
  → recoverOverageCharges: resumes pending overage charges — a PI-less attempt
    re-issues the SAME attempt/idempotency key (never a second charge), and a
    PI-persisted attempt is actively RECONCILED via
    `StripeWebhookService.reconcileOveragePaymentIntent` (retrieve, never
    create): succeeded PIs are settled through the shared coverage boundary,
    failed/canceled/SCA/identity-mismatch PIs are surfaced with a safe state,
    processing/transient PIs stay pending with a re-check backoff; exhaustion →
    needs_review
```

### USDC rail

```
POST /v1/billing/invoices/:id/usdc/quote { chainId? }
  → assertEnabled (BILLING_USDC_ENABLED); loadOwnedInvoice; assertInvoiceEligible
  → resolveChain (allowlist 1/11155111/8453/84532 + configured treasury/RPC; default chain
    or Base Sepolia); canonical token from SUPPORTED_CHAINS; expected payer =
    active user wallet; requiredConfirmations (≥5); quoteExpiresAt (TTL)
  → reuse/release active pending/confirming attempt (confirming never released;
    expired pending released before chain-conflict check; different-chain active
    = conflict); else create attempt with full immutable quote snapshot
    (providerIdentity = sha256 of RPC URL, never the raw URL); the quote amount
    is the CURRENT remaining balance (`totalMicros - allocatedMicros`) once a
    fixed-fee renewal has allocated coverage, and the full total otherwise

POST /v1/billing/invoices/:id/usdc/claim { paymentAttemptId, txHash }
  → assertSnapshotComplete (every snapshot field present + consistent with
    current config/allowlist — fail closed)
  → canonicalize txHash; terminal states returned as-is; evidence-conflict →
    review
  → persist-before-RPC / first-writer-wins: CAS-persist the canonical
    submittedTxHash (active states, null-or-equal); a different-hash loser
    matches zero rows → observed real state returned with NO RPC; a same-hash
    cross-attempt P2002 (migration-only unique submitted_tx_hash index) →
    active attempt CAS-marked needs_review/duplicate_unallocated
    (failureCode duplicate_submitted_hash) — never a 500 / permanent pending /
    second provider claim; non-P2002 errors propagate unchanged
  → receiptProvider.getTransactionReceipt (null → pending/expired; RPC error →
    retryable); receipt hash match; block timestamp; reorg detection;
    receipt_predates_attempt; status success; parseTransfer (unique canonical
    Transfer from payer → treasury for exact amount; removed/malformed/
    ambiguous → review)
  → confirmations vs chain head (getBlockNumber); below threshold →
    markConfirming (evidence-aware CAS); at/above → settleConfirmed: row-locked
    transaction (attempt → invoice), evidence re-verified under lock, a fresh
    invoice re-read REJECTS a stale quote whose persisted amount exceeds the
    current remaining balance (`stale_quote_over_remainder` → needs_review, never
    partial credit for a full payment), attempt → succeeded,
    settlementService.settleInvoice; lost race / duplicate evidence →
    needs_review/duplicate_unallocated

Worker recovery (BillingWorkerService.recoverUsdcClaims, gated by
BILLING_WORKER_ENABLED)
  → scans pending/confirming USDC attempts with a persisted canonical
    submittedTxHash whose nextCheckAt is due (bounded batch of 100 per tick)
  → re-runs the existing claim() verification path with the persisted hash
    (never re-derives or fabricates); terminal/needs_review outcomes are
    sanitized-audited; transient failures stay retryable via nextCheckAt
```

## Integration

- **Module wiring.** `BillingModule` imports `PrismaModule`, `SecurityEventModule`,
  and `ScheduleModule.forRoot()` (for the gated `BillingWorkerService`), and is
  imported by `AppModule`, `AuthModule`, `WalletModule`, and `TransactionsModule`.
  It exports `BillingService`, `BillingReconciliationService`,
  `BillingEntitlementService`, `InvoiceSettlementService`, and
  `StripePaymentService`; `UsdcPaymentService`, `BillingWorkerService`, and the
  webhook/controller services stay module-internal.
- **Consumers outside the module.**
  - `src/common/guards/api-key-auth.guard.ts` calls
    `billing.assertAndRecordApiCall` on every authenticated API-key request
    (metering failure → 503; genuine quota → 429).
  - `src/modules/auth/auth.service.ts` calls
    `billingEntitlements.assertWalletActivationAllowed` (preflight + inside the
    activation transaction) so an exhausted wallet quota never orphans a TEE
    agent wallet.
- **External dependencies.**
  - `OpenfortService.getTransactionReceipt` (sanitized receipts) in
    `billing-reconciliation.service.ts`.
  - `SUPPORTED_CHAINS` registry for chain/token resolution in
    `billing-pricing.ts`, `billing-reconciliation.service.ts`, and
    `onchain/usdc-payment.service.ts`.
  - `ConfigService` for `stripe.*` (secretKey/webhookSecret/successUrl/cancelUrl)
    and `billing.usdc.*` (enabled, per-chain treasuryAddresses/rpcUrls,
    requiredConfirmations, quoteTtlSeconds); both rails are optional and fail
    closed with 503 when unconfigured.
  - Stripe SDK (pinned `2025-03-31.basil`) and viem public clients
    (`ViemUsdcReceiptProvider`).
- **Persistence (Prisma).** `BillingAccount`, `BillingPlanVersion`,
  `BillingPlanTier`, `BillingPlanAssignment`, `BillingUsageEvent`,
  `BillingInvoice`, `BillingInvoiceLine`, `BillingPaymentAttempt`,
  `BillingReconciliationRun`, `StripeWebhookEvent` — plus `Transaction` and
  `UserWallet` reads for reconciliation and payer resolution. Key constraints:
  unique `(code, version)` plans, unique `(billingAccountId, periodStart)`
  assignments and invoices, unique `sourceKey` usage events, unique
  `(chainId, tokenAddress, txHash, logIndex)` USDC evidence, unique
  `settlementAttemptId` on invoices, and unique `stripeEventId` webhook rows.
  Worker/recovery plumbing: account-scoped reconciliation runs with
  `workerId`/`leaseExpiresAt`/`heartbeatAt`, `transactions.billingReconciledAt`/
  `billingPeriodStart`/`billingLastAttemptedAt` progress markers,
  `stripe_webhook_events` deferred-retry columns (`retryCount`, `nextRetryAt`,
  `retryOwnerId`, `retryLeaseExpiresAt`), `billing_payment_attempts`
  checkout-retry lease columns, the unique `stripeInvoiceId` renewal mapping,
  `stripeChargeKind`, and the canonical `submittedTxHash`/`nextCheckAt` USDC
  recovery columns.
- **Security scope.** All `v1/billing` dashboard routes are intentionally
  omitted from `openapi.yaml` (public spec is API-key-only) and require an
  Openfort IAM bearer token plus `FrontendOnlyGuard` origin/referer checks.
  The Stripe webhook is the only public route in the module — it is
  signature-verified from the raw body, `@Public()`, and exempt from
  throttling so Stripe retries are never rate-limited. Reconciliation and
  claim responses never expose receipt logs, calldata, RPC details, Openfort
  IDs, or secrets.

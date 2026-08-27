# Code Map for /src/modules/billing/stripe

## Responsibility
Server-side Stripe payment rail for SOFA ONE billing (Phase 3A): creates Stripe Checkout sessions for finalized invoices and applies signature-verified Stripe webhook events to local payment attempts and invoice settlement. Payment facts are **only** ever confirmed by a verified webhook — the Checkout redirect is UX only. Stripe is an optional integration: when `STRIPE_SECRET_KEY` is not configured the client is `null`, all non-payment functionality keeps working, and Stripe callers fail closed with a 503.

## Files

### stripe.constants.ts
- **Symbols**: `STRIPE_CLIENT` (DI token `Symbol('STRIPE_CLIENT')`), `STRIPE_API_VERSION` (`'2025-03-31.basil'`, pinned, sent as `Stripe-Version` header), `PENDING_SESSION_REUSE_TTL_MS` (24h, matches Stripe's default Checkout session lifetime), `STRIPE_WEBHOOK_EVENT_TYPES` (ReadonlySet of the 6 processed event types).
- **Responsibility**: Central constants for the Stripe rail — DI token, API version pin, session-reuse TTL, and the allowlist of webhook event types the service understands.
- **Dependencies**: `stripe` (SDK types only).

### stripe-client.provider.ts
- **Symbols**: `stripeClientProvider` (factory provider for `STRIPE_CLIENT`).
- **Responsibility**: Builds the pinned `Stripe` client from `stripe.secretKey`, or returns `null` when the key is absent (fail-open app, fail-closed Stripe callers).
- **Inputs**: `ConfigService` → `stripe.secretKey`.
- **Outputs**: `Stripe | null` constructed with `{ apiVersion: STRIPE_API_VERSION, typescript: true }`.
- **Dependencies**: `@nestjs/config` (`ConfigService`), `stripe`, `./stripe.constants`.

### stripe-payment.service.ts
- **Symbols**: `StripePaymentService` (`@Injectable`), `CheckoutSessionResult` (interface `{ invoiceId, sessionId, checkoutUrl }`).
- **Responsibility**: Creates (or reuses) a Stripe Checkout session for a payable invoice. Amounts, currency, user, and invoice association are always read from the database — never from the client. Only `finalized`, unpaid, positive, USD, cent-aligned invoices are payable; anything else fails closed 4xx.
- **Constructor**: `PrismaService`, `ConfigService`, `@Inject(STRIPE_CLIENT) stripe: Stripe | null`.
- **Key methods**: `createCheckoutSession(userId, invoiceId)` (public entry), `assertCheckoutEligible`, `microsToCents`, `findReusablePendingAttempt`, `createPendingAttemptOrReuseInFlight`, `markAttemptFailed`, `ensureStripeCustomer`, `toResult`.
- **Dependencies**: `@nestjs/common` (exceptions), `@nestjs/config`, `@prisma/client` (`Prisma`), `PrismaService`, `../billing.utils` (`formatUtcMonth`), `./stripe.constants`.

### stripe-webhook.controller.ts
- **Symbols**: `StripeWebhookController` (`@Controller('v1/billing/webhooks')`).
- **Responsibility**: Public Stripe webhook endpoint `POST /v1/billing/webhooks/stripe`. Intentionally NOT in `openapi.yaml` and NOT behind `OpenfortUserGuard`/`FrontendOnlyGuard`/`ApiKeyAuthGuard` — Stripe signs the payload and the service verifies it from `req.rawBody` (never re-parsed). `@SkipThrottle({ short: true, medium: true })` so Stripe retries are never rate-limited.
- **Key methods**: `handleStripe(@Req() req: RawBodyRequest<Request>)` → extracts `stripe-signature` header, forwards `req.rawBody` + signature to `StripeWebhookService.handleWebhook`, always answers `{ received: true }` on success.
- **Dependencies**: `@nestjs/common`, `@nestjs/throttler` (`SkipThrottle`), `express` (`Request`), `../../../common/decorators/public.decorator` (`Public`), `./stripe-webhook.service`.

### stripe-webhook.service.ts
- **Symbols**: `StripeWebhookService` (`@Injectable`), `PaymentTransition` (type `'succeeded' | 'failed' | null`).
- **Responsibility**: Verifies the Stripe signature and applies known events atomically and idempotently. Events are idempotent on the Stripe event id: the `StripeWebhookEvent` row and the attempt/invoice updates commit in one transaction, so a processing failure rolls back and Stripe retries without a "processed but business not updated" record. Only the explicit event set is processed; unknown events are recorded as `ignored` and answered 2xx. State only moves forward: `succeeded` is never regressed by a later failure/pending event, and `paidAt` is set at most once.
- **Constructor**: `PrismaService`, `ConfigService`, `@Inject(STRIPE_CLIENT) stripe: Stripe | null`, `InvoiceSettlementService`.
- **Key methods**: `handleWebhook(rawBody, signature)` (public entry), `recordIgnoredEvent`, `processKnownEvent`, `findAttemptForEvent`, `persistEventIds`, `resolveTransition`.
- **Dependencies**: `@nestjs/common` (exceptions), `@nestjs/config`, `@prisma/client` (`Prisma`), `PrismaService`, `../invoice-settlement.service` (`InvoiceSettlementService`), `stripe`, `./stripe.constants`.

## Design/Patterns
- **Fail-closed optional integration**: `STRIPE_CLIENT` is `Stripe | null`; both services throw `ServiceUnavailableException` when the client or required config is missing. The app must keep working without Stripe.
- **Pinned API version**: `STRIPE_API_VERSION` is asserted to `Stripe.LatestApiVersion` and sent on every request; SDK types only reflect the latest version.
- **Server-authoritative amounts**: invoice amount/currency/ownership come from the DB; success/cancel URLs come from server config only. No client-supplied pricing.
- **Single-pending-attempt invariant**: a partial unique index `billing_payment_attempts_one_pending_per_invoice_method_idx` on `(invoice_id, method) WHERE status = 'pending'` guarantees at most one visible pending Stripe attempt per invoice (USDC pending attempts coexist on the same invoice). The index is the race-safety backbone for session creation.
- **Deterministic idempotency keys**: `checkout:${attempt.id}` for session creation and `customer:${account.id}` for customer creation — a Stripe timeout/retry of the exact call returns the same object instead of duplicating it; a fresh attempt generation gets a fresh key.
- **Pending-session reuse**: a pending Stripe attempt with a persisted session id younger than the 24h TTL is reused locally (no remote fetch). A concurrent request that loses the insert race polls briefly (15 × 100ms) for the winner's session id; a clearly stale pending attempt (older than TTL, no session id) is released and replaced; a young legitimately-in-flight attempt is never disturbed — the caller gets a retryable `ConflictException`.
- **Atomic webhook idempotency**: the `StripeWebhookEvent` row (unique `stripeEventId`) and the attempt/invoice updates commit in one `$transaction`; a duplicate event id short-circuits as already-applied.
- **Forward-only transitions**: `succeeded` is never rewritten; failure applies only via a CAS `updateMany ... WHERE status = 'pending'` so a concurrent committed success can never be regressed; `paidAt` is set at most once and never cleared.
- **First-rail-wins settlement**: `InvoiceSettlementService.settleInvoice` runs inside the webhook transaction with stable row locks (attempt → invoice order, deadlock-free) and an atomic CAS `updateMany` guarded by `paidAt IS NULL AND settlementAttemptId IS NULL` plus re-checked predicates. A losing Stripe success whose invoice was settled by another attempt is recorded as `needs_review` / `duplicate_unallocated`; a precondition failure or idempotent replay is a no-op.
- **Dual-rail isolation**: every attempt lookup is scoped to `method = 'stripe'` (persisted object-id and metadata-attemptId lookups included), so a Stripe event can never resolve to a USDC attempt.
- **Signature verification on raw body**: `stripe.webhooks.constructEventAsync(req.rawBody, signature, webhookSecret)` — the body is never re-parsed, so the signature always covers the exact bytes received.
- **Safe failure extraction**: failure codes/messages are truncated (80/500 chars) and never include secrets or full payloads; metadata values are UUID-format-validated before any DB query so malformed/malicious metadata yields "ignored", never a 500.

## Flow

### Checkout session creation
1. `BillingController.checkoutInvoice` (`POST /v1/billing/invoices/:id/checkout`, `OpenfortUserGuard` + `FrontendOnlyGuard`) → `StripePaymentService.createCheckoutSession(userId, invoiceId)`.
2. Fail closed 503 if `STRIPE_CLIENT` is null or success/cancel URLs are unset; 404 if the account or the user-owned invoice is missing.
3. `assertCheckoutEligible`: invoice must be `finalized`, unpaid, `USD`, `totalMicros > 0`, and cent-aligned (micros % 10,000 == 0) — else 4xx.
4. Reuse path: `findReusablePendingAttempt` returns a pending Stripe attempt with persisted session id + checkout URL younger than the TTL → return `{ invoiceId, sessionId, checkoutUrl }`.
5. Otherwise `createPendingAttemptOrReuseInFlight` inserts a pending attempt (P2002 race → poll/reuse/release-stale as described above).
6. `ensureStripeCustomer` returns the account's `stripeCustomerId`, creating the Customer once with idempotency key `customer:${account.id}` and persisting it (unique column absorbs the concurrent-persist race).
7. `stripe.checkout.sessions.create` with `mode: 'payment'`, one line item (`SOFA ONE — {period} invoice`, `unit_amount` = cents), server-configured success/cancel URLs, metadata `{ invoiceId, attemptId, period }`, `payment_intent_data.metadata`, `client_reference_id: invoice.id`, and idempotency key `checkout:${attempt.id}`.
8. Persist `stripeCheckoutSessionId`, `stripePaymentIntentId`, `checkoutUrl` on the attempt; return the result. On any Stripe/DB failure, `markAttemptFailed` (pending-only CAS) releases the pending slot so future retries are not blocked, then rethrows.

### Webhook processing
1. Stripe POSTs to `/v1/billing/webhooks/stripe`; controller passes `req.rawBody` + `stripe-signature` to `StripeWebhookService.handleWebhook`.
2. Fail closed 503 if webhook secret/client missing; 400 for missing body or signature; 400 for signature/parse failure (no side effects).
3. Unknown event type → `recordIgnoredEvent` (status `ignored`, idempotent on event id) → 2xx.
4. Known event → `processKnownEvent` in one transaction:
   a. Insert `StripeWebhookEvent` row (status `processed`); P2002 → already applied, return.
   b. `findAttemptForEvent` locates the local attempt in order: persisted object id (Checkout Session / PaymentIntent id) → verified metadata (`attemptId`, then `invoiceId` for the most recent pending Stripe attempt) → `client_reference_id` (Checkout only). No match → row marked `ignored`, 2xx, no business change.
   c. `persistEventIds` stores the actual PI/session id when the attempt was found via metadata/fallback, so later events resolve by id (out-of-order delivery converges).
   d. `resolveTransition`: `checkout.session.completed` succeeds only when `payment_status === 'paid'`; async success / `payment_intent.succeeded` → `succeeded`; async failure / `payment_intent.payment_failed` → `failed`; `payment_intent.processing` and unpaid completions → `null` (no-op).
   e. `succeeded`: mark attempt succeeded (forward-only), then `settleInvoice(tx, { id, invoiceId, method: 'stripe' })` — first-rail-wins; a lost race to a different attempt marks this attempt `needs_review` / `duplicate_unallocated`.
   f. `failed`: CAS `updateMany WHERE id AND status = 'pending'` → `failed` with truncated `last_payment_error` details; a `succeeded` attempt is never regressed.

## Integration
- **Wired in** `src/modules/billing/billing.module.ts`: `controllers: [BillingController, StripeWebhookController, UsdcPaymentController]`; `providers` include `StripePaymentService`, `StripeWebhookService`, `stripeClientProvider`; `exports` include `StripePaymentService`. `BillingModule` imports `PrismaModule` (global `PrismaService`).
- **Entry points**: Checkout is exposed only via `BillingController` (`POST /v1/billing/invoices/:id/checkout`, frontend-only, Openfort IAM bearer + `FrontendOnlyGuard`); the webhook endpoint is `@Public()` and throttle-skipped. Neither route is part of `openapi.yaml` (public API-key spec).
- **Config** (`src/config/configuration.ts` → `stripe.*`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`.
- **Data model** (`prisma/schema.prisma`): `BillingAccount.stripeCustomerId` (unique); `BillingInvoice.paidAt`/`paidVia`/`settlementAttemptId` (unique, `onDelete: SetNull`); `BillingPaymentAttempt` with unique `stripeCheckoutSessionId`/`stripePaymentIntentId`, `checkoutUrl`, failure fields, and the partial unique pending index; `StripeWebhookEvent` with unique `stripeEventId` and `status` enum `processed | ignored`.
- **Shared settlement boundary**: `InvoiceSettlementService` (sibling in `billing/`) is the single atomic settlement path shared with the future USDC rail; the Stripe webhook passes its interactive transaction client.
- **Consumers**: `BillingController` (checkout route); `BillingModule` exports `StripePaymentService` for other modules. The webhook service is internal to the module.
- **Tests**: `stripe-payment.service.spec.ts`, `stripe-webhook.service.spec.ts`, `stripe-webhook.controller.spec.ts` (not part of this map).
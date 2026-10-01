# src/modules/billing/dto/

Request DTOs for the frontend-only billing routes. These are the only inputs
accepted by `BillingController` (`@Controller('v1/billing')`); each maps to
exactly one controller route and then to one service call.

## Responsibility

Declare and validate the request payloads/query parameters for the
dashboard-only billing endpoints:

| File | Exported symbol | Binds to route | Consumed by |
| --- | --- | --- | --- |
| `assign-plan-body.dto.ts` | `AssignPlanBodyDto` | `POST /v1/billing/plan` | `billingService.assignPlan(userId, body.planCode)` |
| `get-summary-query.dto.ts` | `GetSummaryQueryDto` | `GET /v1/billing/summary?period=` | `billingService.getSummary(userId, query.period)` |
| `list-invoices-query.dto.ts` | `ListInvoicesQueryDto` | `GET /v1/billing/invoices?page=&limit=` | `billingService.listInvoices(userId, { page, limit })` |
| `reconcile-body.dto.ts` | `ReconcileBodyDto` | `POST /v1/billing/reconcile` | `billingReconciliationService.reconcile(userId, { limit })` |
| `create-subscription-checkout.dto.ts` | `CreateSubscriptionCheckoutDto` | `POST /v1/billing/invoices/:id/subscription-checkout` | `stripePaymentService.createSubscriptionCheckout(userId, id, body.planVersionId)` |

All routes are gated by `OpenfortUserGuard` + `FrontendOnlyGuard` (see
`billing.controller.ts`), so these DTOs never validate API-key requests.

## Design/Patterns

- **class-validator decorators + global ValidationPipe.** Classes use
  `@IsString()/@IsNotEmpty()/@IsInt()/@Min()/@Max()/@IsOptional()/@Matches()`.
  The app-wide `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`,
  `transform: true` in `src/main.ts`) means unknown fields are rejected with
  400, not silently dropped — e.g. a client cannot smuggle `userId`,
  `effectiveFrom`, or an admin bypass into `AssignPlanBodyDto`.
- **No client-controlled business state.** `AssignPlanBodyDto` accepts only
  `planCode`; the effective period is always the next UTC month, never
  client-supplied. `ReconcileBodyDto` caps its scan at 200 ledger events.
  `CreateSubscriptionCheckoutDto` accepts only a `planVersionId` UUID — the
  plan must exactly match the owned invoice's plan, never a caller-selected
  different plan.
- **Query DTOs are optional with defaults.** `ListInvoicesQueryDto` defaults to
  `page = 1`, `limit = 20` and uses `@Type(() => Number)` so query-string
  strings are transformed to integers before `@IsInt()` validation.
- **Minimal surface.** These are flat, single-purpose validation classes with
  no inheritance, no factory helpers, and no relationships to each other.

## Flow

```
HTTP request
  → BillingController route handler
      → @Body() / @Query() DTO instance (validation via global ValidationPipe)
      → service method (userId comes from @CurrentUser('id'), not the DTO)
```

Per DTO:

- `AssignPlanBodyDto` → `POST /v1/billing/plan`
  input `{ planCode: string }` (required, non-empty string) →
  `billingService.assignPlan(userId, planCode)` → `AssignPlanResult` (next
  UTC-month plan change + future-period invoice create/update).
- `GetSummaryQueryDto` → `GET /v1/billing/summary`
  input `{ period?: string }` (optional, must match `YYYY-MM`) →
  `billingService.getSummary(userId, period?)` → `BillingSummaryDto`. Omitted
  period means "current month" server-side.
- `ListInvoicesQueryDto` → `GET /v1/billing/invoices`
  input `{ page?: number = 1, limit?: number = 20 }` (`page ≥ 1`, `1 ≤ limit ≤
  100`) → `billingService.listInvoices(userId, { page, limit })` →
  `BillingInvoiceDto[]` result set.
- `ReconcileBodyDto` → `POST /v1/billing/reconcile`
  input `{ limit?: number }` (`1 ≤ limit ≤ 200`) →
  `billingReconciliationService.reconcile(userId, { limit })` →
  `ReconcileResult` scan statistics. Receipt logs/calldata/secrets are never
  exposed.
- `CreateSubscriptionCheckoutDto` → `POST /v1/billing/invoices/:id/subscription-checkout`
  input `{ planVersionId: UUID }` (required) →
  `stripePaymentService.createSubscriptionCheckout(userId, id, planVersionId)` →
  `CheckoutSessionResult` (`{ invoiceId, sessionId, checkoutUrl }`) for a
  recurring fixed-fee `mode: 'subscription'` Checkout session.

## Integration

- **Only consumer:** `src/modules/billing/billing.controller.ts` imports all
  five DTO classes and uses them on `@Body()`/`@Query()` parameters. No other
  module imports from `dto/`.
- **Validation boundary:** depends on the global `ValidationPipe` configured in
  `src/main.ts`; DTOs carry only class-validator metadata (class-transformer
  `@Type()` for integer coercion).
- **Downstream targets:** `BillingService` (`getSummary`, `listInvoices`,
  `assignPlan`), `BillingReconciliationService` (`reconcile`), and
  `StripePaymentService` (`createSubscriptionCheckout`); all in
  `src/modules/billing/`.
- **Security scope:** these endpoints are intentionally omitted from
  `openapi.yaml` (public spec is API-key-only). They require an Openfort IAM
  bearer token plus `FrontendOnlyGuard` origin/referer checks. User identity is
  derived from the authenticated session (`@CurrentUser('id')`), never from the
  request body/query.

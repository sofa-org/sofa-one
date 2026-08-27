# src/modules/billing/onchain/dto/

## Responsibility

Request-body DTOs for the dashboard-only native USDC invoice payment flow
(`UsdcPaymentController`). This folder defines the **only** client-supplied
inputs for the two USDC endpoints:

- `UsdcQuoteDto` — optional chain selector for `POST /v1/billing/invoices/:id/usdc/quote`.
- `UsdcClaimDto` — `{ paymentAttemptId, txHash }` for `POST /v1/billing/invoices/:id/usdc/claim`.

The DTOs deliberately expose a minimal surface: every payment fact (token,
treasury, RPC, decimals, amount, payer, chain, confirmations) is derived
server-side from the attempt's quote snapshot, never accepted from the client.

## Design / Patterns

- **class-validator DTO-as-contract**: each class carries validation decorators
  (`@IsUUID`, `@Matches`, `@IsInt`, `@IsOptional`) that run inside the global
  `ValidationPipe`.
- **Whitelist enforcement**: the global pipe (`whitelist: true`,
  `forbidNonWhitelisted: true`, `transform: true` in `src/app.module.ts`)
  rejects any field not declared on the DTO with a 400 — unknown fields are
  never silently stripped.
- **Module-private regex constant**: `TX_HASH_REGEX` (`/^0x[0-9a-fA-F]{64}$/`)
  pins the transaction-hash shape to exactly 32 bytes (64 hex chars) after the
  `0x` prefix; the `@Matches` message surfaces a readable validation error.
- **Optional verified selector**: `chainId` is optional and only an integer;
  the server validates it against the USDC billing chain allowlist and
  per-chain configuration before use.

## Flow

1. `POST /v1/billing/invoices/:id/usdc/quote`
   - `@Body()` is parsed/validated as `UsdcQuoteDto`.
   - `body.chainId` (may be `undefined`) is forwarded to
     `UsdcPaymentService.quote(userId, id, body.chainId)`.
2. `POST /v1/billing/invoices/:id/usdc/claim`
   - `@Body()` is parsed/validated as `UsdcClaimDto`.
   - The whole DTO is forwarded to `UsdcPaymentService.claim(userId, id, body)`,
     which verifies `txHash` against the attempt's server-side quote snapshot
     and advances the payment lifecycle.

Both routes are guarded by `OpenfortUserGuard` + `FrontendOnlyGuard`; the claim
route additionally carries a tight route-level `@Throttle` (5/60s, 20/3600s)
because it performs RPC lookups.

## Integration

- **Files**
  - `usdc-quote.dto.ts` — exports `UsdcQuoteDto` (`chainId?: number`).
  - `usdc-claim.dto.ts` — exports `UsdcClaimDto` (`paymentAttemptId: string`,
    `txHash: string`) and the module-private `TX_HASH_REGEX`.
- **Key symbols / inputs / outputs**
  - `UsdcQuoteDto`: input `{ chainId?: number }` → validated output
    `{ chainId?: number }` (absent when not supplied).
  - `UsdcClaimDto`: input `{ paymentAttemptId: UUID, txHash: 0x + 64 hex }` →
    validated output of the same shape.
- **Dependencies**
  - `class-validator` (`IsUUID`, `Matches`, `IsInt`, `IsOptional`).
  - Global `ValidationPipe` in `src/app.module.ts` (whitelist +
    forbidNonWhitelisted + transform).
  - Consumed by `UsdcPaymentController` (`src/modules/billing/onchain/usdc-payment.controller.ts`),
    which passes values into `UsdcPaymentService` (`usdc-payment.service.ts`).
- **Boundaries**: these DTOs are used only by dashboard/frontend-only routes and
  are intentionally absent from the public API-key spec (`openapi.yaml`). No
  API-key-authenticated path accepts them.
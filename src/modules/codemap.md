# Code Map for /src/modules

Parent map for the feature-module container. Each row links to the detailed map of the corresponding feature subtree; this file aggregates module responsibilities, dependency direction, key end-to-end flows, and access boundaries. It does not replace any child map.

## Responsibility

`src/modules/` is the feature-module container for the SOFA ONE backend. It holds the domain modules that implement authentication/onboarding, API-key lifecycle, wallet operations, transaction submission, billing, security telemetry, and the runtime policy gates that protect high-privilege execution. Each module is a standard NestJS feature module (controller + service + DTOs) that delegates to core infrastructure (`PrismaService`, `OpenfortService`) and shared guards/decorators from `src/common`.

The container is organized around three concerns:
- **Identity & access**: `auth`, `api-key`, `mfa`, `step-up`.
- **Asset operations**: `wallet`, `transactions`, `session-key`, `eoa-execution`.
- **Commercial & security cross-cutting**: `billing`, `security-events`, `security-notifications`, `health`.

## Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `auth/` | Openfort IAM session sync, embedded-wallet authorization/activation, Calibur agent-key registration lifecycle, API-key refresh, login-IP telemetry | [View Map](auth/codemap.md) |
| `auth/dto/` | Validated bodies for embedded-wallet authorize + agent registration endpoints | [View Map](auth/dto/codemap.md) |
| `api-key/` | Dashboard-only API-key lifecycle (create/list/revoke/rotate), Argon2id hashing, permissions, spend limits, allowlists, dual audit | [View Map](api-key/codemap.md) |
| `api-key/dto/` | Validated create-API-key request shape + permission/spend-limit sub-objects | [View Map](api-key/dto/codemap.md) |
| `wallet/` | Wallet queries, API-key signing (EIP-191/712), withdrawal-address allowlist, USDC withdrawal policy + Calibur user-op submission, freeze enforcement | [View Map](wallet/codemap.md) |
| `wallet-provisioning-recovery/` | Operator-only CLI support for binding an already-created provider account to a matching provisioning intent; no HTTP route or create retry/reset | [View Map](wallet-provisioning-recovery/codemap.md) |
| `wallet/dto/` | Validated sign/withdraw/withdrawal-address/signing-request DTOs + amount bounds | [View Map](wallet/dto/codemap.md) |
| `transactions/` | Public send/status API + dashboard history; policy + simulation preflight, idempotency, Openfort submission, safe response shaping | [View Map](transactions/codemap.md) |
| `defi/` | Exact function-level capability catalog, explicit grant validation, persistent pause overlay, generic-send authorization; simplified target assembly/validation pending | [View Map](defi/codemap.md) |
| `transactions/dto/` | Send-transaction + list-transactions validation DTOs and shared interaction constants | [View Map](transactions/dto/codemap.md) |
| `billing/` | Plan catalog, usage metering, quota enforcement, invoice list/detail/payment-status, Stripe + native USDC checkout and pay-from-wallet, reconciliation | [View Map](billing/codemap.md) |
| `billing/dto/` | Validated bodies for the five dashboard billing routes (including subscription checkout) | [View Map](billing/dto/codemap.md) |
| `billing/stripe/` | Stripe Checkout rail: client provider, payment service, signature-verified webhook | [View Map](billing/stripe/codemap.md) |
| `billing/onchain/` | Native USDC invoice payment rail: quote/claim + strict receipt verification | [View Map](billing/onchain/codemap.md) |
| `billing/onchain/dto/` | USDC quote/claim request DTOs | [View Map](billing/onchain/dto/codemap.md) |
| `mfa/` | TOTP MFA lifecycle (setup/enable/verify/disable), recovery codes, proof issuance | [View Map](mfa/codemap.md) |
| `mfa/dto/` | TOTP/recovery-code request validation | [View Map](mfa/dto/codemap.md) |
| `step-up/` | Short-lived step-up proof issuance/validation (no controller/DTOs) | [View Map](step-up/codemap.md) |
| `session-key/` | On-chain Calibur session-key policy gate for `session_key` execution mode | [View Map](session-key/codemap.md) |
| `eoa-execution/` | Runtime isolation policy for privileged backend EOA execution | [View Map](eoa-execution/codemap.md) |
| `security-events/` | Unified security-event write path, risk scoring, risk evaluation/enforcement, SIEM export | [View Map](security-events/codemap.md) |
| `security-notifications/` | Dashboard security alerts projected from selected security events | [View Map](security-notifications/codemap.md) |
| `health/` | Liveness/readiness probes (`GET /health/live`, `GET /health/ready`; ready checks DB via `SELECT 1`) | [View Map](health/codemap.md) |

## Design/Patterns

- **Standard NestJS feature modules.** Controller/service split per domain; controllers own routing, guard composition, and route-level throttles; services own business logic; `dto/` subfolders own class-validator request shapes validated by the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- **Policy services isolate security rules.** High-risk rules live in dedicated services rather than controllers: `SigningPolicyService`/`WithdrawalPolicyService` (wallet), `TransactionPolicyService`/`TransactionSimulationService` (transactions), `EoaExecutionPolicyService` (eoa-execution), `SessionKeyPolicyService` (session-key), `SecurityRiskService`/`RiskEvaluationService` (security-events). Each records `SecurityEvent` telemetry for allowed/denied/high-value/lifecycle decisions.
- **Execution-mode strategy.** `session_key` (default) signs/submits via the Calibur agent key (on-chain verified by `SessionKeyPolicyService`, wrapped as ABI-encoded `(keyHash, signature, hookData)`); `eoa` uses the backend EOA gated by `EoaExecutionPolicyService`. Both are defense-in-depth gates that run after API-key permission checks but before wallet loading or Openfort submission.
- **Optional dependency injection for defense-in-depth.** `EoaExecutionPolicyService`, `SessionKeyPolicyService`, `RiskEvaluationService`, `RequestContextService`, and `SecurityEventService` are injected `@Optional()` in consumers and degrade explicitly (e.g. EOA mode throws `ForbiddenException` if the policy service is missing; risk evaluation is skipped if absent). Fail-closed, never fail-open.
- **Idempotency + atomicity.** Transactions keyed on `[userId, operationType, chainId, idempotencyKey]` plus a `requestHash` (SHA-256 of a stable-serialized request); Prisma `$transaction` with `SELECT ... FOR UPDATE` row locks close races (withdrawal daily-limit, billing settlement). P2002 races return the existing row rather than resubmitting.
- **Bigint microdollar accounting (billing).** All monetary math is bigint microdollars; pure pricing/calculator modules; JSON-safe serialization (no BigInt leaks); billing-period advisory lock seam serializes all writers for an account+period.
- **Dual audit (api-key).** Every lifecycle event writes both a legacy `ApiKeyEvent` row and a unified `SecurityEvent` in the same transaction.
- **Fail-closed optional integrations.** Stripe and USDC rails are optional; unconfigured rails fail closed with 503 while the rest of the app keeps working.

## Flow

### Onboarding & agent-key registration (auth)
`POST /auth/session` → sync Openfort IAM session into `User` + pending wallet (P2002-tolerant) → `POST /auth/embedded-wallet/authorize` verifies the embedded EOA, runs billing quota preflight, ensures/reuses the TEE agent wallet, activates the `UserWallet`, and upserts a `registration_required` chain authorization → `POST /auth/embedded-wallet/registration-transaction` stores the `registerKey` tx hash (`pending_registration`) → `POST /auth/embedded-wallet/registration-result` verifies on-chain (Calibur delegation + key registered) before persisting `registered`. `GET /auth/me` self-heals stale pending registrations.

### API-key signing (public, API-key only)
`POST /v1/wallets/sign` → `ApiKeyAuthGuard` + `ApiKeyPermissionGuard` (`canSign`) → `DefiPolicyService.authorizeSigning` denies all with `DEFI_FUNCTION_NOT_ALLOWED` before hashing, SigningRequest creation, or Openfort. Typed-data capability remains disabled; dedicated withdrawal and billing-payment paths are independent.

### Transaction send (public, API-key only)
`POST /v1/transactions/send` → auth/permission, EOA and generic safety gates, risk/wallet/session-key readiness → outer idempotency lookup (hit returns existing response without replay) → on miss, `DefiPolicyService` checks catalog function, explicit grant, pause, and canonical ABI → destination protection → billing and simulation → final create-time recheck under destination → pause SHARE → API-key UPDATE locks at READ COMMITTED → insert/send. DeFi denial precedes simulation, `Transaction` creation and Openfort. DeFi ABI arguments remain caller-controlled; destination protection and billing can still reject otherwise granted calls. Dedicated withdrawals and billing payments are not blanket-gated.

### Withdrawal (dashboard-only, step-up)
`POST /v1/wallets/withdraw` → `OpenfortUserGuard` + `FrontendOnlyGuard` + `StepUpGuard` → wallet frozen/active/chain checks → `WithdrawalPolicyService` (single/daily limits, address allowlist + cooldown, high-value telemetry) → `RiskEvaluationService` → idempotency + on-chain balance pre-check → row-locked daily-limit check → create `Transaction` → `OpenfortService.sendUserOperation` (Calibur agent user op).

### Dashboard reads
`GET /v1/wallets/signing-requests` and `GET /v1/wallets/signing-requests/:id` provide ownership-scoped signing-request list and detail; dashboard transaction history uses `GET /v1/transactions` and `GET /v1/transactions/:id/detail`. Billing dashboard routes include `GET /v1/billing/invoices/:id`, `GET /v1/billing/invoices/:id/payment-status`, and `POST /v1/billing/usdc/pay-from-wallet` (plus `GET /v1/billing/usdc/payment-status`). These routes remain IAM + `FrontendOnlyGuard` protected.

### Billing (dashboard-only + public webhook)
API-key requests meter via `ApiKeyAuthGuard.recordApiCallUsage` → `billing.assertAndRecordApiCall` (429 on quota). Wallet reservation and activation quota/peak tracking use `BillingWalletLifecycleService` under the billing-account row lock. Outbound transfers are receipt-confirmed by `BillingReconciliationService`. Invoices finalize after period end + 24h grace; payment via Stripe Checkout (signature-verified webhook) or native USDC (quote/claim with strict receipt verification); both settle through the shared first-rail-wins `InvoiceSettlementService.settleInvoice`.

### Security telemetry fanout
`SecurityEventService.record()` is the single write path for `security_events`: risk-scored by `SecurityRiskService`, fanned out to dashboard `SecurityNotification` rows, and optionally exported to a redacted SIEM webhook. `RiskEvaluationService.evaluateRisk()` runs before high-risk operations and enforces block/freeze/step-up actions.

## Integration

- **Imported by `AppModule`** (root composition); `BillingModule` is additionally imported by `AuthModule`, `WalletModule`, and `TransactionsModule`.
- **Shared core services.** All modules depend on `PrismaService` (`src/core/database`) and `OpenfortService` (`src/core/openfort`) for persistence and TEE signing/submission.
- **Shared guards/decorators** from `src/common`: `OpenfortAuthGuard`, `OpenfortUserGuard`, `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `FrontendOnlyGuard`, `StepUpGuard`, `@CurrentUser`, `@Public`, `@FrontendOnly`, `@RequireStepUp`, `@RequireApiKeyPermission`.
- **Cross-module dependency direction (policy gates):**
  - `DefiModule` is a leaf imported by `ApiKeyModule`, `TransactionsModule`, and `WalletModule`; it imports `SecurityEventModule` and uses globally available Prisma.
  - `WalletModule` and `TransactionsModule` import `EoaExecutionModule`, `SessionKeyModule`, `SecurityEventModule`, `StepUpModule`, `BillingModule`.
  - `AuthModule` imports `ApiKeyModule` (rotate), `SecurityEventModule`, `StepUpModule`, `BillingModule`.
  - `ApiKeyModule` imports `StepUpModule` + `SecurityEventModule`.
  - `MfaModule` imports `StepUpModule`; `StepUpModule` is imported by `MfaModule`, `AuthModule`, `ApiKeyModule`, `WalletModule`.
  - `SecurityEventModule` imports `SecurityNotificationModule` and `RequestContextModule`; `EoaExecutionModule` and `SessionKeyModule` import `SecurityEventModule`.
- **Shared common helpers:** `getSupportedChain` (`common/chains/supported-chains`), `hashRequest` (`common/utils/request-hash`), `sanitizeErrorMessage` (`common/utils/sanitize`), `AgentStatus` (`common/agent/agent-status`), `getApiKeyPrefix` (`common/api-key/api-key-prefix`), `isIpOrCidr` (`common/utils/ip-cidr`), Calibur helpers (`common/calibur`).
- **Data model** (`prisma/schema.prisma`): `User`, `UserWallet`, `WalletChainAuthorization`, `UserKnownIp`, `ApiKey`, `ApiKeyEvent`, `SigningRequest`, `Transaction`, `WithdrawalPolicy`, `WithdrawalAddress`, `SecurityEvent`, `SecurityNotification`, `StepUpChallenge`, `UserMfaTotpCredential`, `UserMfaTotpRecoveryCode`, and the `Billing*` models.

## Access Boundaries

- **Public API-key routes** (documented in `openapi.yaml`): `POST /v1/wallets/sign`, `POST /v1/transactions/send`, `GET /v1/transactions/:id`. These require `X-API-Key` (`ApiKeyAuthGuard` + `ApiKeyPermissionGuard`); Openfort IAM tokens are not accepted, and API-key management is never callable by API keys.
- **Frontend-only routes** (intentionally omitted from `openapi.yaml`): all `/v1/api-keys/*`, `/v1/wallets/balances`, `/v1/wallets/deposit-info`, `/v1/wallets/withdraw`, `/v1/wallets/withdrawal-addresses`, `/v1/wallets/signing-requests`, `/v1/transactions`, `/v1/transactions/:id/detail`, `/v1/billing/*`, `/v1/security-notifications`, `/v1/auth/mfa/*`. They require an Openfort IAM bearer token (`OpenfortUserGuard`) plus `FrontendOnlyGuard` origin/referer checks.
- **Step-up protected** (`StepUpGuard` + `@RequireStepUp()`, `X-Step-Up-Token`): `POST /auth/refresh-api-key`, all `/v1/api-keys` mutations, `POST /v1/wallets/withdraw`, and `POST/DELETE /v1/wallets/withdrawal-addresses`.
- **Public unauthenticated routes:** `GET /health/live`, `GET /health/ready` (`@Public()`), and `POST /v1/billing/webhooks/stripe` (signature-verified from `req.rawBody`, `@Public()`, throttle-skipped).
- **Freeze enforcement:** frozen users rejected by `OpenfortUserGuard`/`ApiKeyAuthGuard`; frozen API keys rejected by `ApiKeyAuthGuard`; frozen wallets rejected by `WalletService.assertWalletNotFrozen` before any query result or signing/withdrawal side effect.
- **Safe response shaping:** public transaction status and signing-request responses never expose calldata, `requestHash`, `interactionsHash`, digests, or secrets; billing/claim/reconciliation responses never expose receipt logs, calldata, RPC details, Openfort IDs, or secrets.

# Code Map for /src/modules

Parent map for the feature-module container. Each row links to the detailed map of the corresponding feature subtree; this file aggregates module responsibilities, dependency direction, key end-to-end flows, and access boundaries. It does not replace any child map.

## Responsibility

`src/modules/` is the feature-module container for the SOFA ONE backend. It holds the domain modules that implement authentication/onboarding, API-key lifecycle, wallet operations, transaction submission, billing, security telemetry, and the runtime policy gates that protect high-privilege execution. Each module is a standard NestJS feature module (controller + service + DTOs) that delegates to core infrastructure (`PrismaService`, `OpenfortService`) and shared guards/decorators from `src/common`.

The container is organized around three concerns:
- **Identity & access**: app-session, auth, api-key, mfa, step-up.
- **Asset operations**: `wallet`, `transactions`, `session-key`, `eoa-execution`.
- **Commercial & security cross-cutting**: `billing`, `security-events`, `security-notifications`, `health`.

## Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `auth/` | Openfort IAM session sync, embedded-wallet authorization/activation, Calibur agent-key registration lifecycle, API-key refresh, login-IP telemetry | [View Map](auth/codemap.md) |
| `app-session/` | Global opaque cookie sessions, hash-only persistence, Origin/CSRF checks, pending/full MFA, fixed expiry and current/all-session revocation | [Service](app-session/app-session.service.ts) |
| `auth/dto/` | Validated bodies for embedded-wallet authorize + agent registration endpoints | [View Map](auth/dto/codemap.md) |
| `api-key/` | Dashboard-only API-key lifecycle (create/list/revoke/rotate), Argon2id hashing, permissions, spend limits, allowlists, dual audit | [View Map](api-key/codemap.md) |
| `api-key/dto/` | Validated create-API-key request shape + permission/spend-limit sub-objects | [View Map](api-key/dto/codemap.md) |
| `wallet/` | Wallet queries, API-key signing (EIP-191/712), withdrawal-address allowlist, USDC withdrawal policy + Calibur user-op submission, freeze enforcement | [View Map](wallet/codemap.md) |
| `wallet-provisioning-recovery/` | Operator-only CLI support for binding an already-created provider account to a matching provisioning intent; no HTTP route or create retry/reset | [View Map](wallet-provisioning-recovery/codemap.md) |
| `wallet/dto/` | Validated sign/withdraw/withdrawal-address/signing-request DTOs + amount bounds | [View Map](wallet/dto/codemap.md) |
| `transactions/` | Public send/status API + dashboard history; policy + simulation preflight, idempotency, Openfort submission, safe response shaping | [View Map](transactions/codemap.md) |
| `defi/` | Exact function-level catalog, all/custom API-key capability authorization, persistent pause overlay, finite scoped execution, static profiles; current v4 catalog has 368 definitions (345 actions, 23 independent approvals), preserving v3 and adding 19 source-qualified functions; M4 is locally uncommitted and the market objective remains false | [View Map](defi/codemap.md) |
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
- **Execution-mode strategy.** Transaction sending defaults to `session_key`: live on-chain key checks precede Calibur UserOperation submission, while optional `eoa` execution is gated by `EoaExecutionPolicyService`. The separate public signing endpoint accepts only approved Polymarket typed data in EOA mode (also its default); it does not expose session-key signatures.
- **Required operation policies.** Wallet signing/withdrawal and transaction services require their core EOA, signing, risk, simulation and request-context dependencies; transaction sending additionally requires the session-key gate. Missing policy wiring fails startup. Existing optional audit/notification/export integrations retain fault isolation without permitting operation-policy bypass.
- **Idempotency + atomicity.** Transactions keyed on `[userId, operationType, chainId, idempotencyKey]` plus a `requestHash` (SHA-256 of a stable-serialized request); Prisma `$transaction` with `SELECT ... FOR UPDATE` row locks close races (withdrawal daily-limit, billing settlement). P2002 races return the existing row rather than resubmitting.
- **Bigint microdollar accounting (billing).** All monetary math is bigint microdollars; pure pricing/calculator modules; JSON-safe serialization (no BigInt leaks); billing-period advisory lock seam serializes all writers for an account+period.
- **Dual audit (api-key).** Every lifecycle event writes both a legacy `ApiKeyEvent` row and a unified `SecurityEvent` in the same transaction.
- **Fail-closed optional integrations.** Stripe and USDC rails are optional; unconfigured rails fail closed with 503 while the rest of the app keeps working.

## Flow

### Onboarding & agent-key registration (auth)
Login exchange syncs the existing Openfort user/pending wallet and returns a pending local session; TOTP verification upgrades that exact session. Full local MFA plus fresh matching IAM proof authorizes an embedded EOA through existing quota/single-dispatch provisioning. Registration methods use local identity; GET /auth/me remains wallet reconciliation, separate from provider-independent GET /auth/session.

### API-key signing (public, API-key only)
`POST /v1/wallets/sign` → API-key `canSign` permission → only exact Polymarket ClobAuth typed-data bootstrap on Polygon 137 in EOA mode is eligible; requires `canUseEoaExecution` and either all capability mode or custom membership of `polymarket:137:clob-auth:v1`. General message/typed-data signing remains denied; dedicated withdrawal and billing-payment paths are independent.

### Transaction send (public, API-key only)
`POST /v1/transactions` → auth/permission, EOA and generic safety gates, risk/wallet/session-key readiness → outer idempotency lookup (hit returns existing response without replay) → on miss, `DefiPolicyService` checks catalog function, current all/custom capability membership, pause, and canonical ABI → destination protection → billing and simulation → final create-time recheck under destination → pause SHARE → API-key UPDATE locks at READ COMMITTED → insert/send. DeFi denial precedes simulation, `Transaction` creation and Openfort. DeFi ABI arguments remain caller-controlled; destination protection and billing can still reject otherwise authorized calls. Dedicated withdrawals and billing payments are not blanket-gated.

### Withdrawal (dashboard-only, step-up)
`POST /wallets/withdrawals` → AppSessionGuard + FrontendOnlyGuard + exact-session StepUpGuard → existing wallet/freeze/chain/withdrawal-policy/risk/idempotency checks → Calibur agent user operation. Unsafe cookie requests require trusted Origin/CSRF.

### Dashboard reads
Dashboard wallet/history/billing/notifications reads require full local MFA plus FrontendOnlyGuard; ordinary authentication does not call Openfort.

### Billing (dashboard-only + public webhook)
API-key requests meter via `ApiKeyAuthGuard.recordApiCallUsage` → `billing.assertAndRecordApiCall` (429 on quota). Wallet reservation and activation quota/peak tracking use `BillingWalletLifecycleService` under the billing-account row lock. Outbound transfers are receipt-confirmed by `BillingReconciliationService`. Invoices finalize after period end + 24h grace; payment via Stripe Checkout (signature-verified webhook) or native USDC (quote/claim with strict receipt verification); both settle through the shared first-rail-wins `InvoiceSettlementService.settleInvoice`.

### Security telemetry fanout
`SecurityEventService.record()` is the single write path for `security_events`: risk-scored by `SecurityRiskService`, fanned out to dashboard `SecurityNotification` rows, and optionally exported to a redacted SIEM webhook. `RiskEvaluationService.evaluateRisk()` runs before high-risk operations and enforces block/freeze/step-up actions.

## Integration

- **Imported by `AppModule`** (root composition); `BillingModule` is additionally imported by `AuthModule`, `WalletModule`, and `TransactionsModule`.
- **Shared core services.** All modules depend on `PrismaService` (`src/core/database`) and `OpenfortService` (`src/core/openfort`) for persistence and TEE signing/submission.
- **Shared guards**: AppSessionGuard, OpenfortAuthGuard (explicit provider proof), ApiKeyAuthGuard, ApiKeyPermissionGuard, FrontendOnlyGuard and StepUpGuard. AllowPendingMfa marks only session/MFA bootstrap.
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

- **Public API-key routes** (documented in `openapi.yaml`): `POST /v1/wallets/sign`, `POST /v1/transactions`, `GET /v1/transactions/:id`, `GET /v1/wallets`, plus read-only `/v1/permissions` and `/v1/capabilities`. Protected transaction/signing routes use `X-API-Key` (`ApiKeyAuthGuard` + `ApiKeyPermissionGuard`); Openfort IAM tokens are not accepted, and API-key management is never callable by API keys.
- **Frontend-only routes** remain omitted from public OpenAPI. AppSessionGuard authenticates cookie sessions, FrontendOnlyGuard checks allowed browser origin/referer, unsafe methods require CSRF, and sensitive methods add exact-session step-up.
- **Step-up protected** (`StepUpGuard` + `@RequireStepUp()`, `X-Step-Up-Token`): `POST /api-keys/rotations`, all `/api-keys` mutations, `POST /wallets/withdrawals`, and `POST/DELETE /wallets/withdrawal-addresses`.
- **Public unauthenticated routes:** `GET /health/live`, `GET /health/ready` (`@Public()`), and `POST /v1/billing/webhooks/stripe` (signature-verified from `req.rawBody`, `@Public()`, throttle-skipped).
- **Freeze enforcement**: AppSessionGuard/ApiKeyAuthGuard reject frozen users; existing API-key/wallet freeze controls remain unchanged.
- **Safe response shaping:** public transaction status and signing-request responses never expose calldata, `requestHash`, `interactionsHash`, digests, or secrets; billing/claim/reconciliation responses never expose receipt logs, calldata, RPC details, Openfort IDs, or secrets.

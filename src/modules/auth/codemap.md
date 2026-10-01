# Code Map for /src/modules/auth

## Responsibility
Openfort IAM authentication and onboarding: sync Openfort email-OTP sessions into local `User` rows, provision a pending embedded-wallet record, authorize and activate the user's embedded EOA as their asset account, bind a TEE-managed Calibur agent wallet, drive the per-chain agent-key registration lifecycle, refresh API keys, and track login IPs for security telemetry. API keys are never issued during login — only through the explicit refresh flow here or the API-key management module.

## Design/Patterns
- Controller/service split; `AuthController` applies `@UseGuards(OpenfortAuthGuard)` at class level so every route requires a valid Openfort IAM bearer token (attaches `openfortUserId`, `openfortAccessToken`, `openfortEmail` to the request). Per-route `@Throttle` limits (5/60s, 20/60min; 3/60s, 10/60min for refresh).
- Find-or-create user sync with race handling: `syncOpenfortSession` retries on Prisma `P2002` (unique `socialId`) via depth-limited recursion (max 3), treating the conflict as an existing user.
- Multi-wallet records are owner-scoped by `userId`; default selection is persisted and repaired under the billing-account lock with stable ordering.
- Embedded-wallet authorization verifies provider-derived identity, rejects cross-owner/immutable-binding conflicts, reserves quota under the billing lock, and creates a durable per-wallet provisioning intent.
- TEE creation dispatches once via a committed random fencing token; provider calls run outside transactions. Dispatched/uncertain intents never automatically retry; provisioned identity is stored before separate locked activation and quota/peak updates.
- Agent registration state machine (`AgentStatus` from `common/agent/agent-status`): `registration_required` → `pending_registration` → `registered` | `registration_failed`, with `expired` reserved for downstream consumers. `getMe` self-heals stale `pending_registration` rows by checking the on-chain receipt and verifying the Calibur key registration.
- Registration transaction/result updates are wallet-owner scoped CAS operations; `registration_failed` can be retried with a new transaction hash, while in-flight/registered/expired states cannot be overwritten. Writes fail closed for frozen users/wallets; receipt self-healing compares pending status and transaction hash.
- Optional dependencies (`@Optional()`) for `RequestContextService` (log correlation) and `SecurityEventService` (login-IP telemetry) so the service degrades gracefully when they are absent.
- Safe response projection includes wallet ID/default/provisioning state and a stable `wallets` list plus compatibility `wallet`; no private keys or account credentials are returned.
- CSRF safety for `refresh-api-key`: requires a bearer token (browsers cannot attach custom Authorization headers cross-origin without preflight) plus `FrontendOnlyGuard` origin/referer checks and `StepUpGuard` TOTP proof.

## Flow
- `POST /auth/session` syncs the IAM user, ensures a pending default wallet if needed, repairs default deterministically, tracks login IP, and returns `{ userId, wallet, wallets }`.
- `POST /auth/embedded-wallet/authorize` verifies provider account identity, reserves immutable wallet identity/quota, then performs single-dispatch durable TEE provisioning and separately locked activation. A dispatched/uncertain intent is review-only.
- Registration routes resolve an owned wallet ID (required when multiple wallets exist). Transaction/result updates CAS expected status and hash; stale receipt checks cannot overwrite newer registration state.
- `GET /auth/me` → `getMe`: read-only DB lookup; `selfHealAgentRegistrations` reconciles `pending_registration` rows — missing tx hash reverts to `registration_required`, reverted receipts become `registration_failed`, successful receipts are verified against Calibur and marked `registered` (verification failures stay pending and are logged).
- `POST /auth/refresh-api-key` → `refreshApiKey`: calls `ApiKeyService.rotateApiKey(userId, 'Refreshed')`, which atomically revokes all active keys and issues a replacement; returns the raw key exactly once.

## Integration
- Module imports: `ApiKeyModule` (rotate), `SecurityEventModule` (login-IP events), `StepUpModule` (TOTP proof validation), `BillingModule` (wallet activation quota).
- Guards: `OpenfortAuthGuard` (all routes), plus `OpenfortUserGuard` (DB user + frozen check), `FrontendOnlyGuard` (origin/referer allowlist), and `StepUpGuard` (`X-Step-Up-Token`) on `refresh-api-key`.
- Services: `PrismaService` (User, UserWallet, WalletChainAuthorization, UserKnownIp), `OpenfortService` (`verifyIamSession`, `authorizeEmbeddedAddress`, `createAgentWallet`, `verifyAgentKeyRegistration`, `getTransactionReceiptStatus`), `ApiKeyService.rotateApiKey`, `BillingWalletLifecycleService` (account-locked wallet reservation and activation quota/peak tracking), `RequestContextService.getLogContext`, `SecurityEventService.record` (`login.new_ip`).
- DTOs (referenced, not owned): `AuthorizeEmbeddedWalletDto` (embedded address, optional Openfort account id, chainId, agentExpiresAt), `AgentRegistrationTransactionDto` (chainId + 0x64-hex txHash), `AgentRegistrationResultDto` (chainId, txHash, status `registered`|`registration_failed`).
- Data model: `User` (unique `socialId`, email, freeze state) → N `UserWallet` (provider identity, default flag, agent fields/status, provisioning intent) → N `WalletChainAuthorization` (composite `walletId_chainId`, status, registrationTxHash, expiresAt); `UserKnownIp` (unique `userId_ip`) for login-IP tracking.
- Downstream consumers rely on the wallet status and chain-authorization states this module writes: frozen/active wallet checks in wallet/transactions modules, and `registered` chain authorizations gate Calibur agent-key execution.

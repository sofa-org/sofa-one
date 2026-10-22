# Code Map for /src/modules/auth

## Responsibility
Openfort identity exchange and wallet onboarding. Local opaque application sessions are owned by `../app-session/app-session.service.ts`; IAM remains the login/wallet identity proof and TEE provider. Preserve existing User/wallet/API-key/billing identities; no keys are issued during login.

## Design/Patterns
- `AuthController` exposes unversioned frontend-only `/auth` routes with per-method guards. Only login exchange and fresh embedded authorization use `OpenfortAuthGuard`; all other dashboard methods use `AppSessionGuard`.
- Find-or-create user sync with race handling: `syncOpenfortSession` retries on Prisma `P2002` (unique `socialId`) via depth-limited recursion (max 3), treating the conflict as an existing user.
- Multi-wallet records are owner-scoped by `userId`; default selection is persisted and repaired under the billing-account lock with stable ordering.
- Embedded-wallet authorization verifies provider-derived identity, rejects cross-owner/immutable-binding conflicts, reserves quota under the billing lock, and creates a durable per-wallet provisioning intent.
- TEE creation dispatches once via a committed random fencing token; provider calls run outside transactions. Dispatched/uncertain intents never automatically retry; provisioned identity is stored before separate locked activation and quota/peak updates.
- Agent registration state machine (`AgentStatus` from `common/agent/agent-status`): `registration_required` → `pending_registration` → `registered` | `registration_failed`, with `expired` reserved for downstream consumers. `getMe` self-heals stale `pending_registration` rows by checking the on-chain receipt and verifying the Calibur key registration.
- Registration transaction/result updates are wallet-owner scoped CAS operations; `registration_failed` can be retried with a new transaction hash, while in-flight/registered/expired states cannot be overwritten. Writes fail closed for frozen users/wallets; receipt self-healing compares pending status and transaction hash.
- Optional dependencies (`@Optional()`) for `RequestContextService` (log correlation) and `SecurityEventService` (login-IP telemetry) so the service degrades gracefully when they are absent.
- Safe response projection includes wallet ID/default/provisioning state and a stable `wallets` list plus compatibility `wallet`; no private keys or account credentials are returned.
- API-key rotation lives in `ApiKeyController`, protected by a full local session, Origin/CSRF and exact-session TOTP step-up.

## Flow
- `POST /auth/session` verifies IAM, syncs the local user/default pending wallet, tracks login IP, then issues a pending-MFA HttpOnly cookie and identity-only snapshot. Frozen users are rejected before sync mutations.
- `GET /auth/session` is provider-independent local introspection; current logout permits pending MFA, all-device logout requires full MFA plus step-up. Session hashes and revocation/expiry live in `AppSession`.
- `POST /auth/embedded-wallet/authorize` requires a full local session plus fresh matching IAM subject, then verifies provider account ownership, reserves identity/quota and performs single-dispatch provisioning. Uncertain dispatch remains review-only.
- Registration routes resolve an owned wallet ID (required when multiple wallets exist). Transaction/result updates CAS expected status and hash; stale receipt checks cannot overwrite newer registration state.
- `GET /auth/me` → `getMe`: read-only DB lookup; `selfHealAgentRegistrations` reconciles `pending_registration` rows — missing tx hash reverts to `registration_required`, reverted receipts become `registration_failed`, successful receipts are verified against Calibur and marked `registered` (verification failures stay pending and are logged).
- API-key rotation is `POST /api-keys/rotations` (owned wallet ID, atomic rotation, raw replacement key returned once); `AuthService.refreshApiKey` remains an internal service method only.

## Integration
- Module imports: `ApiKeyModule` (rotate), `SecurityEventModule` (login-IP events), `StepUpModule` (TOTP proof validation), `BillingModule` (wallet activation quota).
- Guards: `OpenfortAuthGuard` for exchange/provider proof; `AppSessionGuard` for local identity; `FrontendOnlyGuard` for Origin/Referer; `StepUpGuard` for all-device logout and sensitive API-key routes.
- Services: `PrismaService` (User, UserWallet, WalletChainAuthorization, UserKnownIp), `OpenfortService` (`verifyIamSession`, `authorizeEmbeddedAddress`, `createAgentWallet`, `verifyAgentKeyRegistration`, `getTransactionReceiptStatus`), `ApiKeyService.rotateApiKey`, `BillingWalletLifecycleService` (account-locked wallet reservation and activation quota/peak tracking), `RequestContextService.getLogContext`, `SecurityEventService.record` (`login.new_ip`).
- DTOs (referenced, not owned): `AuthorizeEmbeddedWalletDto` (embedded address, optional Openfort account id, chainId, agentExpiresAt), `AgentRegistrationTransactionDto` (chainId + 0x64-hex txHash), `AgentRegistrationResultDto` (chainId, txHash, status `registered`|`registration_failed`).
- Data model: `User` (unique `socialId`, email, freeze state) → N `UserWallet` (provider identity, default flag, agent fields/status, provisioning intent) → N `WalletChainAuthorization` (composite `walletId_chainId`, status, registrationTxHash, expiresAt); `UserKnownIp` (unique `userId_ip`) for login-IP tracking.
- Downstream consumers rely on the wallet status and chain-authorization states this module writes: frozen/active wallet checks in wallet/transactions modules, and `registered` chain authorizations gate Calibur agent-key execution.

## Application-session infrastructure
- Global `AppSessionModule` exports session/origin services without importing wallet/billing modules.
- Tokens: 32 random bytes in an HttpOnly cookie; only SHA-256 hash persisted. CSRF derives from the raw cookie with a separate `csrf:` prefix and constant-time validation.
- One-hour absolute lifetime, 15-minute pending-MFA deadline, no renewal. AppSessionGuard reloads current user/freeze state; ordinary authentication never calls Openfort.
- User/session locks serialize MFA verification, cookie replacement and logout. Cross-owner replacement locks both users in sorted UUID order; proofs are deleted on revocation.
- Cookie/HTTP details and deployment limitations are authoritative in root `API.md`, `SECURITY.md`, `DEPLOYMENT.md`.

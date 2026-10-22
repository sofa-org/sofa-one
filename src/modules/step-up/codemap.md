# Code Map for /src/modules/step-up

## Responsibility
Issue and validate short-lived, exact-session step-up proofs for sensitive dashboard mutations. `StepUpService` injects PrismaService and AppSessionService; no controller/DTO is exposed.

## Design/Patterns
- Random 32-byte proof tokens; `StepUpChallenge` has required composite `(sessionId,userId)` FK to AppSession. Legacy unbound proofs are deleted by the session migration.
- `createProof(tx,userId,sessionId,type)` runs inside the MFA transaction, locks/rechecks a live full-MFA session, and caps its 15-minute TTL at absolute session expiry.
- `validateProof(token,userId,sessionId,type)` requires an exact token/type/owner/session match, verified/unexpired proof, full-MFA live/unrevoked session and unfrozen user.
- Proofs are reusable only within that scope/lifetime. Cookie replacement/logout deletes relevant proofs; all-device logout/factor disable deletes every user's proof.
- Expired-row cleanup exists but is not scheduled; expiry/revocation validation does not depend on cleanup.

## Flow
1. Cookie-authenticated TOTP/recovery verification atomically consumes the factor, upgrades the exact session and calls `createProof(tx,userId,sessionId,'totp_mfa')`.
2. Frontend caches by originating session ID; delayed responses from replaced sessions are discarded. Sensitive requests send `X-Step-Up-Token`.
3. StepUpGuard reads request.user.id and request.appSession.id, calls exact-session validation and marks request.stepUpVerified; missing/invalid proofs produce 403.
4. Downstream services consume the `stepUpVerified` flag as defense-in-depth: `WithdrawalPolicyService` rejects withdrawals when `policy.requireStepUp` and `stepUpVerified` is falsy; `WalletService.withdraw` treats a `require_step_up` risk-assessment action as satisfied only when `stepUpVerified === true`.

## Integration
- Registered in `AppModule` and imported by `MfaModule`, `AuthModule`, `ApiKeyModule`, and `WalletModule`; exports `StepUpService`.
- Depends on PrismaService, AppSessionService, AppSession and StepUpChallenge. No unbound issuance or compatibility parameters.
- Consumed by MfaService for issuance and StepUpGuard for validation.
- Protected routes require full application cookie, Origin/CSRF, FrontendOnlyGuard and StepUpGuard:
  - `POST /api-keys/rotations` (ApiKeyController)
  - `POST /api-keys`, `DELETE /api-keys`, `DELETE /api-keys/:id` (ApiKeyController)
  - `POST /wallets/withdrawal-addresses`, `DELETE /wallets/withdrawal-addresses/:id`, `POST /wallets/withdrawals` (DashboardWalletController)
  - `DELETE /auth/sessions` and sensitive API-key configuration mutations.
- `cleanupExpiredChallenges` is not wired to any scheduler; it is currently dead code outside tests.

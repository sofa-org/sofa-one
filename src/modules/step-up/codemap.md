# Code Map for /src/modules/step-up

## Responsibility
Step-up authentication proofs: issue short-lived proof tokens after a successful MFA/TOTP verification, validate those tokens on sensitive dashboard routes, and clean up expired proof records. The module has no controller and no DTOs (`dto/` is empty); it is a pure service module consumed by guards and other services.

## Design/Patterns
- Single `StepUpService` (stateless, injects `PrismaService`) with three methods: `createProof`, `validateProof`, `cleanupExpiredChallenges`.
- Proof tokens are `randomBytes(32).toString('hex')` (64 hex chars, matching `StepUpChallenge.proofToken VarChar(64)`).
- Proof lifetime is fixed at `PROOF_TTL_MS = 15 * 60 * 1000` (15 minutes).
- Each proof is persisted as a `StepUpChallenge` row (`step_up_challenges` table) with `verified: true` and `verifiedAt` set at creation time. A `challengeCodeHash` (Argon2id of a random 16-byte hex value) is stored but is never verified anywhere in this module — it is a placeholder/defense-in-depth field; the `attempts` counter is also never incremented here.
- Proofs are NOT single-use: `validateProof` only finds a matching unexpired row and does not consume/delete it, so the same token stays valid until `expiresAt`.
- `cleanupExpiredChallenges` bulk-deletes expired rows; the code comment says it "should be called periodically (e.g., via cron job)", but no scheduler/cron wiring exists in the codebase.

## Flow
1. Frontend completes TOTP (or recovery-code) verification via `POST /v1/auth/mfa/totp/verify` → `MfaService.verifyTotp` → on success calls `StepUpService.createProof(userId, 'totp_mfa')`, which returns `{ proofToken, expiresAt }` to the frontend.
2. Frontend stores the proof token and sends it in the `X-Step-Up-Token` header on subsequent sensitive requests.
3. `StepUpGuard` (in `src/common/guards/`) activates only on routes marked `@RequireStepUp()` (metadata key `STEP_UP_KEY = 'requireStepUp'`). It reads `X-Step-Up-Token` and `request.user.id`, then calls `StepUpService.validateProof(proofToken, userId, 'totp_mfa')`. On success it sets `request.stepUpVerified = true`; on missing/invalid/expired proof it throws `ForbiddenException`.
4. Downstream services consume the `stepUpVerified` flag as defense-in-depth: `WithdrawalPolicyService` rejects withdrawals when `policy.requireStepUp` and `stepUpVerified` is falsy; `WalletService.withdraw` treats a `require_step_up` risk-assessment action as satisfied only when `stepUpVerified === true`.

## Integration
- Registered in `AppModule` and imported by `MfaModule`, `AuthModule`, `ApiKeyModule`, and `WalletModule`; exports `StepUpService`.
- Depends on `PrismaService` (`src/core/database/`) and the `StepUpChallenge` model (`prisma/schema.prisma`, table `step_up_challenges`, FK to `User` with `onDelete: Cascade`, indexes on `[proofToken]` and `[userId, createdAt]`).
- Consumed by `MfaService` (`createProof` after TOTP/recovery-code verification) and `StepUpGuard` (`validateProof`).
- Routes protected by `@RequireStepUp()` + `StepUpGuard` (all frontend-only, Openfort IAM bearer + `FrontendOnlyGuard`):
  - `POST /auth/refresh-api-key` (AuthController)
  - `POST /v1/api-keys`, `DELETE /v1/api-keys`, `DELETE /v1/api-keys/:id` (ApiKeyController)
  - `POST /v1/wallets/withdrawal-addresses`, `DELETE /v1/wallets/withdrawal-addresses/:id`, `POST /v1/wallets/withdraw` (WalletController)
- `cleanupExpiredChallenges` is not wired to any scheduler; it is currently dead code outside tests.
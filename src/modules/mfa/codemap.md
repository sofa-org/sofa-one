# src/modules/mfa/

## Responsibility

Multi-factor authentication (MFA) for Openfort IAM users. This module owns the complete TOTP
lifecycle — setup, enable, verify, and disable — and is the only place that issues step-up proof
tokens for the `totp_mfa` factor. It is a frontend-only feature: every route requires an Openfort
IAM bearer token (`OpenfortUserGuard`) plus an origin/referer check (`FrontendOnlyGuard`), and none
of these routes are part of the public API-key surface in `openapi.yaml`.

The module's job is to prove "something you have" (a TOTP secret or a recovery code) on top of the
IAM session, then hand the caller a short-lived proof token that downstream sensitive operations
(`@RequireStepUp()` routes) accept via the `X-Step-Up-Token` header.

## Files

- `mfa.controller.ts` — route definitions for `v1/auth/mfa/*`; thin pass-through to `MfaService`.
- `mfa.service.ts` — all business logic: secret generation/encryption, TOTP verification, recovery
  code hashing/rotation, credential state transitions, proof issuance.
- `mfa.module.ts` — Nest module wiring; imports `StepUpModule` (for `StepUpService`).
- `dto/totp.dto.ts` — `TotpCodeDto` request validation (see `dto/codemap.md`; not re-documented here).

## Key Symbols

- `MfaController` — `@Controller('v1/auth/mfa')`, `@FrontendOnly()`, guarded by
  `OpenfortUserGuard` + `FrontendOnlyGuard`. Routes:
  - `GET status` → `mfa.getStatus(req.user.id)`
  - `POST totp/setup` → `mfa.setupTotp(req.user.id, req.openfortEmail ?? req.user.email)`
  - `POST totp/enable` → `mfa.enableTotp(req.user.id, dto.code)`
  - `POST totp/verify` → `mfa.verifyTotp(req.user.id, dto.code)`
  - `POST totp/disable` → `mfa.disableTotp(req.user.id, dto.code)`
- `MfaService` — injects `PrismaService`, `ConfigService`, `StepUpService`. Constructor sets
  `authenticator.options = { step: 30, window: 1 }` (30s window, ±1 step tolerance).

## Design / Patterns

- **Credential state machine** (`UserMfaTotpCredential.status`, default `pending`):
  - `pending` → `enabled` via `enableTotp` (after valid TOTP code; sets `enabledAt`).
  - `enabled` → `disabled` via `disableTotp` (after re-verification; sets `disabledAt`).
  - `setupTotp` re-rolls the secret and resets to `pending` (clears `enabledAt`/`disabledAt`).
  - `setupTotp` refuses to overwrite an already-`enabled` credential (`BadRequestException`).
  - `verifyTotp`/`disableTotp` require `status === 'enabled'` (`NotFoundException` otherwise);
    `enableTotp` requires a credential to exist (pending or enabled) but never an enabled one.
- **Secret at rest**: the TOTP secret is encrypted with AES-256-GCM using a key from
  `MFA_SECRET_ENCRYPTION_KEY` (base64, must decode to exactly 32 bytes). Payload layout is
  `iv(12) || authTag(16) || ciphertext`, base64-encoded. The plaintext secret is returned only once,
  from `setupTotp`, so the frontend can render the QR/otpauth URL.
- **Recovery codes**: 10 codes per enable, each `XXXX-XXXX-XXXX` (3 groups × 4 chars) from the
  Crockford-style alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (excludes `I`, `O`, `0`, `1`).
  Stored only as Argon2id hashes; plaintext codes are returned once from `enableTotp`. On re-enable,
  old codes are deleted and a fresh set is issued (single-use: `usedAt` marks consumption).
- **Verification order**: TOTP code checked first; if it fails, recovery codes are tried (each
  normalized via `trim().toUpperCase()` before Argon2 verify). A matched recovery code is marked
  used inside the same request before a proof is issued.
- **Proof issuance**: successful verification delegates to `StepUpService.createProof(userId,
  'totp_mfa')`, which persists a `StepUpChallenge` (verified: true, 15-minute TTL) and returns a
  random 64-hex `proofToken`. MFA never validates proofs itself — that is `StepUpGuard`'s job.
- **Atomicity**: `enableTotp` and `disableTotp` wrap credential update + recovery-code
  delete/create in a single Prisma `$transaction`.
- **DTO reuse**: `TotpCodeDto` is the body type for enable/verify/disable; the regex accepts either
  a 6-digit TOTP code or a `XXXX-XXXX-XXXX` recovery code (case-insensitive).

## Flow

1. **Status** — `GET /v1/auth/mfa/status` returns `{ enabled, recoveryCodesRemaining }` from the
   credential row plus unused recovery codes. No side effects.
2. **Setup** — `POST /v1/auth/mfa/totp/setup`:
   - Rejects if MFA already enabled.
   - Generates a new secret, upserts the credential to `pending` with the encrypted secret.
   - Returns `{ secret, otpauthUrl }` (otpauth label uses `req.openfortEmail ?? req.user.email`,
     issuer `SOFA ONE`).
3. **Enable** — `POST /v1/auth/mfa/totp/enable` with a 6-digit code:
   - Decrypts the pending secret, validates the code via `authenticator.check`.
   - In one transaction: sets status `enabled` + `enabledAt`, deletes any prior recovery codes,
     inserts 10 new Argon2id-hashed recovery codes.
   - Returns the plaintext `recoveryCodes` (shown once to the user).
4. **Verify** — `POST /v1/auth/mfa/totp/verify` with a TOTP or recovery code:
   - TOTP match → `issueProof` directly.
   - Else iterate unused recovery codes; on Argon2 match, mark `usedAt` and `issueProof`.
   - No match → `BadRequestException('Invalid TOTP or recovery code')`.
   - `issueProof` returns `{ proofToken, expiresAt }` from `StepUpService`.
5. **Disable** — `POST /v1/auth/mfa/totp/disable`:
   - Re-verifies the code (full `verifyTotp` path, which also issues a proof that is discarded).
   - In one transaction: deletes recovery codes, sets status `disabled` + `disabledAt`.
   - The credential row is retained (not deleted) so the user can re-setup later.

## Integration

- **Module wiring**: `MfaModule` is imported by `AppModule` (alongside `StepUpModule`). It imports
  `StepUpModule` to obtain `StepUpService`; it does not export anything.
- **Auth chain**: `OpenfortUserGuard` resolves the IAM session, loads the `User` by
  `socialId`, rejects frozen accounts, and populates `req.user`, `req.openfortEmail`,
  `req.openfortUserId`, `req.openfortSession`. `FrontendOnlyGuard` enforces the `CORS_ORIGIN`
  allowlist via `Origin` (falling back to `Referer` outside production). Both are applied at the
  controller level; the global `ApiKeyThrottlerGuard` (APP_GUARD) also applies.
- **Downstream consumer**: `StepUpGuard` (`src/common/guards/step-up.guard.ts`) validates the
  `X-Step-Up-Token` header against `StepUpService.validateProof(token, userId, 'totp_mfa')` on
  `@RequireStepUp()` routes (e.g. wallet/API-key sensitive operations). MFA is the issuer of those
  proofs; it never consumes them.
- **Data model** (`prisma/schema.prisma`):
  - `UserMfaTotpCredential` — one per user (`userId` unique), `encryptedSecret`, `status`,
    `enabledAt`, `disabledAt`; cascade-deleted with the user.
  - `UserMfaTotpRecoveryCode` — many per credential, `codeHash` (Argon2id), `usedAt`; indexed on
    `[credentialId, usedAt]`; cascade-deleted with the credential.
  - `StepUpChallenge` — created by `StepUpService.createProof`; indexed on `proofToken`.
- **Config**: requires `MFA_SECRET_ENCRYPTION_KEY` (32 base64-encoded bytes); missing or malformed
  keys throw `BadRequestException` at encrypt/decrypt time.
- **External deps**: `otplib` (TOTP), `argon2` (recovery-code hashing), Node `crypto`
  (AES-256-GCM, `randomBytes`, `randomInt`), `@nestjs/config`, `PrismaService`.
- **Not public API**: all routes are frontend-only and intentionally omitted from `openapi.yaml`.
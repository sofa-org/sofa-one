# src/modules/mfa/

## Responsibility

TOTP lifecycle for local application sessions: setup, enable, verify, recovery codes and disable. All routes are frontend-only cookie-authenticated and omitted from public OpenAPI. The module imports StepUpModule and AppSessionModule.

## Routes and state
- MfaController at `/auth/mfa` uses AppSessionGuard + FrontendOnlyGuard, with no-store responses.
- GET status and POST totp/setup, totp/enable, totp/verify explicitly permit pending MFA. POST totp/disable requires a full-MFA session.
- Every mutation passes userId and the exact sessionId; unsafe requests require trusted Origin/CSRF before the service runs.
- setup generates an encrypted pending credential, refusing an already-enabled factor.
- enable verifies a pending secret and atomically enables the factor/rotates ten recovery codes, but leaves the application session pending. The client must verify before business access.
- verify checks TOTP or consumes one recovery code with a usedAt-null CAS, atomically upgrades this live session and creates its bound step-up proof. No sliding session renewal.
- disable verifies the factor without issuing a proof, disables the credential/deletes recovery codes and revokes all user sessions/proofs; the controller clears the current cookie.

## Security and persistence
- User → session row locks serialize setup/enable/verify/disable, exchanges and logout. Both deadlines and freeze state are checked inside the transaction, including after expensive factor work.
- Proof persistence failure rolls back MFA upgrade/recovery consumption. Concurrent verification cannot consume the same recovery code twice.
- AES-256-GCM stores TOTP secrets as iv(12) + tag(16) + ciphertext, base64. MFA_SECRET_ENCRYPTION_KEY must decode to 32 bytes.
- TOTP uses a 30-second step with ±1 window. Recovery codes are ten Crockford-style 3×4 groups, stored as Argon2id hashes and returned plaintext only once.
- StepUpService caps proof lifetime at min(15 minutes, absolute session expiry) and validates exact user/session plus live full-MFA state.

## Integration
- Prisma models: UserMfaTotpCredential, UserMfaTotpRecoveryCode, AppSession, StepUpChallenge.
- AppSessionService owns cookie/session state; StepUpGuard checks proofs on sensitive business routes.
- Root API.md/SECURITY.md describe the HTTP contract; `test/app-session.pg.e2e-spec.ts` covers persisted concurrency/rollback/revocation.

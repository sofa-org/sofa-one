# src/modules/mfa/dto/

## Responsibility

Request DTOs for the MFA (multi-factor authentication) endpoints. This folder owns the single
validation contract for the TOTP/recovery code submitted by the frontend when enabling, verifying,
or disabling TOTP on a user's Openfort IAM account. It is the only place that defines the accepted
shape and format of the `code` field; no other module defines or re-validates it.

## Files

- `totp.dto.ts` — the only production file. Exports `TotpCodeDto`.

## Key Symbols

- `TotpCodeDto` (class, exported)
  - `code: string` — required, non-empty string.
  - Decorators: `@IsString()`, `@IsNotEmpty()`, `@Matches(...)`.

## Design / Patterns

- **class-validator decorator DTO**: standard NestJS pattern; the DTO is a plain class annotated
  with `class-validator` decorators and validated by the global `ValidationPipe`
  (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` in `src/main.ts`).
- **Single-field contract**: the DTO carries exactly one field (`code`), so it doubles as the
  request body type for three distinct endpoints (enable/verify/disable).
- **Format enforcement via regex**: `@Matches` accepts either:
  - a 6-digit TOTP code (`\d{6}`), or
  - a recovery code of three 4-character groups separated by hyphens
    (`XXXX-XXXX-XXXX`), using the Crockford-style base32 alphabet `[A-HJ-NP-Z2-9]`
    (excludes `I`, `O`, `0`, `1`), case-insensitive (`/i` flag).
  - Invalid formats fail with message `'code must be a 6-digit TOTP code or recovery code'`.
- **No business logic**: pure validation; no normalization, hashing, or TOTP verification here.

## Flow

1. Frontend sends `POST /v1/auth/mfa/totp/{enable|verify|disable}` with JSON body
   `{ "code": "<6-digit TOTP or recovery code>" }`.
2. Global `ValidationPipe` (transform mode) validates the body against `TotpCodeDto`:
   - non-string / empty / malformed `code` → 400 with the `@Matches` message;
   - any unknown extra field → 400 (`forbidNonWhitelisted`).
3. On success the body is transformed into a `TotpCodeDto` instance and passed to the controller
   handler, which forwards `dto.code` to the corresponding `MfaService` method
   (`enableTotp`, `verifyTotp`, `disableTotp`).

## Integration

- **Consumers**: `MfaController` (`src/modules/mfa/mfa.controller.ts`) imports
  `TotpCodeDto` and uses it as the `@Body()` type on three routes:
  - `POST /v1/auth/mfa/totp/enable` → `mfa.enableTotp(req.user.id, dto.code)`
  - `POST /v1/auth/mfa/totp/verify` → `mfa.verifyTotp(req.user.id, dto.code)`
  - `POST /v1/auth/mfa/totp/disable` → `mfa.disableTotp(req.user.id, dto.code)`
- **Not used** by `GET /v1/auth/mfa/status` or `POST /v1/auth/mfa/totp/setup` (no body).
- **Route context**: all routes are `@FrontendOnly()` and guarded by `OpenfortUserGuard` +
  `FrontendOnlyGuard`; the DTO itself carries no auth concerns.
- **Dependencies**: external `class-validator` (npm). No internal module imports.
- **Output**: a validated `TotpCodeDto` instance (or a 400 `BadRequestException` from the global
  pipe). The DTO never leaves the controller layer; downstream code receives the plain `code`
  string.
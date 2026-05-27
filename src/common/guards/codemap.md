# Code Map for /src/common/guards

## Responsibility
Access control for Openfort IAM auth, API-key auth, and frontend-only route restrictions.

## Design/Patterns
- NestJS guard pattern with route metadata checks.
- Dual-auth strategy in `EitherAuthGuard` (JWT first, API key fallback) remains available, while public API-key-only routes use dedicated `ApiKeyAuthGuard`.
- Origin/Referer allowlist enforcement in `FrontendOnlyGuard`.

## Flow
- Guards read headers and route metadata.
- JWT paths verify Openfort IAM tokens and attach user context.
- API-key paths query extended and legacy prefix candidates, verify every matching Argon2 hash to avoid prefix-collision failures, enforce allowed IPs, and update last-used timestamps.
- Frontend-only routes reject requests without an allowed browser origin.
- API-key-only routes authenticate directly with `ApiKeyAuthGuard` and do not accept IAM bearer tokens.
- API-key management routes use Openfort IAM/dashboard guards only; an API key cannot create, list, revoke, or rotate API keys.

## Integration
- Used by controllers via `@UseGuards()` and route decorators.
- Depends on Openfort IAM verification, PrismaService, ConfigService, Argon2, and Reflector.

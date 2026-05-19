# Code Map for /src/common/guards

## Responsibility
Access control for Clerk JWT auth, API-key auth, and frontend-only route restrictions.

## Design/Patterns
- NestJS guard pattern with route metadata checks.
- Dual-auth strategy in `EitherAuthGuard` (JWT first, API key fallback), with `ApiKeyOnlyGuard` narrowing selected routes after API-key authentication.
- Origin/Referer allowlist enforcement in `FrontendOnlyGuard`.

## Flow
- Guards read headers and route metadata.
- JWT paths verify Clerk tokens and attach user context.
- API-key paths query extended and legacy prefix candidates, verify every matching Argon2 hash to avoid prefix-collision failures, enforce allowed IPs, and update last-used timestamps.
- Frontend-only routes reject requests without an allowed browser origin.
- API-key-only routes reject Clerk-only requests even if `EitherAuthGuard` authenticated the user.
- API-key management routes use Clerk/dashboard guards only; an API key cannot create, list, revoke, or rotate API keys.

## Integration
- Used by controllers via `@UseGuards()` and route decorators.
- Depends on Clerk backend SDK, PrismaService, ConfigService, Argon2, and Reflector.

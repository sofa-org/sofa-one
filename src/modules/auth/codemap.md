# Code Map for /src/modules/auth

## Responsibility
Social-login onboarding: Openfort user lookup and wallet provisioning.

## Design/Patterns
- Controller/service split with Clerk auth guard.
- Prisma transaction for atomic user/wallet creation.
- API keys are issued explicitly through API-key management or refresh flows, not during login.

## Flow
- `/auth/social` loads the Openfort profile, finds or creates user, and provisions wallet if needed.
- `/auth/refresh-api-key` atomically revokes existing keys then issues a replacement through `ApiKeyService.rotateApiKey()`.
- `/auth/me` returns persisted wallet info only.

## Integration
- Uses `ClerkAuthGuard`, `PrismaService`, `OpenfortService`, `ApiKeyService`, and `ConfigService`.

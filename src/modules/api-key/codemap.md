# Code Map for /src/modules/api-key

## Responsibility
API-key lifecycle management: create, list metadata, revoke, rotate, and expose freeze state safely.

## Design/Patterns
- Service layer with Prisma persistence.
- Argon2 hashing with extended prefix-based lookup; prefixes are lookup hints and every candidate must be hash-verified.
- Throttled controller endpoints behind Openfort IAM dashboard auth + frontend-origin checks.
- Lifecycle rules enforce non-empty unique active names per user, a maximum of 10 active keys, supported chains only, bounded future expiry, high-risk IP allowlists, permission-based TTLs, freeze state, legacy `ApiKeyEvent` rows, and unified `SecurityEvent` audit records.

## Flow
- Create generates a `sk_` + 64-hex secret, stores a 27-character prefix plus Argon2 hash, validates name/chains/expiry, records `api_key.created` in both audit stores, and returns the raw key once.
- List returns non-sensitive metadata only, including whether a key is frozen and why.
- Revoke marks a key as revoked for the owning user and records `api_key.revoked` in the same transaction.
- Rotation revokes active keys and creates the replacement in one transaction, recording revocation events plus `api_key.rotated` through `SecurityEventService`.
- First successful use is recorded as `api_key.first_used`; suspicious use/freeze events are recorded by `ApiKeyAuthGuard`.

## Integration
- Imports `SecurityEventModule` so lifecycle writes can call `SecurityEventService.record()` atomically with Prisma transactions.
- Uses `OpenfortUserGuard`, `FrontendOnlyGuard`, `CurrentUser`, `PrismaService`, `SecurityEventService`, and Argon2.

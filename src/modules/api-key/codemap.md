# Code Map for /src/modules/api-key

## Responsibility
API-key lifecycle management: create, list metadata, revoke, rotate, and expose freeze state safely.

## Design/Patterns
- Service layer with Prisma persistence.
- Argon2 hashing with extended prefix-based lookup; prefixes are lookup hints and every candidate must be hash-verified.
- Throttled controller endpoints behind Openfort IAM dashboard auth + frontend-origin checks.
- Lifecycle rules enforce non-empty unique active names per user, a maximum of 10 active keys, supported chains only, bounded future expiry, high-risk IP allowlists, permission-based TTLs, freeze state, and audit events.

## Flow
- Create generates a `sk_` + 64-hex secret, stores a 27-character prefix plus Argon2 hash, validates name/chains/expiry, records `api_key.created`, and returns the raw key once.
- List returns non-sensitive metadata only, including whether a key is frozen and why.
- Revoke marks a key as revoked for the owning user and records `api_key.revoked`.
- Rotation revokes active keys and creates the replacement in one transaction, recording `api_key.rotated`.

## Integration
- Uses `OpenfortUserGuard`, `FrontendOnlyGuard`, `CurrentUser`, `PrismaService`, `SecurityEventService` via API-key auth, and Argon2.

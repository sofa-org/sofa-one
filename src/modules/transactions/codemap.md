# Code Map for /src/modules/transactions

## Responsibility
Transaction submission and status API for raw Openfort-backed sends.

## Design/Patterns
- Thin controller/service boundary.
- API-key-only access, idempotency, wallet-status, safe status responses, and audit snapshots before outbound submission.

## Flow
- Controller accepts API-key-authenticated send requests and status lookups.
- Service verifies wallet state, checks duplicates, stores request/interactions hashes plus API-key attribution, sends via Openfort, and updates the transaction status.
- Status lookup returns only safe fields for the current API-key user and refreshes pending Openfort intent records when possible.

## Integration
- Uses `ApiKeyAuthGuard`, `OpenfortUserGuard`, `FrontendOnlyGuard`, `CurrentUser`, `PrismaService`, `OpenfortService`, and the send DTO.

# Code Map for /src/modules/transactions

## Responsibility
Transaction submission and status API for raw Openfort-backed sends, with a dedicated transaction policy service for high-risk calldata/approval rules.

## Design/Patterns
- Thin controller/service boundary.
- API-key-only access, idempotency, wallet-status, safe status responses, and audit snapshots before outbound submission.
- `TransactionPolicyService` owns reusable pre-wallet risk checks: interaction count, per-interaction and aggregate calldata size, target-contract fanout, native value, malformed calldata, Permit/Permit2 selectors, infinite ERC20 approvals, and NFT approval-for-all.
- `executionMode: 'eoa'` is isolated by a dedicated runtime policy before wallet loading/submission.

## Flow
- Controller accepts non-frozen API-key-authenticated send requests and status lookups after suspicious-use and route-level permission checks.
- EOA sends require global opt-in, short API-key TTL, IP allowlist, independent per-key rate limit, and `SecurityEvent` audit.
- Transaction policy runs before wallet lookup, idempotency persistence, or Openfort calls; reject logs include safe metadata only (lengths/counts/selectors), never full calldata.
- Service verifies wallet state, checks duplicates, stores request/interactions hashes plus API-key attribution, sends via Openfort, and updates the transaction status.
- Status lookup returns only safe fields for the current API-key user and refreshes pending Openfort intent records when possible.

## Integration
- Uses `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `SecurityEventModule`, `EoaExecutionModule`, `OpenfortUserGuard`, `FrontendOnlyGuard`, `CurrentUser`, `PrismaService`, `OpenfortService`, `TransactionPolicyService`, and the send DTO.

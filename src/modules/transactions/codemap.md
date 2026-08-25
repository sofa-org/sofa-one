# Code Map for /src/modules/transactions

## Responsibility
Transaction submission and status API for raw Openfort-backed sends, with dedicated transaction policy and simulation services for high-risk calldata/approval rules and minimal provider preflight.

## Design/Patterns
- Thin controller/service boundary.
- API-key-only access, idempotency, wallet-status, safe status responses, and audit snapshots before outbound submission.
- `TransactionPolicyService` owns reusable pre-wallet risk checks: interaction count, per-interaction and aggregate calldata size, target-contract fanout, native value, malformed calldata, Permit/Permit2 selectors, infinite ERC20 approvals, and NFT approval-for-all.
- `TransactionSimulationService` owns minimal per-interaction provider `eth_call` simulation after wallet readiness/idempotency lookup but before creating a new transaction row or submitting to Openfort.
- `executionMode: 'eoa'` is isolated by a dedicated runtime policy before wallet loading/submission.

## Flow
- Controller accepts non-frozen API-key-authenticated send requests and status lookups after suspicious-use and route-level permission checks.
- EOA sends require global opt-in, short API-key TTL, IP allowlist, independent per-key rate limit, and `SecurityEvent` audit.
- Transaction policy runs before wallet lookup, idempotency persistence, or Openfort calls; rejects write `transaction.policy_denied` `SecurityEvent` rows and log safe metadata only (lengths/counts/selectors), never full calldata.
- Service verifies wallet state and rejects frozen wallets, checks duplicates, simulates each new interaction through the configured chain provider, stores request/interactions hashes plus API-key attribution, sends via Openfort, and updates the transaction status.
- Simulation records `transaction.simulation_allowed` / `transaction.simulation_denied` `SecurityEvent` rows with counts, chain, execution mode, API-key prefix, and interaction index only; full calldata is never logged or persisted in event metadata.
- Status lookup returns only safe fields for the current API-key user and refreshes pending Openfort intent records when possible.

## Integration
- Uses `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `SecurityEventModule`, `EoaExecutionModule`, `OpenfortUserGuard`, `FrontendOnlyGuard`, `CurrentUser`, `PrismaService`, `OpenfortService`, `TransactionPolicyService`, `TransactionSimulationService`, and the send DTO.

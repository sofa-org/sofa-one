# Code Map for /src/modules/wallet

## Responsibility
Wallet operations: deposit info, balance lookup, signing, withdrawal-address allowlist management, withdrawal policy enforcement, and withdrawal intent creation.

## Design/Patterns
- Service/controller split with validated DTOs.
- Openfort-backed signing and transaction submission.
- Chain/address handling via viem helpers and chain maps.
- `WithdrawalPolicyService` owns single-withdrawal caps, optional daily caps, withdrawal-address allowlist CRUD, new-address cooldown checks, and withdrawal-related `SecurityEvent` telemetry.
- `EoaExecutionPolicyService` gates any `executionMode: 'eoa'` signing request with global opt-in, short TTL, IP allowlist, independent rate limit, and security-event audit.

## Flow
- Controllers resolve the current user and validate request bodies.
- Service reads wallet state from Prisma, rejects frozen wallets before returning deposit/balance data or creating signing/withdrawal side effects, signs non-frozen API-key-authenticated payloads after suspicious-use, `canSign` guard enforcement, and EOA isolation checks with audit attribution, queries balances, or creates withdrawal intents.
- Withdrawal address management is dashboard-only: list uses IAM + frontend guard; add/remove additionally require step-up. Adding an address enables the allowlist policy, starts the configured cooldown window, and records allowlist lifecycle events.
- Withdrawal flow: Openfort IAM + frontend + step-up guards → wallet/chain readiness → self-transfer guard → `WithdrawalPolicyService` records policy denies/high-value requests → idempotency/balance checks → Openfort Calibur agent user operation.

## Integration
- Uses `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `SecurityEventModule`, `EoaExecutionModule`, `FrontendOnlyGuard`, `OpenfortUserGuard`, `CurrentUser`, `PrismaService`, `OpenfortService`, `WithdrawalPolicyService`, and viem.

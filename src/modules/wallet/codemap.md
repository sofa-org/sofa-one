# Code Map for /src/modules/wallet

## Responsibility
Wallet operations: deposit info, balance lookup, signing, withdrawal policy enforcement, and withdrawal intent creation.

## Design/Patterns
- Service/controller split with validated DTOs.
- Openfort-backed signing and transaction submission.
- Chain/address handling via viem helpers and chain maps.
- `WithdrawalPolicyService` owns single-withdrawal caps, optional daily caps, optional destination allowlist checks, and new-address cooldown checks.

## Flow
- Controllers resolve the current user and validate request bodies.
- Service reads wallet state from Prisma, signs non-frozen API-key-authenticated payloads after suspicious-use and `canSign` guard enforcement with audit attribution, queries balances, or creates withdrawal intents.
- Withdrawal flow: Openfort IAM + frontend + step-up guards → wallet/chain readiness → self-transfer guard → `WithdrawalPolicyService` → idempotency/balance checks → Openfort Calibur agent user operation.

## Integration
- Uses `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `SecurityEventModule`, `FrontendOnlyGuard`, `OpenfortUserGuard`, `CurrentUser`, `PrismaService`, `OpenfortService`, `WithdrawalPolicyService`, and viem.

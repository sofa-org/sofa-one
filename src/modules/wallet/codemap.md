# Code Map for /src/modules/wallet

## Responsibility
Wallet operations: deposit info, balance lookup, signing, and withdrawal intent creation.

## Design/Patterns
- Service/controller split with validated DTOs.
- Openfort-backed signing and transaction submission.
- Chain/address handling via viem helpers and chain maps.

## Flow
- Controllers resolve the current user and validate request bodies.
- Service reads wallet state from Prisma, signs non-frozen API-key-authenticated payloads after suspicious-use and `canSign` guard enforcement with audit attribution, queries balances, or creates withdrawal intents.

## Integration
- Uses `ApiKeyAuthGuard`, `ApiKeyPermissionGuard`, `SecurityEventModule`, `FrontendOnlyGuard`, `OpenfortUserGuard`, `CurrentUser`, `PrismaService`, `OpenfortService`, and viem.

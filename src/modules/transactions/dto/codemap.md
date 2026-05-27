# Code Map for /src/modules/transactions/dto

## Responsibility
Validated input for transaction send requests.

## Design/Patterns
- DTOs with nested validation for batched interactions, including byte-aligned calldata, per-interaction calldata size, and interaction-count limits.

## Flow
- Validates chain ID, interaction array size, calldata shape/size, native value shape, and idempotency key before service execution.

## Integration
- Used by `TransactionsController`.

# Code Map for /src/modules/transactions/dto

## Responsibility
Validated input for transaction send requests.

## Design/Patterns
- DTOs with nested validation for batched interactions.

## Flow
- Validates chain ID, interaction array, and idempotency key before service execution.

## Integration
- Used by `TransactionsController`.

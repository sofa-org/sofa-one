# Code Map for /src/modules/wallet/dto

## Responsibility
Validated request bodies for wallet signing and withdrawal.

## Design/Patterns
- DTOs with conditional and format validation.

## Flow
- `SignDto` enforces type-dependent fields for message or typed-data signing; raw hash signing is disabled.
- `WithdrawDto` validates chain, address, amount bounds, token, and idempotency key.

## Integration
- Used by `WalletController` endpoints.

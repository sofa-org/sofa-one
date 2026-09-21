# Code Map for /src/modules/withdrawal-destination

## Responsibility
Destination/cooldown-only policy leaf for API-key direct ERC-20-shaped egress (BILL-016 Phase 2A). Reuses `WithdrawalPolicy` / `WithdrawalAddress` data without Wallet execution, step-up, amount limits, or secrets.

## Files
- `withdrawal-destination-policy.service.ts` — allowlist + cooldown assert; user-scoped advisory lock; fail-closed DB errors.
- `withdrawal-destination.module.ts` — exports the service; imports `SecurityEventModule` only.

## Rules
- `requireAddressAllowlist !== true` (or missing policy) → allow-all (legacy).
- DB lookup failures → 503 `WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE`.
- Not allowlisted → 403 `WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED`.
- Cooldown active → 403 `WITHDRAWAL_ADDRESS_IN_COOLDOWN`.
- Lock key `withdrawal_dest:<userId>` via `pg_advisory_xact_lock` so mutations and send acceptance share a user scope even when no policy row exists.

## Integration
Imported by `TransactionsModule`. Does **not** import `WalletModule` or `BillingModule`.

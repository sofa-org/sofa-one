# Code Map for /src/modules/wallet-provisioning-recovery

## Responsibility

Narrow operator-only recovery support for binding a known, already-created Openfort Developer-custody EVM account to its matching wallet provisioning intent. This directory is not an HTTP controller or user-facing capability. It does not call provider account creation, retry creation, or reset an intent automatically.

## Files

- `bind-recovery.ts`: verifies the provider account identity/type/address, then under billing-account and wallet row locks validates the dispatch token and intent state, checks for conflicting assignments, and atomically binds the identity and records a `wallet.provisioning.recovered` security event.
- [`README.md`](README.md): operator invocation and safety requirements. The CLI entry point is `scripts/recover-wallet-provisioning.ts`.
- `bind-recovery.spec.ts`: unit coverage for recovery binding behavior.

## Safety boundary

An operator must independently establish that the account is the result of the original dispatch and belongs to the intent. Absence from a provider listing is not proof that creation cannot still complete. A mismatch or compare-and-set conflict fails closed; this tool has no safe restart/retry action. The CLI is operational tooling, not an HTTP route.

## Integration

- Uses Prisma persistence for `UserWallet`, `WalletProvisioningIntent`, `BillingAccount`, and `SecurityEvent`.
- Verifies an existing account through the provider's account-read operation; it never invokes provider create.
- Keeps account-lock-before-wallet-lock ordering consistent with billing wallet lifecycle operations.

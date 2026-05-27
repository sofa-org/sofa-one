# Code Map for /src/modules/eoa-execution

## Responsibility
Centralized runtime policy for privileged backend EOA execution requested through API-key public routes.

## Design/Patterns
- Small NestJS module exporting `EoaExecutionPolicyService` for wallet signing and transaction sending.
- Defense-in-depth runtime checks complement API-key creation-time controls: global opt-in flag, IP allowlist requirement, short TTL requirement, and independent per-key rate limiting.
- Security telemetry is mandatory for allowed and denied EOA attempts via `SecurityEventService`.

## Flow
- Service receives operation context from wallet/transaction services after API-key permission checks.
- If `EOA_EXECUTION_ENABLED` is not exactly `true`, the request is denied before wallet loading/submission.
- Runtime policy rejects keys without `allowedIps` or with `expiresAt` beyond 30 days.
- Rate limiting counts recent `eoa_execution_allowed` security events for the API key in a 60-second window; more than one EOA attempt per minute is denied.
- Allowed requests record `eoa_execution_allowed`; denied requests record `eoa_execution_denied` with reason metadata.

## Integration
- Imported by `WalletModule` and `TransactionsModule`.
- Uses `ConfigService`, `PrismaService`, and `SecurityEventService`.

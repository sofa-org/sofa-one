# Code Map for /src/modules/security-events

## Responsibility
Unified security-event persistence for account, API-key, wallet, transaction policy, alerting, and future freeze workflows.

## Design/Patterns
- `SecurityEventService.record()` is the narrow write API for `security_events` rows.
- Accepts an optional Prisma transaction client so callers can make audit writes atomic with the protected state change.
- Stores attribution (`actorType`, `userId`, `apiKeyId`, `walletId`), outcome (`result`, `reason`), risk level, request context, and safe JSON metadata.
- Defaults `riskLevel` to `low`, metadata to `Prisma.JsonNull`, and request ID from `RequestContextService` when not explicitly provided.

## Flow
- Caller constructs a safe, non-secret event payload.
- Service validates `eventType` is non-empty.
- Service writes through either the provided transaction client or the shared `PrismaService`.
- After the event is persisted, selected user-attributed events are passed to `SecurityNotificationService` to create dashboard alerts; notification failures are logged but do not fail the canonical event write.

## Integration
- Exported by `SecurityEventModule` and imported by `AppModule`, `ApiKeyModule` for lifecycle events, public API modules that need API-key first-use/suspicious-use/freeze telemetry, `EoaExecutionModule` for EOA allow/deny audit events, `TransactionsModule` for transaction-policy denies, and `WalletModule` for withdrawal policy/high-value/address lifecycle events.
- Imports `SecurityNotificationModule` so user-facing alerts can be derived from selected security events.
- Prisma model is `SecurityEvent` mapped to `security_events`.
- Do not store raw API keys, private keys, wallet secrets, full calldata, or full typed data in event metadata.

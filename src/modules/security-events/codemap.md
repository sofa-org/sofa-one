# Code Map for /src/modules/security-events

## Responsibility
Unified security-event persistence and rule-based risk scoring for account, API-key, wallet, transaction policy, alerting, and freeze workflows.

## Design/Patterns
- `SecurityEventService.record()` is the narrow write API for `security_events` rows.
- `SecurityRiskService` is the first-pass risk engine: deterministic event/result rules only, no ML or external lookups.
- Accepts an optional Prisma transaction client so callers can make audit writes atomic with the protected state change.
- Stores attribution (`actorType`, `userId`, `apiKeyId`, `walletId`), outcome (`result`, `reason`), risk level, request context, and safe JSON metadata.
- Defaults metadata to `Prisma.JsonNull` and request ID from `RequestContextService` when not explicitly provided; risk level is resolved by `SecurityRiskService`, preserving explicit higher risk while raising known risky events such as policy denies, suspicious API-key use, frozen-key events, and EOA denials.

## Flow
- Caller constructs a safe, non-secret event payload.
- Service validates `eventType` is non-empty.
- Service computes a normalized risk level before persistence.
- Service writes through either the provided transaction client or the shared `PrismaService`.
- After the event is persisted, selected user-attributed events are passed to `SecurityNotificationService` to create dashboard alerts; notification failures are logged but do not fail the canonical event write.

## Integration
- Exported by `SecurityEventModule` and imported by `AppModule`, `ApiKeyModule` for lifecycle events, public API modules that need API-key first-use/suspicious-use/freeze/frozen-user rejection telemetry, `EoaExecutionModule` for EOA allow/deny audit events, `TransactionsModule` for transaction-policy denies and simulation allow/deny events, and `WalletModule` for withdrawal policy/high-value/address lifecycle events.
- Imports `SecurityNotificationModule` so user-facing alerts can be derived from selected security events.
- Prisma model is `SecurityEvent` mapped to `security_events`.
- Do not store raw API keys, private keys, wallet secrets, full calldata, or full typed data in event metadata.

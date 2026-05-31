# Code Map for /src/modules/security-events

## Responsibility
Unified security-event persistence, rule-based risk scoring, multi-factor risk evaluation with enforcement, dashboard alert fanout, and optional SIEM export for account, API-key, wallet, transaction policy, alerting, and freeze workflows.

## Design/Patterns
- `SecurityEventService.record()` is the narrow write API for `security_events` rows.
- `SecurityRiskService` is the first-pass risk engine: deterministic event/result rules only, no ML or external lookups.
- `RiskEvaluationService` is the second-pass multi-factor risk engine: queries recent SecurityEvents and API key metadata to compute a cumulative risk score from 7 weighted factors, then recommends an action (allow/require_step_up/block/freeze). For API-key operations, `require_step_up` maps to `block` since there is no user session.
- `SecurityEventExportService` is an optional push integration: when `SECURITY_EVENTS_SIEM_WEBHOOK_URL` is set, it POSTs a redacted JSON payload for each persisted event.
- Accepts an optional Prisma transaction client so callers can make audit writes atomic with the protected state change.
- Stores attribution (`actorType`, `userId`, `apiKeyId`, `walletId`), outcome (`result`, `reason`), risk level, request context, and safe JSON metadata.
- Defaults metadata to `Prisma.JsonNull` and request ID from `RequestContextService` when not explicitly provided; risk level is resolved by `SecurityRiskService`, preserving explicit higher risk while raising known risky events such as policy denies, suspicious API-key use, frozen-key events, and EOA denials.
- SIEM export redacts sensitive metadata keys (`secret`, `token`, `apiKey`, `calldata`, `typedData`, `signature`, etc.) and sanitizes long hex/URLs before sending.

## Flow
- Caller constructs a safe, non-secret event payload.
- Service validates `eventType` is non-empty.
- Service computes a normalized risk level before persistence.
- Service writes through either the provided transaction client or the shared `PrismaService`.
- After the event is persisted, selected user-attributed events are passed to `SecurityNotificationService` to create dashboard alerts; notification failures are logged but do not fail the canonical event write.
- If configured, the persisted event is exported to the SIEM webhook after notification fanout; export failures are logged and isolated from the canonical event write.

## Risk Evaluation Flow
- Before high-risk operations (transaction send, signing, withdrawal), `RiskEvaluationService.evaluateRisk()` queries recent SecurityEvents and API key metadata.
- 7 risk factors are evaluated in parallel: consecutive policy denials (35), consecutive auth failures (30), suspicious key use (25), IP rejected (20), recently created key (15), high velocity (20), recent freeze event (50).
- Cumulative score maps to risk level and action: 0-25 low/allow, 26-50 medium/require_step_up, 51-75 high/block, 76+ critical/freeze.
- `enforceRiskAction()` records a SecurityEvent (`risk.blocked`, `risk.critical_frozen`, or `risk.step_up_required`), freezes the API key for critical risk, and throws `ForbiddenException` with risk details.

## Integration
- Exported by `SecurityEventModule` and imported by `AppModule`, `ApiKeyModule` for lifecycle events, public API modules that need API-key first-use/suspicious-use/freeze/frozen-user rejection telemetry, `EoaExecutionModule` for EOA allow/deny audit events, `TransactionsModule` for transaction-policy denies and simulation allow/deny events, and `WalletModule` for withdrawal policy/high-value/address lifecycle events.
- `RiskEvaluationService` is `@Optional()` in `TransactionsService` and `WalletService`; when absent, risk evaluation is skipped (graceful degradation).
- Imports `SecurityNotificationModule` so user-facing alerts can be derived from selected security events.
- Optional SIEM integration uses `SECURITY_EVENTS_SIEM_WEBHOOK_URL` and `SECURITY_EVENTS_SIEM_WEBHOOK_SECRET` from env validation.
- Prisma model is `SecurityEvent` mapped to `security_events`.
- Do not store or export raw API keys, private keys, wallet secrets, full calldata, full typed data, authorization tokens, or signatures in event metadata.

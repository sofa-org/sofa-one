# Code Map for /src/modules/security-events

## Responsibility
Unified security-event persistence, deterministic rule-based risk scoring, multi-factor risk evaluation with enforcement, dashboard alert fanout, and optional SIEM export for account, API-key, wallet, transaction-policy, signing, session-key, and freeze workflows. The module is the single write path for `security_events` rows and the single source of risk decisions for high-risk operations.

## Files
- `security-event.module.ts` — Nest module wiring; imports `RequestContextModule` and `SecurityNotificationModule`; provides/exports `SecurityEventService`, `SecurityRiskService`, `SecurityEventExportService`, `IpAllowlistService`, `RiskEvaluationService`.
- `security-event.service.ts` — `SecurityEventService`: narrow write API for `security_events` rows; orchestrates risk scoring, notification fanout, and SIEM export.
- `security-risk.service.ts` — `SecurityRiskService`: first-pass deterministic risk engine (event-type/result rules only, no ML or external lookups).
- `risk-evaluation.service.ts` — `RiskEvaluationService`: second-pass multi-factor risk engine that queries recent events/API-key metadata, computes a cumulative score, recommends an action, and enforces it.
- `security-event-export.service.ts` — `SecurityEventExportService`: optional push integration that POSTs a redacted JSON payload to a SIEM webhook.

## Design/Patterns
- `SecurityEventService.record()` is the canonical write API. It accepts an optional Prisma transaction client (`tx`) and `{ deferExport: true }` to persist atomically while postponing SIEM export; `exportCommitted(event)` is called after commit. Defi policy allowed/pause events use deferred export.
- `SecurityRiskService` is a pure, synchronous scorer: a static `EVENT_RISK_RULES` table (26 event types) maps `eventType` → risk level; unknown types fall back to `high` when `result === 'denied'`, else `low`. The effective level is `max(explicit input.riskLevel, inferred)`; scores are `low 10 / medium 40 / high 70 / critical 95` with a `reasons` trace.
- `RiskEvaluationService` is the enforcement engine. `evaluateRisk()` runs 7 weighted factor checks in parallel (`Promise.all`), sums weights (capped at 100), and maps score → level/action via `SCORE_THRESHOLDS` (0-25 low/allow, 26-50 medium/require_step_up, 51-75 high/block, 76-100 critical/freeze). `enforceRiskAction()` records a SecurityEvent, optionally freezes the API key, and throws `ForbiddenException` with machine-readable error codes (`RiskStepUpRequired`, `RiskBlocked`, `RiskCriticalFreeze`) plus a `risk` payload.
- Action remapping: for API-key operations (`transaction_send`, `signing`, `api_key_use`) `require_step_up` maps to `block` (no user session to verify); `freeze` without an `apiKeyId` maps to `block` (dashboard critical risk blocks instead of freezing).
- `SecurityEventExportService` is fire-and-forget: no-op when `SECURITY_EVENTS_SIEM_WEBHOOK_URL` is unset; network/HTTP failures are logged, never thrown. Payload redaction is layered: sensitive keys (`secret`, `private`, `raw`, `calldata`, `typeddata`, `api[_-]?key`, `authorization`, `token`, `signature`) → `[redacted]`, strings sanitized via `sanitizeErrorMessage(value, 240)`, depth capped at 4, arrays sliced to 20, objects to 50 keys, `bigint` → string, `Date` → ISO.
- Attribution (`actorType`, `userId`, `apiKeyId`, `walletId`), outcome (`result`, `reason`), risk level, request context, and safe JSON metadata are stored per event. `metadata` defaults to `Prisma.JsonNull`; `requestId` falls back to `RequestContextService.getRequestId()`.
- Failure isolation: notification and SIEM-export failures are caught and logged inside `record()` so they never fail the canonical event write.
- `@Optional()` injection throughout (`notifications`, `riskService`, `exporter`, `securityEvents`) enables graceful degradation in consumers and in tests.

## Flow
1. Caller constructs a safe, non-secret `RecordSecurityEventInput` (actor, event type, attribution, optional risk/result/reason/metadata).
2. `record()` validates `eventType` is non-empty (else `BadRequestException`).
3. Risk level is normalized by `SecurityRiskService.score()` (preserving explicit higher risk, raising known risky event types); falls back to `input.riskLevel ?? 'low'` if the scorer is absent.
4. The event is written through the provided transaction client or the shared `PrismaService`.
5. After persistence, `SecurityNotificationService.notifyForSecurityEvent()` turns selected user-attributed events into dashboard alerts (same transaction client); failures are logged only.
6. If configured, the persisted event is exported to the SIEM webhook; failures are logged only.

## Risk Evaluation Flow
- Before high-risk operations (transaction send, signing, withdrawal), `RiskEvaluationService.evaluateRisk()` queries recent `security_events` and API-key metadata.
- 7 factors evaluated in parallel: consecutive policy denials (35, 2+ in 1h), consecutive auth failures (30, 3+ `login.failed` in 1h), suspicious key use (25, any in 24h), IP rejected (20, any `api_key.ip_rejected` in 24h), recently created key (15, < 1h old), high velocity (20, 50+ events in 1h), recent freeze event (50, any in 24h).
- Cumulative score → level/action via thresholds; `require_step_up` → `block` for API-key operations; `freeze` → `block` when no API key.
- `enforceRiskAction()` records `risk.blocked` / `risk.critical_frozen` / `risk.step_up_required` with `result: 'denied'` and factor metadata, freezes the API key (`frozenAt`, `frozenReason: "Critical risk: ..."`) for critical risk, then throws `ForbiddenException` with risk details.

## Integration
- Imported by `AppModule`, `ApiKeyModule` (lifecycle events, passes its Prisma tx into `record()`), `AuthModule` (login/step-up events), `EoaExecutionModule` (EOA allow/deny audit), `TransactionsModule` (policy denies, simulation allow/deny, risk evaluation), `WalletModule` (withdrawal policy/high-value, signing policy, risk evaluation), and `SessionKeyModule` (session-key allow/deny/policy-drift events).
- `RiskEvaluationService` is `@Optional()` in `TransactionsService` and `WalletService`; when absent, risk evaluation is skipped (graceful degradation). `SecurityEventService` is `@Optional()` in signing/withdrawal/session-key policy services and in `IpAllowlistService`.
- Common guards consume events: `ApiKeyAuthGuard`, `EitherAuthGuard`, and `IpAllowlistService` (the latter is provided/exported by this module) record auth/allowlist outcomes.
- Imports `SecurityNotificationModule` so user-facing dashboard alerts can be derived from selected security events.
- Optional SIEM integration uses `SECURITY_EVENTS_SIEM_WEBHOOK_URL` (validated as an HTTPS URL in `env.validation.ts`) and optional `SECURITY_EVENTS_SIEM_WEBHOOK_SECRET` (sent as `Authorization: Bearer ...`).
- Prisma model `SecurityEvent` maps to `security_events` with indexes on `(userId, createdAt)`, `(apiKeyId, createdAt)`, `(walletId, createdAt)`, `(eventType, createdAt)`, `(riskLevel, createdAt)`; relations to `User`, `ApiKey`, `UserWallet` (`onDelete: SetNull`) and `SecurityNotification[]`.

## Dependencies
- `PrismaService` (`core/database`) — persistence and risk-factor queries.
- `RequestContextService` (`common/request-context`) — request-ID fallback for events.
- `SecurityNotificationService` (`security-notifications`) — dashboard alert fanout.
- `IpAllowlistService` (`common/guards`) — provided/exported for allowlist consumers.
- `sanitizeErrorMessage` (`common/utils/sanitize`) — SIEM payload string sanitization.
- Env: `SECURITY_EVENTS_SIEM_WEBHOOK_URL`, `SECURITY_EVENTS_SIEM_WEBHOOK_SECRET`.

## Constraints
- Never store or export raw API keys, private keys, wallet secrets, full calldata, full typed data, authorization tokens, or signatures in event metadata or SIEM payloads.
- Notification and SIEM export must never fail the canonical event write.

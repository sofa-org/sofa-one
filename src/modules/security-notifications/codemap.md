# Code Map for /src/modules/security-notifications

## Responsibility
Dashboard-facing security notifications derived from unified `SecurityEvent` rows.

## Design/Patterns
- `SecurityNotificationService.notifyForSecurityEvent()` turns selected user-attributed security events into safe, short notification records.
- Notification metadata includes display-safe investigation context (result/reason, request context, key prefixes/names, chain/operation, policy amounts/addresses) and never includes raw API keys, wallet secrets, full calldata, or full typed data.
- Dashboard APIs are frontend-only Openfort IAM routes and are not part of `openapi.yaml`.

## Flow
- `SecurityEventService.record()` writes the canonical event and asks `SecurityNotificationService` to create a dashboard notification when the event is user-facing.
- Users can list recent notifications, filter unread notifications, mark a single notification read, or mark all notifications read.

## Integration
- Prisma model is `SecurityNotification` mapped to `security_notifications`.
- `SecurityNotificationModule` exports the service and exposes `GET /v1/security-notifications`, `POST /v1/security-notifications/:id/read`, and `POST /v1/security-notifications/read-all` behind `OpenfortUserGuard` + `FrontendOnlyGuard`.

# src/modules/health/

## Responsibility

Public liveness and readiness probes for the SOFA ONE backend.

| File                   | Responsibility                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.module.ts`     | Imports the shared `RateLimitStorageModule`; registers `HealthController` + `HealthService`. |
| `health.controller.ts` | `@Public()` `GET /health/live` and `GET /health/ready` routes; both are intentionally public/non-sensitive (not in `openapi.yaml`).                                                                                                                                           |
| `health.service.ts`    | Dependency-free `live()`; `ready()` retains database/billing readiness and adds safe local/distributed rate-limit operational state. |

## Design

- `/health/live` is dependency-free and always `ok` (used by simple uptime
  checks / orchestration that must not flap on DB blips).
- `/health/ready` keeps the existing `database` probe and adds an aggregate
  `billingWorker` check that never exposes worker IDs, error text, secrets,
  or account/user/provider identifiers.
- `checks.rateLimit` reports only `status: ok|degraded`,
  `mode: distributed|memory`, and
  `reason: null|not_configured|redis_unavailable|shutting_down`.
  Configured Redis unavailability returns HTTP 200 with overall `status: degraded`
  if database/billing are ready; it must not evict every API replica during a
  shared Redis outage. Unconfigured Redis intentionally reports `ok`/`memory`.
  Memory buckets remain per-instance and are not globally fail-closed. No Redis
  URL, credentials, raw error, or connection identifier is exposed.
- `BillingWorkerHealth` exposes only `enabled`, `status`
  (`disabled|starting|running|healthy|failed|stale`), the four
  `last*` timestamps, `consecutiveFailures`, and an informational
  `needsReviewCount`.
- Freshness window is 15 minutes (three 5-minute worker intervals). Across
  enabled workers, precedence among fresh rows is
  `healthy > running > failed > starting`; otherwise the worker is `stale`. A
  disabled worker reports `disabled` and requires no heartbeat row.
- Fail closed: a missing heartbeat table/query reports `stale` (never healthy).
- Production readiness returns 503 for `disabled`, `failed`, or `stale` worker
  state; `starting`/`running` are allowed during bounded startup/active-tick
  windows. Development/test retain the disabled-worker allowance (lenient for
  all states).
- `needsReviewCount` aggregates existing billing review surfaces — invoices and
  payment attempts in `needs_review`, Stripe webhook events in
  `needs_review`/`failed`, quarantined usage events, auto-subscription intents
  in `needs_review` (including BILL-020 terminal no-funds), and session-cleanup
  rows stuck in `needs_review` — and is informational only (it does not fail
  readiness or invent a pager).
- BILL-020 B3: multi-worker aggregation is healthy-wins among fresh rows.
  HealthService must **not** demote a fresh `healthy` aggregate solely because
  `needsReviewCount` (or any persisted backlog counter) is nonzero. Worker tick
  owns unresolved-risk classification and writes `failed`/`healthy` heartbeats;
  readiness only aggregates those heartbeats.

## Flow

```
GET /health/live  → HealthService.live()  → { status:'ok', timestamp }

GET /health/ready → HealthService.ready()
  → workerHealth(): aggregate BillingWorkerHeartbeat rows + countNeedsReview()
      (DB/table missing → stale; disabled → disabled; no fresh row → stale)
  → databaseReady(): $queryRaw`SELECT 1`
  → production && (disabled|failed|stale) → throw 503
  → else { status:'ok'|'degraded', checks:{ database, billingWorker, rateLimit } }
```

## Integration

- Depends on `PrismaService` (`billingWorkerHeartbeat`, `billingInvoice`,
  `billingPaymentAttempt`, `stripeWebhookEvent`, `billingUsageEvent`) and
  `ConfigService` (`billing.worker.enabled`, `nodeEnv`).
- `ResilientThrottlerStorage` from the shared `RateLimitStorageModule` (same
  instance used by the global throttler, never a second health-only client).
- The heartbeat rows it reads are written by `BillingWorkerService`
  (`src/modules/billing/billing-worker.service.ts`) in `onModuleInit` and each
  `tick()`; the `BillingWorkerHeartbeat` model and its additive migration live
  in `prisma/schema.prisma` / `prisma/migrations`.
- Both routes are `@Public()` and not part of the public API-key spec.

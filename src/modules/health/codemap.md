# src/modules/health/

## Responsibility

Public liveness and readiness probes for the SOFA ONE backend.

| File                   | Responsibility                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.module.ts`     | Nest module wiring: registers `HealthController` + `HealthService`.                                                                                                                                                                                                           |
| `health.controller.ts` | `@Public()` `GET /health/live` and `GET /health/ready` routes; both are intentionally public/non-sensitive (not in `openapi.yaml`).                                                                                                                                           |
| `health.service.ts`    | `live()` returns the base `ok`+timestamp shape; `ready()` probes the database, aggregates the billing-worker heartbeat into a non-sensitive readiness state, and returns/throws `ServiceUnavailableException` (503) according to the environment-specific readiness contract. |

## Design

- `/health/live` is dependency-free and always `ok` (used by simple uptime
  checks / orchestration that must not flap on DB blips).
- `/health/ready` keeps the existing `database` probe and adds an aggregate
  `billingWorker` check that never exposes worker IDs, error text, secrets,
  or account/user/provider identifiers.
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
  → else { status:'ok', checks:{ database, billingWorker } }
```

## Integration

- Depends on `PrismaService` (`billingWorkerHeartbeat`, `billingInvoice`,
  `billingPaymentAttempt`, `stripeWebhookEvent`, `billingUsageEvent`) and
  `ConfigService` (`billing.worker.enabled`, `nodeEnv`).
- The heartbeat rows it reads are written by `BillingWorkerService`
  (`src/modules/billing/billing-worker.service.ts`) in `onModuleInit` and each
  `tick()`; the `BillingWorkerHeartbeat` model and its additive migration live
  in `prisma/schema.prisma` / `prisma/migrations`.
- Both routes are `@Public()` and not part of the public API-key spec.

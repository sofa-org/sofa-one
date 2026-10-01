-- P1 billing-worker heartbeat/readiness contract.
--
-- One additive BillingWorkerHeartbeat row per in-process worker identity, keyed
-- by the worker's existing random `workerId` (billing-worker-<uuid8>). It stores
-- only non-sensitive lifecycle telemetry: workerId, status
-- (starting|running|healthy|failed), lastHeartbeatAt, nullable
-- lastStartedAt/lastSuccessAt/lastFailureAt, consecutiveFailures, and the
-- standard created/updated timestamps.
--
-- It intentionally stores NO error text, account/user data, secrets, or
-- provider identifiers. The table is brand-new and additive: no existing rows
-- are rewritten and every column is nullable-or-defaulted, so it can be applied
-- before the worker is enabled in production.
--
-- CreateEnum
CREATE TYPE "BillingWorkerStatus" AS ENUM ('starting', 'running', 'healthy', 'failed');

-- CreateTable
CREATE TABLE "billing_worker_heartbeats" (
    "worker_id" VARCHAR(80) NOT NULL,
    "status" "BillingWorkerStatus" NOT NULL DEFAULT 'starting',
    "last_heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_started_at" TIMESTAMPTZ,
    "last_success_at" TIMESTAMPTZ,
    "last_failure_at" TIMESTAMPTZ,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "billing_worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/database/prisma.service';
import { SESSION_CLEANUP_STATUS_NEEDS_REVIEW } from '../billing/stripe/stripe.constants';

export type HealthBaseResponse = {
  status: 'ok';
  timestamp: string;
};

/** Non-sensitive billing-worker readiness state (no secrets, no user data). */
export type BillingWorkerHealth = {
  enabled: boolean;
  status: 'disabled' | 'starting' | 'running' | 'healthy' | 'failed' | 'stale';
  lastHeartbeatAt: string | null;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  needsReviewCount: number;
};

export type HealthReadyResponse = HealthBaseResponse & {
  checks: {
    database: 'ok';
    billingWorker: BillingWorkerHealth;
  };
};

/**
 * Freshness window: three 5-minute worker intervals (15 minutes), chosen to
 * detect a stopped/stuck scheduler without treating a normal bounded tick as
 * immediately stale.
 */
const WORKER_FRESH_MS = 3 * 5 * 60 * 1000;

/** Heartbeat status precedence among fresh rows: healthy > running > failed > starting. */
const FRESH_STATUS_PRECEDENCE = ['healthy', 'running', 'failed', 'starting'] as const;

type HeartbeatRow = {
  status: 'starting' | 'running' | 'healthy' | 'failed';
  lastHeartbeatAt: Date;
  lastStartedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
};

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  live(): HealthBaseResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness keeps the existing database probe and adds a non-sensitive,
   * aggregate billing-worker state. Development/test may run with the worker
   * disabled and still report ready. Production readiness is unavailable (503)
   * for disabled, failed, or stale worker state; starting/running are allowed
   * during bounded startup/active-tick windows. A missing heartbeat
   * table/query fails closed to stale/unavailable — never healthy.
   */
  async ready(): Promise<HealthReadyResponse> {
    const timestamp = new Date().toISOString();
    const billingWorker = await this.workerHealth();

    if (!(await this.databaseReady())) {
      throw new ServiceUnavailableException({
        status: 'error',
        timestamp,
        checks: { database: 'unavailable', billingWorker },
      });
    }

    if (this.isProduction() && this.unavailableInProduction(billingWorker.status)) {
      throw new ServiceUnavailableException({
        status: 'error',
        timestamp,
        checks: { database: 'ok', billingWorker },
      });
    }

    return {
      status: 'ok',
      timestamp,
      checks: { database: 'ok', billingWorker },
    };
  }

  private async databaseReady(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Aggregates worker heartbeat rows WITHOUT exposing worker IDs. For enabled
   * workers a fresh healthy row wins, otherwise a fresh running row, otherwise
   * a fresh failed row, otherwise a fresh starting row, otherwise the worker is
   * stale. `enabled=false` reports disabled and requires no heartbeat row.
   *
   * BILL-020 B3: healthy-wins multi-worker aggregation is the readiness signal.
   * Persisted unresolved backlog is enforced on the worker tick (which writes
   * failed/healthy heartbeats) — HealthService must NOT override a fresh healthy
   * aggregate based on global backlog counts.
   */
  private async workerHealth(): Promise<BillingWorkerHealth> {
    const enabled = this.config.get<boolean>('billing.worker.enabled') === true;
    const base: BillingWorkerHealth = {
      enabled,
      status: 'disabled',
      lastHeartbeatAt: null,
      lastStartedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      needsReviewCount: 0,
    };
    if (!enabled) return base;

    let rows: HeartbeatRow[];
    let needsReviewCount: number;
    try {
      [rows, needsReviewCount] = await Promise.all([
        this.prisma.billingWorkerHeartbeat.findMany({
          select: {
            status: true,
            lastHeartbeatAt: true,
            lastStartedAt: true,
            lastSuccessAt: true,
            lastFailureAt: true,
            consecutiveFailures: true,
          },
        }),
        this.countNeedsReview(),
      ]);
    } catch {
      // Missing heartbeat table/query fails closed to stale/unavailable — never
      // claims healthy.
      return { ...base, status: 'stale' };
    }

    const { status, row } = this.aggregate(rows);
    return {
      enabled: true,
      status,
      lastHeartbeatAt: row?.lastHeartbeatAt.toISOString() ?? null,
      lastStartedAt: row?.lastStartedAt?.toISOString() ?? null,
      lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row?.lastFailureAt?.toISOString() ?? null,
      consecutiveFailures: row?.consecutiveFailures ?? 0,
      needsReviewCount,
    };
  }

  private aggregate(rows: HeartbeatRow[]): {
    status: BillingWorkerHealth['status'];
    row: HeartbeatRow | undefined;
  } {
    const now = Date.now();
    const fresh = rows.filter((r) => now - r.lastHeartbeatAt.getTime() <= WORKER_FRESH_MS);
    for (const status of FRESH_STATUS_PRECEDENCE) {
      const hit = fresh.find((r) => r.status === status);
      if (hit) return { status, row: hit };
    }
    // No fresh rows: stale. Report the most recently heartbeated row so an
    // operator still sees the last observed timestamps/failure count.
    const mostRecent = [...rows].sort(
      (a, b) => b.lastHeartbeatAt.getTime() - a.lastHeartbeatAt.getTime(),
    )[0];
    return { status: 'stale', row: mostRecent };
  }

  /**
   * Informational aggregate across existing billing review surfaces: invoices
   * and payment attempts in `needs_review`, Stripe webhook events in
   * `needs_review`/`failed`, quarantined usage events, auto-subscription
   * intents in `needs_review` (including BILL-020 terminal no-funds), and
   * post-paid Checkout Session cleanup rows stuck in `needs_review`. It does
   * not invent a pager or fail readiness by itself — terminal no-funds review
   * remains countable without forcing a failed worker heartbeat. Readiness
   * failure comes only from heartbeat aggregation (worker tick owns backlog).
   */
  private async countNeedsReview(): Promise<number> {
    const autoIntent = (
      this.prisma as {
        billingAutoSubscriptionIntent?: {
          count: (args: unknown) => Promise<number>;
        };
      }
    ).billingAutoSubscriptionIntent;
    // sessionCleanupStatus is additive (BILL-014); cast until generated client is current.
    const attemptsClient = this.prisma.billingPaymentAttempt as {
      count: (args: unknown) => Promise<number>;
    };
    const [invoices, attempts, webhookEvents, quarantined, autoSubs, sessionCleanup] =
      await Promise.all([
        this.prisma.billingInvoice.count({ where: { status: 'needs_review' } }),
        this.prisma.billingPaymentAttempt.count({ where: { status: 'needs_review' } }),
        this.prisma.stripeWebhookEvent.count({
          where: { status: { in: ['needs_review', 'failed'] } },
        }),
        this.prisma.billingUsageEvent.count({ where: { status: 'quarantined' } }),
        autoIntent ? autoIntent.count({ where: { status: 'needs_review' } }) : Promise.resolve(0),
        attemptsClient.count({
          where: { sessionCleanupStatus: SESSION_CLEANUP_STATUS_NEEDS_REVIEW } as Record<
            string,
            unknown
          >,
        } as unknown),
      ]);
    return invoices + attempts + webhookEvents + quarantined + autoSubs + sessionCleanup;
  }

  private unavailableInProduction(status: string): boolean {
    return status === 'disabled' || status === 'failed' || status === 'stale';
  }

  private isProduction(): boolean {
    return this.config.get<string>('nodeEnv') === 'production';
  }
}

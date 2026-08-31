import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/database/prisma.service';

export type HealthBaseResponse = {
  status: 'ok';
  timestamp: string;
};

/** Non-sensitive billing-worker readiness state (no secrets, no user data). */
export type BillingWorkerHealth = {
  enabled: boolean;
  status: 'enabled' | 'disabled';
};

export type HealthReadyResponse = HealthBaseResponse & {
  checks: {
    database: 'ok';
    billingWorker: BillingWorkerHealth;
  };
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
   * Readiness keeps the existing database probe and adds a non-sensitive
   * billing-worker state. Development/test may run with the worker disabled and
   * still report ready. Production with a disabled worker reports 503 — the
   * startup env validation (`BILLING_WORKER_ENABLED` must be "true" in
   * production) normally intercepts first; this runtime guard is belt-and-
   * braces so a misconfigured instance never sheds traffic onto a deployment
   * without its reconciliation/finalization loop.
   */
  async ready(): Promise<HealthReadyResponse> {
    const timestamp = new Date().toISOString();
    const billingWorker = this.workerHealth();

    if (!(await this.databaseReady())) {
      throw new ServiceUnavailableException({
        status: 'error',
        timestamp,
        checks: { database: 'unavailable', billingWorker },
      });
    }

    if (this.isProduction() && billingWorker.status === 'disabled') {
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

  private workerHealth(): BillingWorkerHealth {
    const enabled = this.config.get<boolean>('billing.worker.enabled') === true;
    return { enabled, status: enabled ? 'enabled' : 'disabled' };
  }

  private isProduction(): boolean {
    return this.config.get<string>('nodeEnv') === 'production';
  }
}

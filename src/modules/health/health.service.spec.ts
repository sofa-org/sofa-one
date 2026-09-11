import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService, BillingWorkerHealth } from './health.service';

describe('HealthService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    billingWorkerHeartbeat: { findMany: jest.fn() },
    billingInvoice: { count: jest.fn() },
    billingPaymentAttempt: { count: jest.fn() },
    stripeWebhookEvent: { count: jest.fn() },
    billingUsageEvent: { count: jest.fn() },
  };
  const config = {
    get: jest.fn(),
  };
  let service: HealthService;

  const row = (overrides: Record<string, unknown> = {}) => ({
    status: 'healthy',
    lastHeartbeatAt: new Date(),
    lastStartedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    ...overrides,
  });
  const staleRow = (overrides: Record<string, unknown> = {}) =>
    row({ lastHeartbeatAt: new Date(Date.now() - 16 * 60 * 1000), ...overrides });

  const workerEnabled = () =>
    config.get.mockImplementation((key: string) => {
      if (key === 'billing.worker.enabled') return true;
      return 'development';
    });
  const workerDisabled = () =>
    config.get.mockImplementation((key: string) => {
      if (key === 'billing.worker.enabled') return false;
      return 'development';
    });
  const productionWorkerEnabled = () =>
    config.get.mockImplementation((key: string) => {
      if (key === 'billing.worker.enabled') return true;
      return 'production';
    });
  const productionWorkerDisabled = () =>
    config.get.mockImplementation((key: string) => {
      if (key === 'billing.worker.enabled') return false;
      return 'production';
    });

  const disabledShape: BillingWorkerHealth = {
    enabled: false,
    status: 'disabled',
    lastHeartbeatAt: null,
    lastStartedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    needsReviewCount: 0,
  };

  function mockCounts(count: number) {
    prisma.billingInvoice.count.mockResolvedValue(count);
    prisma.billingPaymentAttempt.count.mockResolvedValue(count);
    prisma.stripeWebhookEvent.count.mockResolvedValue(count);
    prisma.billingUsageEvent.count.mockResolvedValue(count);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HealthService(prisma as any, config as any);
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([]);
    mockCounts(0);
  });

  it('returns live status without checking dependencies', () => {
    expect(service.live()).toEqual({ status: 'ok', timestamp: expect.any(String) });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns ready status with a disabled worker when the database responds', async () => {
    workerDisabled();

    await expect(service.ready()).resolves.toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      checks: { database: 'ok', billingWorker: disabledShape },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // A disabled worker requires no heartbeat row.
    expect(prisma.billingWorkerHeartbeat.findMany).not.toHaveBeenCalled();
  });

  it('reports a fresh healthy worker as ready and aggregates needsReviewCount', async () => {
    workerEnabled();
    const now = Date.now();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([
      row({
        status: 'healthy',
        lastHeartbeatAt: new Date(now - 60_000),
        lastStartedAt: new Date(now - 5 * 60_000),
        lastSuccessAt: new Date(now - 60_000),
        consecutiveFailures: 0,
      }),
    ]);
    mockCounts(1);

    const response = await service.ready();
    const bw = response.checks.billingWorker;

    expect(bw.status).toBe('healthy');
    expect(bw.enabled).toBe(true);
    expect(bw.lastHeartbeatAt).toEqual(new Date(now - 60_000).toISOString());
    expect(bw.lastStartedAt).toEqual(new Date(now - 5 * 60_000).toISOString());
    expect(bw.lastSuccessAt).toEqual(new Date(now - 60_000).toISOString());
    expect(bw.lastFailureAt).toBeNull();
    expect(bw.consecutiveFailures).toBe(0);
    expect(bw.needsReviewCount).toBe(4);
    // Never exposes worker IDs.
    expect(JSON.stringify(bw)).not.toContain('billing-worker-');
  });

  it('returns service unavailable when the database check fails', async () => {
    workerDisabled();
    prisma.$queryRaw.mockRejectedValue(new Error('database down'));

    await expect(service.ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('reports 503 in production when the billing worker is disabled', async () => {
    productionWorkerDisabled();

    await expect(service.ready()).rejects.toMatchObject({
      response: { status: 'error', checks: { database: 'ok', billingWorker: disabledShape } },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('stays ready in production when the billing worker is enabled and fresh', async () => {
    productionWorkerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'healthy' })]);

    const response = await service.ready();

    expect(response.status).toBe('ok');
    expect(response.checks.billingWorker.status).toBe('healthy');
  });

  it('stays ready in development when the billing worker is disabled', async () => {
    workerDisabled();

    await expect(service.ready()).resolves.toEqual(
      expect.objectContaining({
        status: 'ok',
        checks: expect.objectContaining({ database: 'ok', billingWorker: disabledShape }),
      }),
    );
  });

  it('reports database unavailable before worker status when the DB fails in production', async () => {
    productionWorkerDisabled();
    prisma.$queryRaw.mockRejectedValue(new Error('down'));

    await expect(service.ready()).rejects.toMatchObject({
      response: { checks: { database: 'unavailable' } },
    });
  });

  it('prefers a fresh healthy worker over other fresh statuses across rows', async () => {
    workerEnabled();
    // One fresh running and one fresh healthy: healthy wins.
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([
      row({ status: 'running' }),
      row({ status: 'healthy' }),
    ]);

    const response = await service.ready();
    expect(response.checks.billingWorker.status).toBe('healthy');
  });

  it('falls back to fresh running, then fresh failed, then fresh starting', async () => {
    workerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'running' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('running');

    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'failed' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('failed');

    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'starting' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('starting');
  });

  it('reports stale when no heartbeat row is fresh', async () => {
    workerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([
      staleRow({ status: 'healthy', consecutiveFailures: 3 }),
    ]);

    const response = await service.ready();
    expect(response.checks.billingWorker.status).toBe('stale');
    // The most recent (still stale) row's failure count is surfaced.
    expect(response.checks.billingWorker.consecutiveFailures).toBe(3);
  });

  it('fails closed to stale when the heartbeat table/query is missing', async () => {
    workerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockRejectedValue(new Error('relation does not exist'));

    const response = await service.ready();
    // Missing table/query must never report healthy.
    expect(response.checks.billingWorker.status).toBe('stale');
    expect(response.checks.billingWorker.enabled).toBe(true);
  });

  it('reports 503 in production for failed worker state', async () => {
    productionWorkerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'failed' })]);

    await expect(service.ready()).rejects.toMatchObject({
      response: {
        checks: { database: 'ok', billingWorker: expect.objectContaining({ status: 'failed' }) },
      },
    });
  });

  it('reports 503 in production for stale worker state', async () => {
    productionWorkerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([staleRow({ status: 'healthy' })]);

    await expect(service.ready()).rejects.toMatchObject({
      response: {
        checks: { database: 'ok', billingWorker: expect.objectContaining({ status: 'stale' }) },
      },
    });
  });

  it('allows starting/running in production during startup/active-tick windows', async () => {
    productionWorkerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'running' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('running');

    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'starting' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('starting');
  });

  it('allows failed/stale in development (lenient dev/test allowance)', async () => {
    workerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'failed' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('failed');

    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([staleRow({ status: 'healthy' })]);
    expect((await service.ready()).checks.billingWorker.status).toBe('stale');
  });

  it('aggregates needsReviewCount across invoices, attempts, webhook events, and quarantined usage', async () => {
    workerEnabled();
    prisma.billingWorkerHeartbeat.findMany.mockResolvedValue([row({ status: 'healthy' })]);
    prisma.billingInvoice.count.mockResolvedValue(2);
    prisma.billingPaymentAttempt.count.mockResolvedValue(3);
    prisma.stripeWebhookEvent.count.mockResolvedValue(4);
    prisma.billingUsageEvent.count.mockResolvedValue(5);

    const response = await service.ready();
    expect(response.checks.billingWorker.needsReviewCount).toBe(14);
    expect(prisma.billingInvoice.count).toHaveBeenCalledWith({
      where: { status: 'needs_review' },
    });
    expect(prisma.billingPaymentAttempt.count).toHaveBeenCalledWith({
      where: { status: 'needs_review' },
    });
    expect(prisma.stripeWebhookEvent.count).toHaveBeenCalledWith({
      where: { status: { in: ['needs_review', 'failed'] } },
    });
    expect(prisma.billingUsageEvent.count).toHaveBeenCalledWith({
      where: { status: 'quarantined' },
    });
  });
});

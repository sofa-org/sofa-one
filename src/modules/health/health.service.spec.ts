import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };
  const config = {
    get: jest.fn(),
  };
  let service: HealthService;

  const workerEnabled = () => config.get.mockImplementation((key: string) => {
    if (key === 'billing.worker.enabled') return true;
    return 'development';
  });
  const workerDisabled = () => config.get.mockImplementation((key: string) => {
    if (key === 'billing.worker.enabled') return false;
    return 'development';
  });
  const productionWorkerEnabled = () => config.get.mockImplementation((key: string) => {
    if (key === 'billing.worker.enabled') return true;
    return 'production';
  });
  const productionWorkerDisabled = () => config.get.mockImplementation((key: string) => {
    if (key === 'billing.worker.enabled') return false;
    return 'production';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HealthService(prisma as any, config as any);
  });

  it('returns live status without checking dependencies', () => {
    expect(service.live()).toEqual({ status: 'ok', timestamp: expect.any(String) });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns ready status when the database responds', async () => {
    workerDisabled();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.ready()).resolves.toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      checks: {
        database: 'ok',
        billingWorker: { enabled: false, status: 'disabled' },
      },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reports the worker as enabled when BILLING_WORKER_ENABLED=true', async () => {
    workerEnabled();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const response = await service.ready();

    expect(response.checks.billingWorker).toEqual({ enabled: true, status: 'enabled' });
  });

  it('returns service unavailable when the database check fails', async () => {
    workerDisabled();
    prisma.$queryRaw.mockRejectedValue(new Error('database down'));

    await expect(service.ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('reports 503 in production when the billing worker is disabled', async () => {
    productionWorkerDisabled();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.ready()).rejects.toMatchObject({
      response: {
        status: 'error',
        checks: {
          database: 'ok',
          billingWorker: { enabled: false, status: 'disabled' },
        },
      },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('stays ready in production when the billing worker is enabled', async () => {
    productionWorkerEnabled();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const response = await service.ready();

    expect(response.status).toBe('ok');
    expect(response.checks.billingWorker).toEqual({ enabled: true, status: 'enabled' });
  });

  it('stays ready in development when the billing worker is disabled', async () => {
    workerDisabled();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.ready()).resolves.toEqual(
      expect.objectContaining({
        status: 'ok',
        checks: expect.objectContaining({
          database: 'ok',
          billingWorker: { enabled: false, status: 'disabled' },
        }),
      }),
    );
  });

  it('reports database unavailable before worker status when the DB fails in production', async () => {
    productionWorkerDisabled();
    prisma.$queryRaw.mockRejectedValue(new Error('down'));

    await expect(service.ready()).rejects.toMatchObject({
      response: {
        checks: { database: 'unavailable' },
      },
    });
  });
});
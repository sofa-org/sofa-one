import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };
  let service: HealthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HealthService(prisma as any);
  });

  it('returns live status without checking dependencies', () => {
    expect(service.live()).toEqual({ status: 'ok', timestamp: expect.any(String) });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns ready status when the database responds', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.ready()).resolves.toEqual({
      status: 'ok',
      timestamp: expect.any(String),
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns service unavailable when the database check fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('database down'));

    await expect(service.ready()).rejects.toThrow(ServiceUnavailableException);
  });
});

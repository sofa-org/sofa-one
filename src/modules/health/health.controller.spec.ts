import { HealthController } from './health.controller';

describe('HealthController', () => {
  const healthService = {
    live: jest.fn(),
    ready: jest.fn(),
  };
  let controller: HealthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new HealthController(healthService as any);
  });

  it('delegates live checks to the health service', () => {
    const response = { status: 'ok', timestamp: '2026-04-28T00:00:00.000Z' };
    healthService.live.mockReturnValue(response);

    expect(controller.live()).toBe(response);
  });

  it('delegates readiness checks to the health service', async () => {
    const response = { status: 'ok', timestamp: '2026-04-28T00:00:00.000Z' };
    healthService.ready.mockResolvedValue(response);

    await expect(controller.ready()).resolves.toBe(response);
  });
});

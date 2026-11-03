import type { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ResilientThrottlerStorage } from './resilient-throttler-storage';
import { AppThrottlerModule, RateLimitStorageModule } from './throttler.module';
import { HealthService } from '../../modules/health/health.service';
import { PrismaService } from '../../core/database/prisma.service';

type RedisDouble = EventEmitter & {
  attempts: number;
  available: boolean;
  connect: jest.Mock;
  disconnect: jest.Mock;
  call: jest.Mock;
  loseConnection: () => void;
};
const mockRedisInstances: RedisDouble[] = [];

jest.mock('ioredis', () => {
  const { EventEmitter: Emitter } = jest.requireActual<{ EventEmitter: typeof EventEmitter }>('events');
  class MockRedis extends Emitter {
    attempts = 0;
    available = false;
    private stopped = false;
    private timer: NodeJS.Timeout | undefined;
    call = jest.fn().mockResolvedValue([7, 60000, 0, 0]);
    connect = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn(() => {
      this.stopped = true;
      clearTimeout(this.timer);
      this.emit('close');
    });

    constructor(_url: string, private readonly options: { retryStrategy: (attempt: number) => number | null }) {
      super();
      mockRedisInstances.push(this);
    }

    loseConnection = () => {
      this.emit('close');
      this.retry();
    };

    private retry(): void {
      if (this.stopped) return;
      const delay = this.options.retryStrategy(++this.attempts);
      if (delay === null) return;
      this.timer = setTimeout(() => {
        if (this.available) this.emit('ready');
        else this.retry();
      }, delay);
    }
  }
  return { __esModule: true, default: MockRedis, Cluster: class MockCluster {} };
});

describe('ResilientThrottlerStorage', () => {
  let storage: ResilientThrottlerStorage | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRedisInstances.length = 0;
  });

  afterEach(async () => {
    await storage?.onModuleDestroy();
    storage = undefined;
    jest.useRealTimers();
  });

  it('enforces per-instance limits without Redis and reports the intentional memory mode', async () => {
    storage = new ResilientThrottlerStorage();
    expect(storage.getHealth()).toEqual({ status: 'ok', mode: 'memory', reason: 'not_configured' });
    await storage.increment('key', 60000, 1, 60000, 'short');
    const blocked = await storage.increment('key', 60000, 1, 60000, 'short');
    expect(blocked).toMatchObject({ totalHits: 2, isBlocked: true });
    expect(blocked.timeToBlockExpire).toBeGreaterThan(0);
    expect(await storage.increment('other-key', 60000, 1, 60000, 'short')).toMatchObject({
      totalHits: 1, isBlocked: false,
    });
  });

  it('keeps bounded retries past the former exhaustion point and recovers to distributed limiting', async () => {
    storage = new ResilientThrottlerStorage('redis://user:secret@private-host:6379');
    const client = mockRedisInstances[0];
    client.loseConnection();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(client.attempts).toBeGreaterThan(10);
    expect(client.attempts).toBeLessThan(250); // No hot reconnect loop.
    expect(storage.getHealth()).toEqual({ status: 'degraded', mode: 'memory', reason: 'redis_unavailable' });
    await storage.increment('key', 60000, 1, 60000, 'short');
    expect(await storage.increment('key', 60000, 1, 60000, 'short')).toMatchObject({ isBlocked: true });
    expect(client.call).not.toHaveBeenCalled();

    client.available = true;
    jest.advanceTimersByTime(3000);
    expect(storage.getHealth()).toEqual({ status: 'ok', mode: 'distributed', reason: null });
    expect(await storage.increment('key', 60000, 100, 60000, 'short')).toMatchObject({ totalHits: 7 });
  });

  it('reports command failure as degraded, enforces a local limit, then recovers on command success', async () => {
    storage = new ResilientThrottlerStorage('redis://private-host:6379');
    const client = mockRedisInstances[0];
    client.emit('ready');
    client.call.mockRejectedValue(new Error('redis://user:secret@private-host:6379'));
    await storage.increment('key', 60000, 1, 60000, 'short');
    expect(await storage.increment('key', 60000, 1, 60000, 'short')).toMatchObject({ isBlocked: true });
    expect(storage.getHealth()).toEqual({ status: 'degraded', mode: 'memory', reason: 'redis_unavailable' });
    client.call.mockResolvedValue([7, 60000, 0, 0]);
    await storage.increment('key', 60000, 100, 60000, 'short');
    expect(storage.getHealth()).toEqual({ status: 'ok', mode: 'distributed', reason: null });
  });

  it('cleans up reconnects on actual Nest close and exposes only safe health state', async () => {
    const module = await Test.createTestingModule({
      imports: [AppThrottlerModule, RateLimitStorageModule],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: jest.fn().mockResolvedValue([]) } },
        ConfigService,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => key === 'redis.url' ? 'redis://user:secret@private-host:6379' : undefined })
      .compile();
    await module.init();
    try {
      const lifecycleStorage = module.get(ResilientThrottlerStorage);
      const health = module.get(HealthService);
      const client = mockRedisInstances[0];
      client.loseConnection();
      jest.advanceTimersByTime(60_000);
      const response = await health.ready();
      expect(response).toMatchObject({
        status: 'degraded', checks: { rateLimit: { status: 'degraded', mode: 'memory', reason: 'redis_unavailable' } },
      });
      expect(JSON.stringify(response)).not.toMatch(/secret|private-host|redis:\/\//);
      await module.close();
      const attemptsAtClose = client.attempts;
      jest.advanceTimersByTime(60_000);
      expect(client.attempts).toBe(attemptsAtClose);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
      client.emit('ready');
      expect(lifecycleStorage.getHealth()).toEqual({ status: 'degraded', mode: 'memory', reason: 'shutting_down' });
    } finally {
      await module.close();
    }
  });
});

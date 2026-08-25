const mockRedisInstances: any[] = [];

jest.mock('ioredis', () => {
  const MockCluster = jest.fn();
  const MockRedis = jest.fn().mockImplementation(function (this: any) {
    this.on = jest.fn().mockReturnThis();
    this.connect = jest.fn().mockResolvedValue(undefined);
    this.quit = jest.fn().mockResolvedValue('OK');
    mockRedisInstances.push(this);
  });

  return {
    __esModule: true,
    default: MockRedis,
    Cluster: MockCluster,
  };
});

import { ResilientThrottlerStorage } from './resilient-throttler-storage';

describe('ResilientThrottlerStorage', () => {
  let storage: ResilientThrottlerStorage;

  beforeEach(() => {
    mockRedisInstances.length = 0;
  });

  afterEach(async () => {
    if (storage) {
      await storage.onModuleDestroy();
    }
  });

  describe('without REDIS_URL', () => {
    beforeEach(() => {
      storage = new ResilientThrottlerStorage();
    });

    it('uses in-memory storage when no Redis URL is provided', async () => {
      const result = await storage.increment('test-key', 60000, 100, 60000, 'short');

      expect(result.totalHits).toBe(1);
      expect(result.isBlocked).toBe(false);
    });

    it('increments hits for the same key', async () => {
      await storage.increment('test-key', 60000, 100, 60000, 'short');
      const result = await storage.increment('test-key', 60000, 100, 60000, 'short');

      expect(result.totalHits).toBe(2);
    });

    it('tracks different keys independently', async () => {
      const result1 = await storage.increment('key-a', 60000, 100, 60000, 'short');
      const result2 = await storage.increment('key-b', 60000, 100, 60000, 'short');

      expect(result1.totalHits).toBe(1);
      expect(result2.totalHits).toBe(1);
    });

    it('blocks when limit is exceeded', async () => {
      // Increment up to the limit
      for (let i = 0; i < 3; i++) {
        await storage.increment('test-key', 60000, 3, 60000, 'short');
      }

      // Next increment should be blocked
      const result = await storage.increment('test-key', 60000, 3, 60000, 'short');

      expect(result.totalHits).toBe(4);
      expect(result.isBlocked).toBe(true);
      expect(result.timeToBlockExpire).toBeGreaterThan(0);
    });

    it('returns timeToExpire greater than 0', async () => {
      const result = await storage.increment('test-key', 60000, 100, 60000, 'short');

      expect(result.timeToExpire).toBeGreaterThan(0);
    });
  });

  describe('onModuleDestroy', () => {
    it('does not throw when no Redis client exists', async () => {
      storage = new ResilientThrottlerStorage();
      await expect(storage.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('Redis fallback behavior', () => {
    it('starts the lazy Redis connection when a Redis URL is provided', () => {
      storage = new ResilientThrottlerStorage('redis://localhost:6379');

      expect(mockRedisInstances).toHaveLength(1);
      expect(mockRedisInstances[0].connect).toHaveBeenCalledTimes(1);
    });

    it('falls back to in-memory when Redis increment throws', async () => {
      storage = new ResilientThrottlerStorage();

      // Force useRedis to true with a mock redisStorage that throws
      (storage as any).useRedis = true;
      (storage as any).redisStorage = {
        increment: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
      };

      const result = await storage.increment('test-key', 60000, 100, 60000, 'short');

      expect(result.totalHits).toBe(1);
      expect(result.isBlocked).toBe(false);
    });

    it('uses Redis when available and working', async () => {
      storage = new ResilientThrottlerStorage();

      const mockRedisResult = {
        totalHits: 1,
        timeToExpire: 60000,
        isBlocked: false,
        timeToBlockExpire: 0,
      };

      (storage as any).useRedis = true;
      (storage as any).redisStorage = {
        increment: jest.fn().mockResolvedValue(mockRedisResult),
      };

      const result = await storage.increment('test-key', 60000, 100, 60000, 'short');

      expect(result).toEqual(mockRedisResult);
      expect((storage as any).redisStorage.increment).toHaveBeenCalledWith(
        'test-key',
        60000,
        100,
        60000,
        'short',
      );
    });

    it('falls back to in-memory when useRedis is false', async () => {
      storage = new ResilientThrottlerStorage();

      // useRedis is false by default when no Redis URL is provided
      expect((storage as any).useRedis).toBe(false);

      const result = await storage.increment('test-key', 60000, 100, 60000, 'short');

      expect(result.totalHits).toBe(1);
    });

    it('handles onModuleDestroy gracefully when Redis client quit fails', async () => {
      storage = new ResilientThrottlerStorage();

      // Set up a mock Redis client that throws on quit
      const mockQuit = jest.fn().mockRejectedValue(new Error('Connection already closed'));
      (storage as any).redisClient = { quit: mockQuit };

      await expect(storage.onModuleDestroy()).resolves.toBeUndefined();
      expect(mockQuit).toHaveBeenCalled();
    });
  });
});

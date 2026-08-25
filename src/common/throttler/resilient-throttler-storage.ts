import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import Redis from 'ioredis';

/**
 * Resilient throttler storage that uses Redis when available and falls back
 * to in-memory storage when Redis is unreachable.
 *
 * On startup, attempts to connect to Redis. If the connection fails, it
 * gracefully falls back to in-memory storage and logs a warning.
 *
 * If Redis becomes unavailable at runtime, individual increment calls fall
 * back to in-memory storage so that rate limiting continues to work (albeit
 * non-distributed) rather than failing open.
 */
@Injectable()
export class ResilientThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private redisStorage: import('@nest-lab/throttler-storage-redis').ThrottlerStorageRedisService | null = null;
  private readonly memoryStorage = new ThrottlerStorageService();
  private useRedis = false;
  private redisClient: Redis | null = null;

  constructor(redisUrl?: string) {
    if (redisUrl) {
      this.initRedis(redisUrl);
    } else {
      this.logger.log('No REDIS_URL configured — using in-memory rate limiting (non-distributed)');
    }
  }

  private initRedis(redisUrl: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ThrottlerStorageRedisService } = require('@nest-lab/throttler-storage-redis');

      this.redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
          if (times > 10) {
            this.logger.warn('Redis retry limit reached — falling back to in-memory rate limiting');
            this.useRedis = false;
            return null; // Stop retrying
          }
          return Math.min(times * 100, 3000);
        },
        lazyConnect: true,
      });

      this.redisClient.on('error', (err: Error) => {
        this.logger.warn(`Redis connection error: ${err.message}`);
        this.useRedis = false;
      });

      this.redisClient.on('ready', () => {
        this.logger.log('Redis connected — using distributed rate limiting');
        this.useRedis = true;
      });

      this.redisClient.on('close', () => {
        this.logger.warn('Redis connection closed — falling back to in-memory rate limiting');
        this.useRedis = false;
      });

      this.redisStorage = new ThrottlerStorageRedisService(this.redisClient);
      void this.redisClient.connect().catch((err: Error) => {
        this.logger.warn(
          `Failed to connect Redis throttler storage: ${err.message}. ` +
            'Falling back to in-memory rate limiting.',
        );
        this.useRedis = false;
      });
      // Don't set useRedis = true until the 'ready' event fires
    } catch (err) {
      this.logger.warn(
        `Failed to initialize Redis throttler storage: ${(err as Error).message}. ` +
          'Falling back to in-memory rate limiting.',
      );
      this.useRedis = false;
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    if (this.useRedis && this.redisStorage) {
      try {
        return await this.redisStorage.increment(key, ttl, limit, blockDuration, throttlerName);
      } catch (err) {
        this.logger.warn(
          `Redis increment failed, falling back to in-memory: ${(err as Error).message}`,
        );
        // Fall through to in-memory
      }
    }

    return this.memoryStorage.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  async onModuleDestroy(): Promise<void> {
    this.memoryStorage.onApplicationShutdown();

    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        // Ignore quit errors during shutdown
      }
    }
  }
}

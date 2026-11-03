import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import Redis from 'ioredis';
import type { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

/** Safe public operational state; never includes Redis addresses or error text. */
export type RateLimitHealth = {
  status: 'ok' | 'degraded';
  mode: 'distributed' | 'memory';
  reason: 'not_configured' | 'redis_unavailable' | 'shutting_down' | null;
};

/**
 * Resilient throttler storage that uses Redis when available and falls back
 * to in-memory storage when Redis is unreachable.
 *
 * On startup, attempts to connect to Redis. If the connection fails, it
 * gracefully falls back to in-memory storage and logs a warning.
 *
 * If Redis becomes unavailable, increments fall back to per-instance buckets.
 * This is degraded protection, not globally fail-closed: replicas and storage
 * modes do not share counters.
 */
@Injectable()
export class ResilientThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private redisStorage: ThrottlerStorageRedisService | null = null;
  private readonly memoryStorage = new ThrottlerStorageService();
  private useRedis = false;
  private redisClient: Redis | null = null;
  private readonly redisConfigured: boolean;
  private incrementFailed = false;
  private shuttingDown = false;

  constructor(redisUrl?: string) {
    this.redisConfigured = Boolean(redisUrl);
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
          if (this.shuttingDown) return null;
          // Bound the delay, not the outage duration: Redis may recover hours later.
          return Math.min(Math.max(times, 1) * 100, 3000);
        },
        enableOfflineQueue: false,
        lazyConnect: true,
      });

      this.redisClient.on('error', () => {
        if (!this.shuttingDown) {
          this.logger.warn('Redis connection error — using degraded, per-instance rate limiting');
        }
        this.useRedis = false;
      });

      this.redisClient.on('ready', () => {
        if (this.shuttingDown) return;
        this.logger.log('Redis connected — using distributed rate limiting');
        this.useRedis = true;
        this.incrementFailed = false;
      });

      this.redisClient.on('close', () => {
        if (!this.shuttingDown) {
          this.logger.warn('Redis connection closed — using degraded, per-instance rate limiting');
        }
        this.useRedis = false;
      });

      this.redisStorage = new ThrottlerStorageRedisService(this.redisClient);
      void this.redisClient.connect().catch(() => {
        if (!this.shuttingDown) {
          this.logger.warn('Redis unavailable — using degraded, per-instance rate limiting');
        }
        this.useRedis = false;
      });
      // Don't set useRedis = true until the 'ready' event fires
    } catch {
      this.redisClient?.disconnect();
      this.logger.warn('Redis initialization failed — using degraded, per-instance rate limiting');
      this.useRedis = false;
    }
  }

  getHealth(): RateLimitHealth {
    if (this.shuttingDown) {
      return { status: 'degraded', mode: 'memory', reason: 'shutting_down' };
    }
    if (!this.redisConfigured) {
      return { status: 'ok', mode: 'memory', reason: 'not_configured' };
    }
    if (this.useRedis && !this.incrementFailed) {
      return { status: 'ok', mode: 'distributed', reason: null };
    }
    return { status: 'degraded', mode: 'memory', reason: 'redis_unavailable' };
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    if (!this.shuttingDown && this.useRedis && this.redisStorage) {
      try {
        const result = await this.redisStorage.increment(key, ttl, limit, blockDuration, throttlerName);
        this.incrementFailed = false;
        return result;
      } catch {
        this.incrementFailed = true;
        this.logger.warn('Redis increment failed — using degraded, per-instance rate limiting');
        // Fall through to in-memory
      }
    }

    return this.memoryStorage.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.useRedis = false;
    this.memoryStorage.onApplicationShutdown();
    // QUIT may wait indefinitely behind an unavailable connection. Disconnect
    // cancels pending reconnects immediately and prevents any new retries.
    this.redisClient?.disconnect();
  }
}

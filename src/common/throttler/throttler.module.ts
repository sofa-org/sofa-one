import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ResilientThrottlerStorage } from './resilient-throttler-storage';

/** One lifecycle-owned storage shared by the guard and readiness reporting. */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ResilientThrottlerStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ResilientThrottlerStorage(config.get<string>('redis.url')),
    },
  ],
  exports: [ResilientThrottlerStorage],
})
export class RateLimitStorageModule {}

@Module({
  imports: [
    RateLimitStorageModule,
    ThrottlerModule.forRootAsync({
      imports: [RateLimitStorageModule],
      inject: [ResilientThrottlerStorage],
      useFactory: (storage: ResilientThrottlerStorage) => {
        return {
          throttlers: [
            { name: 'short', ttl: 10000, limit: 20 },
            { name: 'medium', ttl: 60000, limit: 100 },
          ],
          storage,
        };
      },
    }),
  ],
})
export class AppThrottlerModule {}

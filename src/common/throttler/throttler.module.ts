import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ResilientThrottlerStorage } from './resilient-throttler-storage';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('redis.url');
        const storage = new ResilientThrottlerStorage(redisUrl);

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

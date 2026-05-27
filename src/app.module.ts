import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApiKeyThrottlerGuard } from './common/guards/api-key-throttler.guard';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import { PrismaModule } from './core/database/prisma.module';
import { OpenfortModule } from './core/openfort/openfort.module';
import { AuthModule } from './modules/auth/auth.module';
import { ApiKeyModule } from './modules/api-key/api-key.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { HealthModule } from './modules/health/health.module';
import { StepUpModule } from './modules/step-up/step-up.module';
import { SecurityEventModule } from './modules/security-events/security-event.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { RequestContextModule } from './common/request-context/request-context.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 10000, limit: 20 },
      { name: 'medium', ttl: 60000, limit: 100 },
    ]),
    RequestContextModule,
    PrismaModule,
    OpenfortModule,
    AuthModule,
    ApiKeyModule,
    WalletModule,
    TransactionsModule,
    HealthModule,
    StepUpModule,
    SecurityEventModule,
  ],
  providers: [
    RequestIdMiddleware,
    {
      provide: APP_GUARD,
      useClass: ApiKeyThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

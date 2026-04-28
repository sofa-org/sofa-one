import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import { PrismaModule } from './core/database/prisma.module';
import { OpenfortModule } from './core/openfort/openfort.module';
import { AuthModule } from './modules/auth/auth.module';
import { ApiKeyModule } from './modules/api-key/api-key.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PolicyModule } from './modules/policy/policy.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { HealthModule } from './modules/health/health.module';

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
    PrismaModule,
    OpenfortModule,
    AuthModule,
    ApiKeyModule,
    WalletModule,
    PolicyModule,
    TransactionsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

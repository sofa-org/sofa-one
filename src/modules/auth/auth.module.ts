import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyModule } from '../api-key/api-key.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { StepUpModule } from '../step-up/step-up.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [ApiKeyModule, SecurityEventModule, StepUpModule, BillingModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

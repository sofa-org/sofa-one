import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecurityEventModule } from '../security-events/security-event.module';
import { StepUpModule } from '../step-up/step-up.module';
import { BillingModule } from '../billing/billing.module';
import { AppSessionModule } from '../app-session/app-session.module';

@Module({
  imports: [AppSessionModule, SecurityEventModule, StepUpModule, BillingModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

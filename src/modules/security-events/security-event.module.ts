import { Module } from '@nestjs/common';
import { RequestContextModule } from '../../common/request-context/request-context.module';
import { SecurityNotificationModule } from '../security-notifications/security-notification.module';
import { SecurityEventService } from './security-event.service';
import { SecurityRiskService } from './security-risk.service';

@Module({
  imports: [RequestContextModule, SecurityNotificationModule],
  providers: [SecurityEventService, SecurityRiskService],
  exports: [SecurityEventService, SecurityRiskService],
})
export class SecurityEventModule {}

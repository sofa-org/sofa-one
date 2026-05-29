import { Module } from '@nestjs/common';
import { RequestContextModule } from '../../common/request-context/request-context.module';
import { SecurityNotificationModule } from '../security-notifications/security-notification.module';
import { SecurityEventExportService } from './security-event-export.service';
import { SecurityEventService } from './security-event.service';
import { SecurityRiskService } from './security-risk.service';

@Module({
  imports: [RequestContextModule, SecurityNotificationModule],
  providers: [SecurityEventService, SecurityRiskService, SecurityEventExportService],
  exports: [SecurityEventService, SecurityRiskService, SecurityEventExportService],
})
export class SecurityEventModule {}

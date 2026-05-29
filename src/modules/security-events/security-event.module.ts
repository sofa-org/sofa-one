import { Module } from '@nestjs/common';
import { RequestContextModule } from '../../common/request-context/request-context.module';
import { IpAllowlistService } from '../../common/guards/ip-allowlist.service';
import { SecurityNotificationModule } from '../security-notifications/security-notification.module';
import { SecurityEventExportService } from './security-event-export.service';
import { SecurityEventService } from './security-event.service';
import { SecurityRiskService } from './security-risk.service';

@Module({
  imports: [RequestContextModule, SecurityNotificationModule],
  providers: [SecurityEventService, SecurityRiskService, SecurityEventExportService, IpAllowlistService],
  exports: [SecurityEventService, SecurityRiskService, SecurityEventExportService, IpAllowlistService],
})
export class SecurityEventModule {}

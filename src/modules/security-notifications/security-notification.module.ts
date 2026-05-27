import { Module } from '@nestjs/common';
import { SecurityNotificationController } from './security-notification.controller';
import { SecurityNotificationService } from './security-notification.service';

@Module({
  controllers: [SecurityNotificationController],
  providers: [SecurityNotificationService],
  exports: [SecurityNotificationService],
})
export class SecurityNotificationModule {}

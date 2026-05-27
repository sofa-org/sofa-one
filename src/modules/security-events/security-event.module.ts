import { Module } from '@nestjs/common';
import { RequestContextModule } from '../../common/request-context/request-context.module';
import { SecurityEventService } from './security-event.service';

@Module({
  imports: [RequestContextModule],
  providers: [SecurityEventService],
  exports: [SecurityEventService],
})
export class SecurityEventModule {}

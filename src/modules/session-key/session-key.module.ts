import { Module } from '@nestjs/common';
import { SecurityEventModule } from '../security-events/security-event.module';
import { SessionKeyPolicyService } from './session-key-policy.service';

@Module({
  imports: [SecurityEventModule],
  providers: [SessionKeyPolicyService],
  exports: [SessionKeyPolicyService],
})
export class SessionKeyModule {}
import { Module } from '@nestjs/common';
import { SecurityEventModule } from '../security-events/security-event.module';
import { EoaExecutionPolicyService } from './eoa-execution-policy.service';

@Module({
  imports: [SecurityEventModule],
  providers: [EoaExecutionPolicyService],
  exports: [EoaExecutionPolicyService],
})
export class EoaExecutionModule {}

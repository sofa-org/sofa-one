import { Module } from '@nestjs/common';
import { StepUpService } from './step-up.service';

@Module({
  providers: [StepUpService],
  exports: [StepUpService],
})
export class StepUpModule {}

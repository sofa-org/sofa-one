import { Module } from '@nestjs/common';
import { StepUpController } from './step-up.controller';
import { StepUpService } from './step-up.service';

@Module({
  controllers: [StepUpController],
  providers: [StepUpService],
  exports: [StepUpService],
})
export class StepUpModule {}
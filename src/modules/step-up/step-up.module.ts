import { Module } from '@nestjs/common';
import { StepUpService } from './step-up.service';
import { AppSessionModule } from '../app-session/app-session.module';

@Module({
  imports: [AppSessionModule],
  providers: [StepUpService],
  exports: [StepUpService],
})
export class StepUpModule {}

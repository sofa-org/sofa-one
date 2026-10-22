import { Module } from '@nestjs/common';
import { StepUpModule } from '../step-up/step-up.module';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { AppSessionModule } from '../app-session/app-session.module';

@Module({
  imports: [AppSessionModule, StepUpModule],
  controllers: [MfaController],
  providers: [MfaService],
})
export class MfaModule {}

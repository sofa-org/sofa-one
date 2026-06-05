import { Module } from '@nestjs/common';
import { StepUpModule } from '../step-up/step-up.module';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

@Module({
  imports: [StepUpModule],
  controllers: [MfaController],
  providers: [MfaService],
})
export class MfaModule {}

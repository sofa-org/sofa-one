import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { StepUpModule } from '../step-up/step-up.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { DefiModule } from '../defi';
import { DefiCapabilityController } from './api-key.controller';

@Module({
  imports: [StepUpModule, SecurityEventModule, DefiModule],
  controllers: [ApiKeyController, DefiCapabilityController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}

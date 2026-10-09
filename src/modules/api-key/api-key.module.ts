import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { StepUpModule } from '../step-up/step-up.module';
import { SecurityEventModule } from '../security-events/security-event.module';
import { DefiModule } from '../defi/defi.module';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { IpAllowlistService } from '../../common/guards/ip-allowlist.service';
import { ApiKeyPermissionsController } from './api-key-permissions.controller';
import { BillingModule } from '../billing/billing.module';
import { DefiCapabilityController } from './api-key.controller';
import { DefiCapabilityBundleController } from './api-key.controller';

@Module({
  imports: [StepUpModule, SecurityEventModule, DefiModule, BillingModule],
  controllers: [ApiKeyController, DefiCapabilityController, DefiCapabilityBundleController, ApiKeyPermissionsController],
  providers: [ApiKeyService, ApiKeyAuthGuard, IpAllowlistService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}

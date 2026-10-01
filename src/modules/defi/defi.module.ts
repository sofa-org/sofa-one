import { Module } from '@nestjs/common';
import { SecurityEventModule } from '../security-events/security-event.module';
import { DEFI_CATALOG, DefiCatalogService, REVIEWED_CATALOG } from './defi-catalog.service';
import { DefiGrantService } from './defi-grant.service';
import { DefiPauseService } from './defi-pause.service';
import { DefiPolicyService } from './defi-policy.service';

@Module({ imports: [SecurityEventModule], providers: [{ provide: DEFI_CATALOG, useValue: REVIEWED_CATALOG }, DefiCatalogService, DefiGrantService, DefiPauseService, DefiPolicyService], exports: [DefiCatalogService, DefiGrantService, DefiPauseService, DefiPolicyService] })
export class DefiModule {}

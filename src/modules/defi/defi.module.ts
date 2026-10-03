import { Module } from '@nestjs/common';
import { SecurityEventModule } from '../security-events/security-event.module';
import { DEFI_CATALOG, DefiCatalogService } from './defi-catalog.service';
import { DEFI_MANIFEST } from './registry/defi-manifest';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './registry/production-registry';
import { DefiGrantService } from './defi-grant.service';
import { DefiPauseService } from './defi-pause.service';
import { DefiPolicyService } from './defi-policy.service';

@Module({ imports: [SecurityEventModule], providers: [{ provide: DEFI_MANIFEST, useValue: PRODUCTION_DEFI_MANIFEST }, { provide: DEFI_CATALOG, useValue: PRODUCTION_DEFI_CATALOG }, DefiCatalogService, DefiGrantService, DefiPauseService, DefiPolicyService], exports: [DefiCatalogService, DefiGrantService, DefiPauseService, DefiPolicyService] })
export class DefiModule {}

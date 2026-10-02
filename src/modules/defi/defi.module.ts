import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SecurityEventModule } from '../security-events/security-event.module';
import { DEFI_CATALOG, DefiCatalogService } from './defi-catalog.service';
import { DefiEvidenceService } from './evidence/defi-evidence.service';
import { DEFI_MANIFEST } from './registry/defi-manifest';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './registry/production-registry';
import { DefiGrantService } from './defi-grant.service';
import { DefiPauseService } from './defi-pause.service';
import { DefiPolicyService } from './defi-policy.service';

@Module({ imports: [ConfigModule, SecurityEventModule], providers: [{ provide: DEFI_MANIFEST, useValue: PRODUCTION_DEFI_MANIFEST }, { provide: DEFI_CATALOG, useValue: PRODUCTION_DEFI_CATALOG }, DefiCatalogService, DefiEvidenceService, DefiGrantService, DefiPauseService, DefiPolicyService], exports: [DefiCatalogService, DefiEvidenceService, DefiGrantService, DefiPauseService, DefiPolicyService] })
export class DefiModule {}

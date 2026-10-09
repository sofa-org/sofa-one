import { Module } from '@nestjs/common';
import { SecurityEventModule } from '../security-events/security-event.module';
import { DEFI_CATALOG, DefiCatalogService } from './defi-catalog.service';
import { DEFI_MANIFEST } from './registry/defi-manifest';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './registry/production-registry';
import { DefiGrantService } from './defi-grant.service';
import { DefiPauseService } from './defi-pause.service';
import { DefiPolicyService } from './defi-policy.service';
import { DefiBundleService } from './bundles/bundle.service';
import { DEFI_CAPABILITY_BUNDLES, PRODUCTION_DEFI_CAPABILITY_BUNDLES } from './bundles/production-bundles';
import { DefiCapabilityQueryController } from './defi-capability-query.controller';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { IpAllowlistService } from '../../common/guards/ip-allowlist.service';
import { BillingModule } from '../billing/billing.module';

@Module({ imports: [SecurityEventModule, BillingModule], controllers: [DefiCapabilityQueryController], providers: [{ provide: DEFI_MANIFEST, useValue: PRODUCTION_DEFI_MANIFEST }, { provide: DEFI_CATALOG, useValue: PRODUCTION_DEFI_CATALOG }, { provide: DEFI_CAPABILITY_BUNDLES, useValue: PRODUCTION_DEFI_CAPABILITY_BUNDLES }, ApiKeyAuthGuard, IpAllowlistService, DefiCatalogService, DefiGrantService, DefiPauseService, DefiPolicyService, DefiBundleService], exports: [DefiCatalogService, DefiGrantService, DefiPauseService, DefiPolicyService, DefiBundleService] })
export class DefiModule {}

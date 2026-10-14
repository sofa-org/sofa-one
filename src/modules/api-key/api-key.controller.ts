import { Controller, Post, Delete, Get, Body, Param, UseGuards, ParseUUIDPipe, Patch } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyService } from './api-key.service';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { RequireStepUp } from '../../common/decorators/step-up.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateApiKeyDto, PatchApiKeyCapabilitiesDto } from './dto/create-api-key.dto';
import { DefiCatalogService } from '../defi/defi-catalog.service';
import { DefiBundleService } from '../defi/bundles/bundle.service';
import { RotateApiKeyDto } from './dto/rotate-api-key.dto';

@Controller('api-keys')
@FrontendOnly()
@UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /** POST /api-keys — create a new API key (returns raw key once). Requires step-up. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.createApiKey(userId, {
      walletId: dto.walletId,
      name: dto.name,
      expiresAt: dto.expiresAt,
      allowedIps: dto.allowedIps,
      allowedCapabilityIds: dto.allowedCapabilityIds,
      capabilityMode: dto.capabilityMode,
      spendLimits: dto.spendLimits,
      permissions: dto.permissions,
    });
  }

  /** Replaces every active API key for the user; walletId selects the replacement binding only. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 3 }, medium: { ttl: 3600000, limit: 10 } })
  @Post('rotations')
  async rotate(@CurrentUser('id') userId: string, @Body() dto: RotateApiKeyDto) {
    const result = await this.apiKeyService.rotateApiKey(userId, 'Refreshed', dto.walletId);
    return { apiKey: result.rawKey };
  }

  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Patch(':id/capabilities')
  async replaceCapabilities(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) keyId: string, @Body() dto: PatchApiKeyCapabilitiesDto) {
    return this.apiKeyService.replaceCapabilities(keyId, userId, dto);
  }

  /** GET /api-keys — list all keys (metadata only). */
  @Get()
  async list(@CurrentUser('id') userId: string) {
    return this.apiKeyService.listApiKeys(userId);
  }

  /** DELETE /api-keys — revoke every active key without creating a replacement. Requires step-up. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 3 }, medium: { ttl: 3600000, limit: 10 } })
  @Delete()
  async revokeAll(@CurrentUser('id') userId: string) {
    const result = await this.apiKeyService.revokeAllKeys(userId);
    return { success: true, revokedCount: result.count };
  }

  /**
   * POST /api-keys/:id/authorize-direct-egress — acknowledge destination-policy
   * binding for API-key direct asset egress (BILL-016). Requires step-up.
   * Dashboard-only; omitted from public openapi.yaml.
   */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post(':id/authorize-direct-egress')
  async authorizeDirectEgress(@CurrentUser('id') userId: string, @Param('id') keyId: string) {
    return this.apiKeyService.authorizeDirectEgress(keyId, userId);
  }

  /** DELETE /api-keys/:id — revoke a specific key. Requires step-up. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Delete(':id')
  async revoke(@CurrentUser('id') userId: string, @Param('id') keyId: string) {
    await this.apiKeyService.revokeApiKey(keyId, userId);
    return { success: true };
  }
}

@Controller('defi-capabilities')
@FrontendOnly()
@UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
export class DefiCapabilityController {
  constructor(private readonly defiCatalog: DefiCatalogService) {}
  @Get()
  async list() { return await this.defiCatalog.listMetadata(); }
}

/** Dashboard-only read of reviewed, immutable capability bundle metadata. */
@Controller('defi-capability-bundles')
@FrontendOnly()
@UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
export class DefiCapabilityBundleController {
  constructor(private readonly bundles: DefiBundleService) {}

  @Get()
  async list() { return await this.bundles.listMetadata(); }
}

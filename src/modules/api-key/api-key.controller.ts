import { Controller, Post, Delete, Get, Body, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyService } from './api-key.service';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { RequireStepUp } from '../../common/decorators/step-up.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Controller('v1/api-keys')
@FrontendOnly()
@UseGuards(OpenfortUserGuard, FrontendOnlyGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /** POST /v1/api-keys — create a new API key (returns raw key once). Requires step-up. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.createApiKey(userId, {
      name: dto.name,
      expiresAt: dto.expiresAt,
      allowedIps: dto.allowedIps,
      permissions: dto.permissions,
    });
  }

  /** GET /v1/api-keys — list all keys (metadata only). */
  @Get()
  async list(@CurrentUser('id') userId: string) {
    return this.apiKeyService.listApiKeys(userId);
  }

  /** DELETE /v1/api-keys — revoke every active key without creating a replacement. Requires step-up. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Throttle({ short: { ttl: 60000, limit: 3 }, medium: { ttl: 3600000, limit: 10 } })
  @Delete()
  async revokeAll(@CurrentUser('id') userId: string) {
    const result = await this.apiKeyService.revokeAllKeys(userId);
    return { success: true, revokedCount: result.count };
  }

  /** DELETE /v1/api-keys/:id — revoke a specific key. Requires step-up. */
  @RequireStepUp()
  @UseGuards(StepUpGuard)
  @Delete(':id')
  async revoke(@CurrentUser('id') userId: string, @Param('id') keyId: string) {
    await this.apiKeyService.revokeApiKey(keyId, userId);
    return { success: true };
  }
}
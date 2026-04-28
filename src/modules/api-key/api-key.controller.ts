import { Controller, Post, Delete, Get, Body, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyService } from './api-key.service';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { ClerkUserGuard } from '../../common/guards/clerk-user.guard';
import { FrontendOnly } from '../../common/decorators/frontend-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Controller('v1/api-keys')
@FrontendOnly()
@UseGuards(ClerkUserGuard, FrontendOnlyGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /** POST /v1/api-keys — create a new API key (returns raw key once). */
  @Throttle({ short: { ttl: 60000, limit: 5 }, medium: { ttl: 3600000, limit: 20 } })
  @Post()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.createApiKey(userId, {
      name: dto.name,
      allowedChains: dto.allowedChains,
      expiresAt: dto.expiresAt,
      allowedIps: dto.allowedIps,
    });
  }

  /** GET /v1/api-keys — list all keys (metadata only). */
  @Get()
  async list(@CurrentUser('id') userId: string) {
    return this.apiKeyService.listApiKeys(userId);
  }

  /** DELETE /v1/api-keys/:id — revoke a specific key. */
  @Delete(':id')
  async revoke(@CurrentUser('id') userId: string, @Param('id') keyId: string) {
    await this.apiKeyService.revokeApiKey(keyId, userId);
    return { success: true };
  }
}

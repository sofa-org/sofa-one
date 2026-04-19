import { Controller, Post, Delete, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Controller('v1/api-keys')
@UseGuards(ApiKeyGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /** POST /v1/api-keys — create a new API key (returns raw key once). */
  @Post()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.createApiKey(userId, dto.name);
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

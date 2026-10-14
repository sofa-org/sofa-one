import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { DefiCatalogService } from './defi-catalog.service';
import { parseCapabilityIds } from './capability-query';

@Controller('v1/capabilities')
@UseGuards(ApiKeyAuthGuard)
export class DefiCapabilityQueryController {
  constructor(private readonly catalog: DefiCatalogService) {}

  @Get()
  async getCapabilities(@Query('ids') ids: unknown, @Res({ passthrough: true }) response: any) {
    response.setHeader('Cache-Control', 'no-store');
    if (Array.isArray(ids)) throw new BadRequestException('ids must be provided once');
    return this.catalog.listMetadataByIds(parseCapabilityIds(ids));
  }
}

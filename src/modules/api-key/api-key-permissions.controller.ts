import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';

@Controller('v1/permissions')
@UseGuards(ApiKeyAuthGuard)
export class ApiKeyPermissionsController {
  @Get()
  getPermissions(@Req() req: any, @Res({ passthrough: true }) response: any) {
    response.setHeader('Cache-Control', 'no-store');
    const key = req.apiKeyRecord ?? {};
    return {
      snapshotAt: new Date().toISOString(),
      evaluation: 'configured',
      permissions: {
        canSign: key.canSign ?? false,
        canSendTransaction: key.canSendTransaction ?? false,
        canReadTransactionStatus: key.canReadTransactionStatus ?? true,
        canUseEoaExecution: key.canUseEoaExecution ?? false,
      },
      capabilities: {
        mode: key.capabilityMode ?? 'all',
        allowedIds: key.allowedCapabilityIds ?? [],
      },
      constraints: {
        expiresAt: key.expiresAt ? new Date(key.expiresAt).toISOString() : null,
        allowedIps: key.allowedIps ?? [],
        spendLimits: { daily: key.dailySpendLimit ?? null, monthly: key.monthlySpendLimit ?? null },
      },
    };
  }
}

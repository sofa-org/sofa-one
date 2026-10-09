import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { PrismaModule } from '../../core/database/prisma.module';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortModule } from '../../core/openfort/openfort.module';
import { DefiModule } from './defi.module';
import { BillingReconciliationService } from '../billing/billing-reconciliation.service';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

describe('DefiModule public capability route wiring', () => {
  it('resolves the production ApiKeyAuthGuard and its dependencies without importing ApiKeyModule', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        OpenfortModule,
        DefiModule,
      ],
    })
      .overrideProvider(BillingReconciliationService)
      .useValue({})
      .overrideProvider(PrismaService)
      .useValue({
        defiPolicyState: {
          findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }),
        },
      })
      .compile();

    expect(module.get(ApiKeyAuthGuard)).toBeInstanceOf(ApiKeyAuthGuard);
    await module.close();
  });
});

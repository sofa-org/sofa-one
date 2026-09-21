import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../core/database/prisma.module';
import { StepUpModule } from '../step-up/step-up.module';
import { StepUpService } from '../step-up/step-up.service';
import { StepUpGuard } from '../../common/guards/step-up.guard';

/**
 * B9: real StepUpGuard on pay-from-wallet requires StepUpService from StepUpModule.
 * BillingModule must import StepUpModule (StepUp is not @Global — AppModule import
 * alone does not inject into BillingModule controllers). PrismaModule is @Global
 * in production (AppModule); tests mirror that.
 *
 * Avoid importing BillingModule itself here: it pulls Openfort ESM into Jest.
 * Source + isolated StepUp DI graph are the evidence.
 */
describe('BillingModule Phase 2B DI (B9)', () => {
  const moduleSrc = readFileSync(join(__dirname, 'billing.module.ts'), 'utf8');
  const controllerSrc = readFileSync(
    join(__dirname, 'onchain/usdc-wallet-payment.controller.ts'),
    'utf8',
  );

  it('BillingModule source imports StepUpModule', () => {
    expect(moduleSrc).toMatch(/from ['"]\.\.\/step-up\/step-up\.module['"]/);
    expect(moduleSrc).toMatch(/StepUpModule/);
    expect(moduleSrc).toMatch(/imports:\s*\[[\s\S]*StepUpModule/);
  });

  it('pay-from-wallet controller uses real StepUpGuard + RequireStepUp', () => {
    expect(controllerSrc).toMatch(/StepUpGuard/);
    expect(controllerSrc).toMatch(/@RequireStepUp\(\)/);
    expect(controllerSrc).toMatch(/@UseGuards\([^)]*StepUpGuard/);
  });

  it('can construct StepUpGuard when StepUpModule is imported (same wiring Billing needs)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, StepUpModule],
      providers: [StepUpGuard],
    })
      .overrideProvider(
        // Avoid real DB connect in unit evidence.
        (await import('../../core/database/prisma.service')).PrismaService,
      )
      .useValue({
        stepUpChallenge: { findFirst: jest.fn() },
      })
      .compile();

    const guard = moduleRef.get(StepUpGuard);
    const stepUp = moduleRef.get(StepUpService);
    expect(guard).toBeInstanceOf(StepUpGuard);
    expect(stepUp).toBeInstanceOf(StepUpService);
    await moduleRef.close();
  });
});

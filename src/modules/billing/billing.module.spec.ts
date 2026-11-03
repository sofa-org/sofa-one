import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../core/database/prisma.module';
import { StepUpModule } from '../step-up/step-up.module';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { ExecutionContext } from '@nestjs/common';
import { STEP_UP_KEY } from '../../common/decorators/step-up.decorator';

// Mirror AppModule's global configuration and database infrastructure without
// loading billing's external payment/signing integrations.
describe('Billing step-up authorization', () => {
  it('rejects an invalid proof through the imported StepUpModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        StepUpModule,
      ],
      providers: [StepUpGuard],
    })
      .overrideProvider(
        // Avoid real DB connect in unit evidence.
        (await import('../../core/database/prisma.service')).PrismaService,
      )
      .useValue({
        stepUpChallenge: { findFirst: jest.fn().mockResolvedValue(null) },
      })
      .compile();

    const guard = moduleRef.get(StepUpGuard);
    const handler = () => undefined;
    Reflect.defineMetadata(STEP_UP_KEY, true, handler);
    const context = {
      getHandler: () => handler,
      getClass: () => class PaymentController {},
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-step-up-token': 'invalid-proof' },
          user: { id: 'user-1' },
          appSession: { id: 'session-1' },
        }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Invalid or expired step-up verification',
    );
    await moduleRef.close();
  });
});

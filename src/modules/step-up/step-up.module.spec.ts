import { MODULE_METADATA } from '@nestjs/common/constants';
import { StepUpModule } from './step-up.module';
import { StepUpService } from './step-up.service';

describe('StepUpModule', () => {
  it('exports StepUpService without registering a controller', () => {
    const metadata = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StepUpModule) ?? [];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StepUpModule) ?? [];
    const exportsMetadata = Reflect.getMetadata(MODULE_METADATA.EXPORTS, StepUpModule) ?? [];

    expect(metadata).toEqual([]);
    expect(providers).toContain(StepUpService);
    expect(exportsMetadata).toContain(StepUpService);
  });
});

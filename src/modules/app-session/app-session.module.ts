import { Global, Module } from '@nestjs/common';
import { AppSessionService } from './app-session.service';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';

@Global()
@Module({
  providers: [AppSessionService, FrontendOnlyGuard],
  exports: [AppSessionService, FrontendOnlyGuard],
})
export class AppSessionModule {}

import { Global, Module } from '@nestjs/common';
import { OpenfortService } from './openfort.service';

@Global()
@Module({
  providers: [OpenfortService],
  exports: [OpenfortService],
})
export class OpenfortModule {}

import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyModule } from '../api-key/api-key.module';
import { SecurityEventModule } from '../security-events/security-event.module';

@Module({
  imports: [ApiKeyModule, SecurityEventModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

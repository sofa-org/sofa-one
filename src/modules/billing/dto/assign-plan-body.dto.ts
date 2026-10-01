import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Self-service plan-change body. Only `planCode` is accepted; the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects any other field
 * (effectiveFrom, amount, userId, admin, etc. are forbidden). Upgrade vs
 * downgrade timing and charge amounts are always server-derived.
 */
export class AssignPlanBodyDto {
  @IsString()
  @IsNotEmpty()
  planCode: string;
}

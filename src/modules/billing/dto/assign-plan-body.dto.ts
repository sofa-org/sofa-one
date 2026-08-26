import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Self-service plan-change body. Only `planCode` is accepted; the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects any other field.
 * The effective period is always the next UTC month — never client-supplied.
 */
export class AssignPlanBodyDto {
  @IsString()
  @IsNotEmpty()
  planCode: string;
}
